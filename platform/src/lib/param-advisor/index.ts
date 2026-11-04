// 参数辅助智能顾问 — 对外公共入口。消费方只 import 本文件。
//
//   advise(req)        → 完整顾问(确定性推荐 + 大模型解释 + 一键预填 + 多轮)
//   recommendOnly(req) → 仅确定性推荐(零大模型成本,UI 秒回预览)
//
// 后端由 PARAMADVISOR_BACKEND 选择:`agentcore`(Runtime + Gateway MCP) | 默认进程内。
// 铁律(标准 §3 契约 7):agentcore 启用后 try Runtime → catch 自动回退进程内(不让本可用功能失败);
// `backend` 标签如实反映真实后端(回退后须改回 inprocess)。进程内实现既是默认路径也是回退兜底(一份两用)。
//
// 进程内实现 = 确定性引擎(probeHistory+recommend) + 单次 Converse 生成人话解释;
// Converse 失败 → llmAvailable:false + 确定性文本(推荐值本就来自引擎,解释降级不影响正确性)。

import { homeRegion } from "@/lib/place/home-region";
// @kf-batch 50-WP31-place-first-class —— 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { recommend } from "./heuristics";
import { probeHistory } from "./history-probe";
import { systemPrompt } from "./prompt";
import { isAgentCoreConfigured, invokeParamAdvisorAgent } from "./agentcore-client";
import { runtimeSessionId } from "./memory";
// @kf-batch 50-W5-seg2-WP8 — 模块 51:删掉模块加载期顶层常量 MODEL_ID = resolveModelId()(DESIGN §1.2 #7「最易漏」);
// Converse 的 modelId 改为调用时经 invokeConverse 求值(能力 key param-advisor),退避/降级,实际用的模型随结果回显。
import { invokeConverse } from "@/lib/ai/invoke";
import type { AiModelUse } from "@/lib/ai/meta";
import { AgentCoreModelMismatch } from "@/lib/ai/agentcore-contract";
import type { HistoryFacts, ParamAdvice, ParamAdviceRequest, ParamRecommendation } from "./types";

export type * from "./types";

const REGION = homeRegion();
const MAX_TOKENS = parseInt(process.env.PARAM_ADVISOR_MAX_TOKENS || "1600", 10);

const bedrock = sdkClient("model", BedrockRuntimeClient, { region: REGION });

export interface ParamAdviseResult extends ParamAdvice {
  backend: "agentcore" | "inprocess"; // 真翻转铁证:如实反映实际走的后端。
  // @kf-batch 50-W5-seg2-WP8 — 模块 51:实际用的模型(inprocess 由 Converse 返回;agentcore 由容器回执;Converse 降级无值)。
  model?: AiModelUse;
}

// 仅确定性推荐(零大模型,便宜快路径;标准 §7③ 的"廉价只读快路径")。
export async function recommendOnly(req: ParamAdviceRequest): Promise<ParamAdvice> {
  const history = await probeHistory(req.jobRef).catch(
    (): HistoryFacts => ({ kind: "none", degraded: true, missing: ["probe failed"], capturedAt: new Date().toISOString() })
  );
  const r = recommend(req, history);
  return {
    recommendations: r.recommendations,
    prefill: r.prefill,
    reasoning: deterministicReasoning(r.recommendations, r.questions),
    questions: r.questions.length ? r.questions : undefined,
    historyFacts: history,
    confidence: r.confidence,
    llmAvailable: false,
  };
}

