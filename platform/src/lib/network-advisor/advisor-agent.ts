// L3 大模型顾问 agent —— 照抄 genbi/agent.ts:136-194 的 Bedrock Converse tool-use 环。
// 模型只能通过工具拿事实/裁决（反幻觉）；裁决恒由 L2 确定性引擎给出，模型不自行判 PASS/FAIL。
//
// 返回：模型的自然语言 reasoning + 它探到的 facts + 所有 ruling + 它选定的 placement（若有）。
// 结构化字段的最终组装/兜底在 index.ts（解析失败也能确定性产出，场景 D3）。

// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { BedrockRuntimeClient, ConverseCommand, type Message, type Tool } from "@aws-sdk/client-bedrock-runtime";
import { NET_ADVISOR } from "./config";
import { systemPrompt } from "./prompt";
import { probeEnvironment } from "./environment-probe";
import { adjudicate } from "./connectivity-judge";
import { buildRemediations } from "./remediation";
import type { PlacedConnectivityRequest, EnvironmentFacts, RecommendedPlacement, Ruling } from "./types";
// 循环内 Converse 的 modelId 改调用处求值(循环外解析一次候选层,经 invokeConverse
// 退避/降级),不再读模块加载期常量 NET_ADVISOR.modelId(NET_ADVISOR 其余字段不动)。
import { resolveLayered } from "@/lib/ai/model";
import { invokeConverse } from "@/lib/ai/invoke";
import type { AiModelUse } from "@/lib/ai/meta";

const bedrock = sdkClient("model", BedrockRuntimeClient, { region: NET_ADVISOR.region });

// agent 运行中累积的"权威"状态——工具调用产生，最终交给 index 组装结构化结果。
export interface AgentState {
  facts: EnvironmentFacts | null;
  rulings: Ruling[];
  chosenPlacement: RecommendedPlacement | null;
}

function tools(): Tool[] {
  return [
    {
      toolSpec: {
        name: "probe_environment",
        description: "探测当前 AWS 网络环境（VPC/子网/安全组/路由表/NAT/VPC endpoint/NACL/DNS 属性）以及把请求里的目标解析成具体网络坐标。返回结构化事实。开始任何判断前先调它。",
        inputSchema: { json: { type: "object", properties: {}, required: [] } },
      },
    },
    {
      toolSpec: {
        name: "adjudicate_path",
        description: "对一个候选放置（VPC + 子网 + 计算安全组）运行确定性规则引擎，返回每条规则的 PASS/FAIL/UNKNOWN 裁决。判定可达性必须用本工具，不要自己推断。",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              vpcId: { type: "string", description: "候选 VPC ID" },
              subnetIds: { type: "array", items: { type: "string" }, description: "候选子网 ID 列表（私有优先）" },
              securityGroupIds: { type: "array", items: { type: "string" }, description: "计算侧安全组 ID 列表" },
              availabilityZones: { type: "array", items: { type: "string" }, description: "可用区列表（Glue 须与子网 AZ 一致）" },
            },
            required: ["vpcId", "subnetIds"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "inspect_security_group",
        description: "查看某个安全组的入站/出站规则明细（用于最小权限分析、定位缺失的放行规则）。",
        inputSchema: { json: { type: "object", properties: { groupId: { type: "string" } }, required: ["groupId"] } },
      },
    },
    {
      toolSpec: {
        name: "list_remediations",
        description: "根据当前的 FAIL/UNKNOWN 裁决，生成最小补救动作清单（每条带 API 预览）。遵守用户约束。",
        inputSchema: { json: { type: "object", properties: {}, required: [] } },
      },
    },
  ];
}

export interface AgentResult {
  reasoning: string;
  state: AgentState;
  usage: { inputTokens: number; outputTokens: number };
  llmAvailable: boolean;
  // `_meta` 回显:实际用的模型(降级则为回落层)。
  model: AiModelUse;
}

