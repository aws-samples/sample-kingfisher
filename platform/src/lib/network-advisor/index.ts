// 网络连通性智能顾问 —— 对外公共入口。消费方只 import 本文件。
//
//   advise(req)      → 完整顾问（L1+L2+L3，大模型 reasoning + 结构化建议 + 一键预填）
//   probe(req)       → 仅 L1 环境事实（确定性、便宜，UI 预览）
//   adjudicatePath() → 仅 L2 权威裁决（无大模型成本）
//   prefillFor()     → 把 placement 映射为通道原生形态
//
// 结构化结果在这里组装：优先用 agent 选定的 placement；缺失/降级时用确定性选择器兜底（D3）。

import { probeEnvironment } from "./environment-probe";
import { adjudicate, type JudgeInput } from "./connectivity-judge";
import { runAdvisorAgent } from "./advisor-agent";
import { buildRemediations } from "./remediation";
import { prefillFor } from "./prefill-adapters";
import { selectCandidatePlacements } from "./placement";
import { isAgentCoreConfigured, invokeNetAdvisorAgent, type AdvisorInvokeOutput } from "./agentcore-client";
import { runtimeSessionId } from "./memory";
// @kf-batch 50-W5-seg2-WP8 — 模块 51 `_meta` 回显:把 agent 实际用的模型带到路由层。
import type { AiModelUse } from "@/lib/ai/meta";
import { AgentCoreModelMismatch } from "@/lib/ai/agentcore-contract";
import type {
  ConnectivityRecommendation,
  PlacedConnectivityRequest,
  EnvironmentFacts,
  RecommendedPlacement,
  Remediation,
  Ruling,
} from "./types";

export { prefillFor } from "./prefill-adapters";
// @kf-batch 41-B115-netadvisor-place —— 路由层把请求落到执行环境上的唯一入口
export { placeConnectivityRequest } from "./place";
export type * from "./types";

// 仅探测环境（确定性）。
export async function probe(req: PlacedConnectivityRequest): Promise<EnvironmentFacts> {
  return probeEnvironment(req);
}

// 仅裁决一个候选放置（确定性，无大模型）。
export function adjudicatePath(input: JudgeInput): { rulings: Ruling[]; verdict: ReturnType<typeof adjudicate>["verdict"] } {
  return adjudicate(input);
}

// 完整顾问。history 来自多轮记忆（由 API 路由注入）。
//
// 后端由 NETADVISOR_BACKEND 选择：`agentcore`(Runtime + Gateway MCP) | 默认进程内。
// 铁律(标准 §3 契约 7)：agentcore 启用后 try Runtime → catch 自动回退进程内(不让本可用功能失败)；
// `backend` 标签如实反映真实后端(回退后须改回 inprocess)。进程内实现既是默认路径也是回退兜底(一份两用)。
export interface AdviseResult extends ConnectivityRecommendation {
  backend: "agentcore" | "inprocess"; // 真翻转铁证：如实反映实际走的后端。
  // @kf-batch 50-W5-seg2-WP8 — 模块 51:实际用的模型(inprocess 由 agent 返回;agentcore 由容器回执,缺省=无回执)。
  model?: AiModelUse;
}