// 完整顾问。history 来自多轮记忆(由 API 路由注入)。
export async function advise(
  req: ParamAdviceRequest,
  history: { question: string; answer: string }[] = [],
  opts: { conversationId?: string } = {}
): Promise<ParamAdviseResult> {
  const backend = (process.env.PARAMADVISOR_BACKEND || "inprocess").toLowerCase();
  const useAgentCore = backend === "agentcore" && isAgentCoreConfigured();

  if (useAgentCore) {
    try {
      const sid = runtimeSessionId(opts.conversationId || "default");
      const out = await invokeParamAdvisorAgent(sid, { request: req, history });
      // 方案 A:Runtime 自包含(容器内 Lambda 已跑确定性引擎),直接采用其结构化结论。
      return {
        recommendations: out.recommendations,
        prefill: out.prefill || undefined,
        reasoning: out.reasoning || deterministicReasoning(out.recommendations, out.questions),
        questions: out.questions.length ? out.questions : undefined,
        historyFacts: out.historyFacts,
        confidence: out.confidence,
        usage: out.usage,
        llmAvailable: out.llmAvailable,
        backend: "agentcore",
        model: out.model,
      };
    } catch (e) {
      // @kf-batch 50-W5-seg2-WP8:模型回执不匹配 = 接线故障,fail-closed 上抛(路由 503),不回落假装成功。
      if (e instanceof AgentCoreModelMismatch) throw e;
      // Runtime 故障(冷启动/限流/Gateway/MCP)不应让本可用功能失败:自动回落进程内。
      console.warn(`[paramadvisor] AgentCore 调用失败,回退 inprocess: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ...(await adviseInprocess(req, history)), backend: "inprocess" };
}

// 进程内完整顾问 —— 默认路径 + AgentCore 失败时的回退兜底(保留不删,标准 §7②)。
async function adviseInprocess(
  req: ParamAdviceRequest,
  history: { question: string; answer: string }[] = []
): Promise<ParamAdvice & { model?: AiModelUse }> {
  const facts = await probeHistory(req.jobRef).catch(
    (): HistoryFacts => ({ kind: "none", degraded: true, missing: ["probe failed"], capturedAt: new Date().toISOString() })
  );
  const r = recommend(req, facts);

  // 单次 Converse 生成人话解释(推荐值已由引擎给出,模型只解释——反幻觉支柱③)。
  let reasoning = "";
  let llmAvailable = true;
  let usage = { inputTokens: 0, outputTokens: 0 };
  let model: AiModelUse | undefined;
  try {
    // @kf-batch 50-W5-seg2-WP8:modelId 每次调用求值(param-advisor),经 invokeConverse 退避/降级。
    const inv = await invokeConverse("param-advisor", undefined, bedrock, (modelId) => new ConverseCommand({
      modelId,
      system: [{ text: systemPrompt(req.channel) }],
      messages: [
        ...history.slice(-6).flatMap((h) => h.question ? [
          { role: "user" as const, content: [{ text: String(h.question) }] },
          { role: "assistant" as const, content: [{ text: String(h.answer || "(上一轮无文字结论)").slice(0, 3000) }] },
        ] : []),
        {
          role: "user" as const,
          content: [{
            text: [
              `场景: ${req.channel};工作负载特征: ${JSON.stringify(req.workload || {})}`,
              req.userMessage ? `用户诉求: ${req.userMessage}` : "",
              `确定性引擎已给出推荐(你只解释,不改值):${JSON.stringify(r.recommendations.map((x) => ({ key: x.key, label: x.label, value: x.value, reason: x.reason, changed: x.changed })))}`,
              r.questions.length ? `缺失特征(要向用户追问): ${JSON.stringify(r.questions)}` : "",
              facts.kind !== "none" ? `运行历史摘要: ${JSON.stringify(facts)}` : "",
              "请按输出契约用简洁中文解释这些推荐(先总结后逐条),有缺失特征就列出请用户补充。",
            ].filter(Boolean).join("\n"),
          }],
        },
      ],
      inferenceConfig: { maxTokens: MAX_TOKENS },
    }));
    const resp = inv.response;
    model = { modelId: inv.usedModelId, modelSource: inv.usedSource, ...(inv.degraded ? { degraded: true } : {}) };
    usage = { inputTokens: resp.usage?.inputTokens || 0, outputTokens: resp.usage?.outputTokens || 0 };
    reasoning = (resp.output?.message?.content || []).map((b) => ("text" in b ? b.text : "")).join("").trim();
  } catch (e) {
    // 大模型降级:确定性推荐仍权威可用,如实标记。
    console.warn(`[paramadvisor] Converse 失败,确定性兜底: ${e instanceof Error ? e.message : String(e)}`);
    llmAvailable = false;
  }

  return {
    recommendations: r.recommendations,
    prefill: r.prefill,
    reasoning: reasoning || deterministicReasoning(r.recommendations, r.questions),
    questions: r.questions.length ? r.questions : undefined,
    historyFacts: facts,
    confidence: llmAvailable ? r.confidence : Math.max(0.1, r.confidence - 0.05),
    usage,
    llmAvailable,
    model,
  };
}

function deterministicReasoning(recs: ParamRecommendation[], questions: string[]): string {
  const changed = recs.filter((x) => x.changed);
  const head = changed.length
    ? `建议调整 ${changed.length} 个参数:${changed.map((x) => `${x.label}→${JSON.stringify(x.value)}`).join("、")}。`
    : "当前配置与推荐一致(或未提供当前值),以下为各参数推荐。";
  const lines = recs.map((x) => `- ${x.label} = ${JSON.stringify(x.value)}${x.unit ? ` ${x.unit}` : ""}:${x.reason}`);
  const qs = questions.length ? [`\n补充以下信息可获得更准的推荐:`, ...questions.map((q) => `- ${q}`)] : [];
  return [head, ...lines, ...qs].join("\n");
}