// history: 之前轮次（来自 memory），messagesSeed 注入。
export async function runAdvisorAgent(
  req: PlacedConnectivityRequest,
  history: { question: string; answer: string }[] = []
): Promise<AgentResult> {
  const state: AgentState = { facts: null, rulings: [], chosenPlacement: null };
  let inTok = 0;
  let outTok = 0;

  const system = [{ text: systemPrompt() }];
  const messages: Message[] = [];
  // 注入多轮历史。
  for (const h of history) {
    messages.push({ role: "user", content: [{ text: h.question }] });
    messages.push({ role: "assistant", content: [{ text: h.answer }] });
  }
  // 本轮诉求：computeKind + targets + constraints + 用户自由文本。
  const firstTurn = [
    `计算类型: ${req.computeKind}`,
    `目标: ${JSON.stringify(req.targets)}`,
    req.constraints ? `约束: ${JSON.stringify(req.constraints)}` : "",
    req.source ? `已有放置: ${JSON.stringify(req.source)}` : "",
    req.userMessage ? `用户补充: ${req.userMessage}` : "请给出网络连通建议。",
  ].filter(Boolean).join("\n");
  messages.push({ role: "user", content: [{ text: firstTurn }] });

  const toolConfig = { tools: tools() };

  // 循环外求值一次候选层;`used` = 最近一次实际用的模型。
  const layers = await resolveLayered("net-advisor");
  let used: AiModelUse = { modelId: layers[0].modelId, modelSource: layers[0].source };

  try {
    for (let iter = 0; iter < NET_ADVISOR.maxIters; iter++) {
      const inv = await invokeConverse(
        "net-advisor",
        undefined,
        bedrock,
        (modelId) =>
          new ConverseCommand({
            modelId,
            system,
            messages,
            toolConfig,
            inferenceConfig: { maxTokens: NET_ADVISOR.maxTokens },
          }),
        {},
        { layers }
      );
      const resp = inv.response;
      used = { modelId: inv.usedModelId, modelSource: inv.usedSource, ...(inv.degraded ? { degraded: true } : {}) };
      inTok += resp.usage?.inputTokens || 0;
      outTok += resp.usage?.outputTokens || 0;

      const outMsg = resp.output?.message;
      if (outMsg) messages.push(outMsg);

      if (resp.stopReason !== "tool_use") {
        const reasoning = (outMsg?.content || []).map((b) => ("text" in b ? b.text : "")).join("").trim();
        return { reasoning, state, usage: { inputTokens: inTok, outputTokens: outTok }, llmAvailable: true, model: used };
      }

      const toolResults: Message["content"] = [];
      for (const blk of outMsg?.content || []) {
        const tu = "toolUse" in blk ? blk.toolUse : undefined;
        if (!tu || !tu.toolUseId) continue;
        const payload = await runTool(tu.name || "", (tu.input || {}) as Record<string, unknown>, req, state);
        toolResults.push({ toolResult: { toolUseId: tu.toolUseId, content: [{ json: payload as any }] } });
      }
      messages.push({ role: "user", content: toolResults });
    }
    // 达到迭代上限：返回已积累状态，由 index 确定性组装。
    return { reasoning: "（已达最大推理步数，下面给出基于确定性裁决的建议。）", state, usage: { inputTokens: inTok, outputTokens: outTok }, llmAvailable: true, model: used };
  } catch (e) {
    // Bedrock 不可用/限流：确定性兜底（场景 D3）。确保至少探一次环境，让 index 能产出结果。
    if (!state.facts) {
      try { state.facts = await probeEnvironment(req); } catch { /* 探测也失败则交 index 处理空 facts */ }
    }
    return { reasoning: `（大模型暂不可用：${e instanceof Error ? e.message : String(e)}；以下为确定性裁决结果。）`, state, usage: { inputTokens: inTok, outputTokens: outTok }, llmAvailable: false, model: used };
  }
}

// 工具分发——所有工具产出权威数据并回填 state（反幻觉的关键：模型拿到的都是真实/确定性结果）。
async function runTool(name: string, input: Record<string, unknown>, req: PlacedConnectivityRequest, state: AgentState): Promise<unknown> {
  switch (name) {
    case "probe_environment": {
      if (!state.facts) state.facts = await probeEnvironment(req);
      // 回传精简版（避免超长；保留模型决策所需字段）。
      return summarizeFacts(state.facts);
    }
    case "adjudicate_path": {
      if (!state.facts) state.facts = await probeEnvironment(req);
      const placement: RecommendedPlacement = {
        vpcId: String(input.vpcId || ""),
        subnetIds: (input.subnetIds as string[]) || [],
        securityGroupIds: (input.securityGroupIds as string[]) || [],
        availabilityZones: (input.availabilityZones as string[]) || [],
        rationale: "agent 候选",
      };
      const { rulings, verdict } = adjudicate({ facts: state.facts, computeKind: req.computeKind, placement, constraints: req.constraints });
      state.rulings = rulings;
      state.chosenPlacement = placement;
      return { verdict, rulings };
    }
    case "inspect_security_group": {
      if (!state.facts) state.facts = await probeEnvironment(req);
      const gid = String(input.groupId || "");
      for (const v of state.facts.vpcs) {
        const sg = v.securityGroups.find((s) => s.groupId === gid);
        if (sg) return sg;
      }
      return { error: `未在已探测环境中找到安全组 ${gid}` };
    }
    case "list_remediations": {
      const rems = buildRemediations(state.rulings, state.facts, req);
      return { remediations: rems };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

// 精简 facts 给模型（去掉冗长字段，保留 ID/AZ/cidr/私有标志/endpoint 服务名/SG 规则摘要）。
function summarizeFacts(facts: EnvironmentFacts) {
  return {
    region: facts.region,
    degraded: facts.degraded,
    missing: facts.missing,
    vpcs: facts.vpcs.map((v) => ({
      vpcId: v.vpcId, cidr: v.cidr, isDefault: v.isDefault, name: v.name,
      dnsSupport: v.dnsSupport, dnsHostnames: v.dnsHostnames,
      natGatewayAzs: v.natGatewayAzs,
      subnets: v.subnets.map((s) => ({ subnetId: s.subnetId, az: s.az, cidr: s.cidr, isPublic: s.isPublic, routesToNat: s.routesToNat, freeIps: s.freeIps })),
      securityGroups: v.securityGroups.map((s) => ({ groupId: s.groupId, name: s.name, ingressCount: s.ingress.length, egressCount: s.egress.length })),
      endpoints: v.endpoints.map((e) => ({ id: e.id, service: e.service, type: e.type })),
      peerings: v.peerings, tgwAttachments: v.tgwAttachments,
    })),
    targets: facts.targets.map((t) => ({ kind: t.target.kind, vpcId: t.vpcId, cidr: t.cidr, port: t.port, azs: t.azs, securityGroupIds: t.securityGroupIds, endpointModel: t.endpointModel, discoverable: t.discoverable, notes: t.notes })),
  };
}
