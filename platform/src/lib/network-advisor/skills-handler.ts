// AgentCore 技能 Lambda handler —— 网络连通性顾问的【确定性工具后端】。
// 挂 bgp-netadvisor-gateway 的 GatewayTarget；Runtime 容器(agent.js)经 MCP 调这些工具。
// 平台标准见 docs/design/28-agentcore-standard/DESIGN.md。
//
// ── 工具无状态化(标准 §7①) ──
// Lambda 无状态,不能像进程内 advisor-agent.ts 那样让 4 个工具共享 AgentState.facts。
// 故用【粗粒度合并工具】:
//   • analyze_connectivity —— 一条龙 probe→judge→remediate,完整 facts 只活在本次调用内,
//     只把结论 + facts 摘要回给模型(完整 SG 规则不回)。
//   • inspect_security_group —— 模型想深挖某 SG 完整规则时单独调。
// req(PlacedConnectivityRequest 核心字段)是【无状态请求上下文】(非探测状态),由 Runtime 容器每次
// 注入 event.request;facts 靠 cache.ts warm 实例缓存复用,跨实例不命中则幂等重探(可接受)。
//
// ── 只读(标准红线 network-advisor-readonly-only) ──
// 全部工具只做只读探测/裁决,绝不写网络。所需 AWS 权限见 infra/lib/netadvisor-iam.ts。
//
// ── esbuild 单源(标准打包策略) ──
// 本 handler 与它 import 的 8 个确定性模块同在 platform/src/lib/network-advisor/,是与进程内
// 实现【同一份源码】(零漂移)。Phase 2 的 CDK NodejsFunction entry 指向本文件,esbuild 打包。

import { probeEnvironment } from "./environment-probe";
import { adjudicate } from "./connectivity-judge";
import { buildRemediations } from "./remediation";
import { selectCandidatePlacements } from "./placement";
import type {
  PlacedConnectivityRequest,
  EnvironmentFacts,
  RecommendedPlacement,
  Ruling,
  Verdict,
} from "./types";

// ───────────────────────── Gateway 工具名解析(标准契约) ─────────────────────────
// Gateway 把工具名编码为 "<target>___<tool>" 放 clientContext.Custom.bedrockAgentCoreToolName
//(同 genbi-skills/index.js:60-66,DESIGN.md §3 固定契约 3)。
interface LambdaContext {
  clientContext?: { Custom?: Record<string, unknown>; custom?: Record<string, unknown> };
}
export function toolNameOf(context: LambdaContext | undefined): string {
  const custom = (context?.clientContext?.Custom || context?.clientContext?.custom || {}) as Record<string, unknown>;
  const raw = String(custom.bedrockAgentCoreToolName || "");
  const parts = raw.split("___");
  return parts[parts.length - 1] || raw;
}

// ───────────────────────── facts 摘要(只回模型决策所需) ─────────────────────────
// 对齐 advisor-agent.ts:186 的 summarizeFacts:SG 只给 groupId/name/ingressCount(完整规则仅
// inspect_security_group 给)。合并工具后,摘要逻辑从 Runtime 下沉到 Lambda(减少跨跳传输)。
function summarizeFacts(facts: EnvironmentFacts) {
  return {
    region: facts.region,
    degraded: facts.degraded,
    missing: facts.missing,
    vpcs: facts.vpcs.map((v) => ({
      vpcId: v.vpcId, cidr: v.cidr, isDefault: v.isDefault, name: v.name,
      dnsSupport: v.dnsSupport, dnsHostnames: v.dnsHostnames, natGatewayAzs: v.natGatewayAzs,
      subnets: v.subnets.map((s) => ({ subnetId: s.subnetId, az: s.az, cidr: s.cidr, isPublic: s.isPublic, routesToNat: s.routesToNat, freeIps: s.freeIps })),
      securityGroups: v.securityGroups.map((s) => ({ groupId: s.groupId, name: s.name, ingressCount: s.ingress.length, egressCount: s.egress.length })),
      endpoints: v.endpoints.map((e) => ({ id: e.id, service: e.service, type: e.type })),
      peerings: v.peerings, tgwAttachments: v.tgwAttachments,
    })),
    targets: facts.targets.map((t) => ({ kind: t.target.kind, vpcId: t.vpcId, cidr: t.cidr, port: t.port, azs: t.azs, securityGroupIds: t.securityGroupIds, endpointModel: t.endpointModel, discoverable: t.discoverable, notes: t.notes })),
  };
}

// ───────────────────────── 事件契约 ─────────────────────────
interface PlacementInput {
  vpcId?: string;
  subnetIds?: string[];
  securityGroupIds?: string[];
  availabilityZones?: string[];
}
interface SkillEvent {
  request?: PlacedConnectivityRequest; // Runtime 每次注入的请求上下文(必需)
  placement?: PlacementInput;    // analyze_connectivity:模型指定的候选(缺省用确定性 top1)
  groupId?: string;              // inspect_security_group:要深挖的 SG
}