export async function advise(
  req: PlacedConnectivityRequest,
  history: { question: string; answer: string }[] = [],
  opts: { conversationId?: string } = {}
): Promise<AdviseResult> {
  const backend = (process.env.NETADVISOR_BACKEND || "inprocess").toLowerCase();
  const useAgentCore = backend === "agentcore" && isAgentCoreConfigured();

  if (useAgentCore) {
    try {
      const sid = runtimeSessionId(opts.conversationId || "default");
      const out = await invokeNetAdvisorAgent(sid, { request: req, history });
      return { ...assembleFromAgentCore(req, out), backend: "agentcore", model: out.model };
    } catch (e) {
      // @kf-batch 50-W5-seg2-WP8:模型回执不匹配 = 接线故障,fail-closed 上抛(路由 503),不回落假装成功。
      if (e instanceof AgentCoreModelMismatch) throw e;
      // Runtime 故障(冷启动/限流/Gateway/MCP)不应让本可用功能失败：自动回落进程内。
      console.warn(`[netadvisor] AgentCore 调用失败,回退 inprocess: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const inprocess = await adviseInprocess(req, history);
  return { ...inprocess.rec, backend: "inprocess", model: inprocess.model };
}

// 方案 A：Runtime 是自包含能力服务——容器内 Lambda 已做 L2 权威裁决，直接采用其 verdict/rulings/
// candidates/remediations/chosenPlacement；平台薄封装只补 prefill/confidence/questions(不重裁决)。
function assembleFromAgentCore(req: PlacedConnectivityRequest, out: AdvisorInvokeOutput): ConnectivityRecommendation {
  const chosen = out.chosenPlacement || out.candidates[0]?.placement;
  const facts = (out.facts as EnvironmentFacts | null) || emptyFacts(req);
  const degraded = !!(out.facts as { degraded?: boolean } | null)?.degraded;
  const rulings = out.rulings;
  const remediations = out.remediations as Remediation[];
  const questions = collectQuestions(rulings, facts);
  const prefill = chosen && (out.verdict === "reachable" || out.verdict === "reachable-after-fixes")
    ? prefillFor(req.computeKind, chosen)
    : undefined;
  return {
    verdict: out.verdict,
    recommendedPlacement: chosen,
    reasoning: out.reasoning || deterministicReasoning(out.verdict, rulings),
    facts,
    rulings,
    remediations,
    prefill,
    questions: questions.length ? questions : undefined,
    confidence: computeConfidence(out.verdict, { degraded } as EnvironmentFacts, out.llmAvailable),
    candidates: out.candidates.length > 1 ? out.candidates : undefined,
    usage: out.usage,
    llmAvailable: out.llmAvailable,
  };
}

// 进程内完整顾问（L1+L2+L3）——默认路径 + AgentCore 失败时的回退兜底（保留不删，标准 §7②）。
async function adviseInprocess(
  req: PlacedConnectivityRequest,
  history: { question: string; answer: string }[] = []
): Promise<{ rec: ConnectivityRecommendation; model: AiModelUse }> {
  const agent = await runAdvisorAgent(req, history);
  return { rec: await assembleInprocess(req, agent), model: agent.model };
}

async function assembleInprocess(
  req: PlacedConnectivityRequest,
  agent: Awaited<ReturnType<typeof runAdvisorAgent>>
): Promise<ConnectivityRecommendation> {
  const facts = agent.state.facts || (await probeEnvironment(req).catch(() => null));

  // 空环境/探测彻底失败 → needs-input。
  if (!facts || facts.vpcs.length === 0) {
    return {
      verdict: "needs-input",
      reasoning: agent.reasoning || "未能探测到可用的 VPC 环境。",
      facts: facts || emptyFacts(req),
      rulings: [],
      remediations: [],
      questions: ["未发现可用 VPC：请确认 region/账号，或手动指定目标所在的 VPC/子网/安全组。"],
      confidence: 0.2,
      usage: agent.usage,
      llmAvailable: agent.llmAvailable,
    };
  }

  // 确定性选择候选放置（同时作为 agent 选择的校验/兜底）。
  const candidates = selectCandidatePlacements(facts, req);

  // 选定 placement：优先 agent 的（若有且能在 facts 中找到 VPC），否则确定性 top1。
  let chosen: RecommendedPlacement | undefined = agent.state.chosenPlacement || candidates[0]?.placement;

  // 用 L2 对最终 placement 重新裁决（权威；不信任 agent 自报的裁决）。
  let rulings: Ruling[] = [];
  let verdict: ConnectivityRecommendation["verdict"] = "unknown";
  if (chosen) {
    const res = adjudicate({ facts, computeKind: req.computeKind, placement: chosen, constraints: req.constraints });
    rulings = res.rulings;
    verdict = res.verdict;
  } else {
    // 无候选可选（如所有目标托管/不可发现）：用空 placement 裁决以拿 needs-input/managed 结论。
    const res = adjudicate({ facts, computeKind: req.computeKind, placement: { vpcId: facts.vpcs[0].vpcId, subnetIds: [], securityGroupIds: [], availabilityZones: [], rationale: "" }, constraints: req.constraints });
    rulings = res.rulings;
    verdict = res.verdict;
  }

  const remediations = buildRemediations(rulings, facts, req);

  // 探测降级 → verdict 诚实封顶为 unknown（除非已是 needs-input）。
  if (facts.degraded && verdict === "reachable") verdict = "unknown";

  const questions = collectQuestions(rulings, facts);
  const prefill = chosen && (verdict === "reachable" || verdict === "reachable-after-fixes") ? prefillFor(req.computeKind, chosen) : undefined;

  return {
    verdict,
    recommendedPlacement: chosen,
    reasoning: agent.reasoning || deterministicReasoning(verdict, rulings),
    facts,
    rulings,
    remediations,
    prefill,
    questions: questions.length ? questions : undefined,
    confidence: computeConfidence(verdict, facts, agent.llmAvailable),
    candidates: candidates.length > 1 ? candidates : undefined,
    usage: agent.usage,
    llmAvailable: agent.llmAvailable,
  };
}

function collectQuestions(rulings: Ruling[], facts: EnvironmentFacts): string[] {
  const qs: string[] = [];
  for (const r of rulings) {
    if (r.ruleId === "DISCOVERABILITY" && r.status === "FAIL") {
      qs.push(`目标无法自动发现（${r.detail}）。请提供该目标所在的 VPC ID / CIDR / 安全组，或确认它是否跨账号/外部。`);
    }
  }
  if (facts.degraded) qs.push(`部分网络信息因权限/限流未能获取（${facts.missing.slice(0, 3).join("；")}），相关判定已标记为不确定。`);
  return Array.from(new Set(qs));
}

function deterministicReasoning(verdict: string, rulings: Ruling[]): string {
  const fails = rulings.filter((r) => r.status === "FAIL").map((r) => `[${r.ruleId}] ${r.detail}`);
  const head: Record<string, string> = {
    reachable: "当前网络配置即可连通。",
    "reachable-after-fixes": "完成下列修复后即可连通：",
    unreachable: "当前拓扑无法连通：",
    "needs-input": "信息不足，需补充：",
    unknown: "网络信息不完整，判定不确定：",
  };
  return [head[verdict] || "", ...fails].filter(Boolean).join("\n- ");
}

function computeConfidence(verdict: string, facts: EnvironmentFacts, llm: boolean): number {
  let c = 0.6;
  if (verdict === "reachable") c = 0.85;
  if (verdict === "reachable-after-fixes") c = 0.75;
  if (verdict === "needs-input") c = 0.4;
  if (verdict === "unknown") c = 0.45;
  if (facts.degraded) c -= 0.2;
  if (!llm) c -= 0.05; // 确定性兜底略降（但 L2 仍权威）
  return Math.max(0.1, Math.min(1, c));
}

function emptyFacts(req: PlacedConnectivityRequest): EnvironmentFacts {
  return { region: req.region, source: req.source, vpcs: [], targets: [], degraded: true, missing: ["probe failed"], capturedAt: new Date().toISOString() };
}