// ───────────────────────── 主工具:一条龙确定性分析 ─────────────────────────
// = 进程内 index.ts advise() 的 L1+L2 部分(去掉 L3 —— 本工具正是被 L3 调用的)。
// 底层 probeEnvironment/adjudicate/buildRemediations/selectCandidatePlacements 与 advise() 同源,
// 真正的裁决逻辑零漂移;此处仅复用同一套编排骨架。
async function analyzeConnectivity(req: PlacedConnectivityRequest, inputPlacement?: PlacementInput) {
  const facts = await probeEnvironment(req); // 完整 facts 只活在本次调用内

  // 空环境/探测彻底失败 → needs-input(同 index.ts:46)。
  if (facts.vpcs.length === 0) {
    return {
      success: true,
      verdict: "needs-input" as Verdict,
      rulings: [] as Ruling[],
      remediations: [],
      candidates: [],
      chosenPlacement: null,
      questions: ["未发现可用 VPC：请确认 region/账号，或手动指定目标所在的 VPC/子网/安全组。"],
      facts: summarizeFacts(facts),
    };
  }

  // 确定性候选(同时作为模型选择的校验/兜底)。
  const candidates = selectCandidatePlacements(facts, req);

  // 选定 placement:优先模型给的(若带 vpcId),否则确定性 top1。
  const chosen: RecommendedPlacement | undefined =
    inputPlacement?.vpcId
      ? {
          vpcId: inputPlacement.vpcId,
          subnetIds: inputPlacement.subnetIds || [],
          securityGroupIds: inputPlacement.securityGroupIds || [],
          availabilityZones: inputPlacement.availabilityZones || [],
          rationale: "模型指定的候选放置",
        }
      : candidates[0]?.placement;

  // 用 L2 对最终 placement 权威裁决(不信任模型自报的裁决,同 index.ts:66)。
  let rulings: Ruling[] = [];
  let verdict: Verdict = "unknown";
  if (chosen) {
    const res = adjudicate({ facts, computeKind: req.computeKind, placement: chosen, constraints: req.constraints });
    rulings = res.rulings;
    verdict = res.verdict;
  } else {
    // 无候选可选(所有目标托管/不可发现):用空 placement 裁决拿 needs-input/managed 结论。
    const res = adjudicate({
      facts, computeKind: req.computeKind,
      placement: { vpcId: facts.vpcs[0].vpcId, subnetIds: [], securityGroupIds: [], availabilityZones: [], rationale: "" },
      constraints: req.constraints,
    });
    rulings = res.rulings;
    verdict = res.verdict;
  }

  const remediations = buildRemediations(rulings, facts, req);

  // 探测降级 → verdict 诚实封顶为 unknown(同 index.ts:83)。
  if (facts.degraded && verdict === "reachable") verdict = "unknown";

  return {
    success: true,
    verdict,
    rulings,
    remediations,
    candidates: candidates.map((c) => ({ placement: c.placement, score: c.score, reason: c.reason })),
    chosenPlacement: chosen || null,
    facts: summarizeFacts(facts),
  };
}

// ───────────────────────── 细化工具:深挖单个 SG 完整规则 ─────────────────────────
async function inspectSecurityGroup(req: PlacedConnectivityRequest, groupId: string) {
  if (!groupId) return { success: false, error: "缺少 groupId" };
  const facts = await probeEnvironment(req); // cache warm 复用
  for (const v of facts.vpcs) {
    const sg = v.securityGroups.find((s) => s.groupId === groupId);
    if (sg) return { success: true, securityGroup: sg };
  }
  return { success: false, error: `未在已探测环境中找到安全组 ${groupId}` };
}

// ───────────────────────── Observability(EMF,零权限零延迟) ─────────────────────────
// 每次工具调用发 CloudWatch EMF 指标(namespace BGP/NetAdvisor);由 Lambda 日志自动抽取为指标。
function emitToolMetric(tool: string, isError: boolean) {
  try {
    console.log(JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: "BGP/NetAdvisor", Dimensions: [["ToolName"]], Metrics: [{ Name: "Calls", Unit: "Count" }, { Name: "Errors", Unit: "Count" }] }],
      },
      ToolName: tool || "unknown",
      Calls: 1,
      Errors: isError ? 1 : 0,
    }));
  } catch { /* 指标失败绝不影响技能执行 */ }
}

// ───────────────────────── handler ─────────────────────────
export const handler = async (event: SkillEvent, context: LambdaContext) => {
  const tool = toolNameOf(context);
  const req = event?.request;
  let result: { success: boolean; [k: string]: unknown };
  try {
    // @kf-batch 41-B115-netadvisor-place —— 落点(targetId + 描述符解析出的 region)由平台路由写进 request 再注入 Runtime;
    //   没有它就不知道该探哪个区的网络,fail-closed(不默认 Lambda 自己的 AWS_REGION = 主控区)。
    if (!req || !req.computeKind || !Array.isArray(req.targets) || !req.targetId || !req.region) {
      result = { success: false, error: "缺少 request(需含 computeKind + targets + targetId + region;落点由平台按 targetId 解析后写入)" };
    } else {
      switch (tool) {
        case "analyze_connectivity":
          result = await analyzeConnectivity(req, event.placement);
          break;
        case "inspect_security_group":
          result = await inspectSecurityGroup(req, String(event.groupId || ""));
          break;
        default:
          result = { success: false, error: `unknown tool: ${tool}` };
      }
    }
  } catch (e) {
    result = { success: false, error: e instanceof Error ? e.message : String(e) };
  }
  emitToolMetric(tool, result.success === false);
  return result;
};
