// AgentCore 技能 Lambda handler —— 参数辅助顾问的【确定性工具后端】。
// 挂 bgp-paramadvisor-gateway 的 GatewayTarget;Runtime 容器(agent.js)经 MCP 调这些工具。
// 平台标准见 docs/design/28-agentcore-standard/DESIGN.md;第二个标准实现(照网络顾问样板)。
//
// ── 工具无状态化(标准 §7①):粗粒度合并工具 ──
//   • recommend_parameters —— 一条龙 探测运行历史→启发式推荐→prefill 组装,完整历史只活在
//     本次调用内,回推荐清单 + 历史摘要。
//   • inspect_job_history —— 深挖单个作业的运行历史明细(模型要看失败原因/时长分布时单独调)。
// req(ParamAdviceRequest)是【无状态请求上下文】,由 Runtime 容器每次注入 event.request。
//
// ── 只读(标准红线,同 network-advisor-readonly-only) ──
// 全部工具只 Get/Describe 运行历史/配置,绝不写资源。所需权限见 infra/lib/paramadvisor-iam.ts。
//
// ── esbuild 单源(标准打包策略) ──
// 本 handler 与 catalog/heuristics/history-probe 同在 platform/src/lib/param-advisor/,与进程内
// 实现【同一份源码】(零漂移)。CDK NodejsFunction entry 指向本文件。

import { recommend } from "./heuristics";
import { probeHistory } from "./history-probe";
import { catalogFor } from "./catalog";
import type { ParamAdviceRequest } from "./types";

// ───────────────────────── Gateway 工具名解析(标准契约 3) ─────────────────────────
interface LambdaContext {
  clientContext?: { Custom?: Record<string, unknown>; custom?: Record<string, unknown> };
}
export function toolNameOf(context: LambdaContext | undefined): string {
  const custom = (context?.clientContext?.Custom || context?.clientContext?.custom || {}) as Record<string, unknown>;
  const raw = String(custom.bedrockAgentCoreToolName || "");
  const parts = raw.split("___");
  return parts[parts.length - 1] || raw;
}

// ───────────────────────── 事件契约 ─────────────────────────
interface SkillEvent {
  request?: ParamAdviceRequest; // Runtime 每次注入的请求上下文(必需)
  workloadOverride?: Record<string, unknown>; // recommend_parameters:模型从对话中抽取的特征补充
  jobRef?: { kind?: string; id?: string }; // inspect_job_history:要深挖的作业(缺省用 request.jobRef)
}

// ───────────────────────── 主工具:一条龙确定性推荐 ─────────────────────────
// = 进程内 index.ts advise() 的确定性部分(探测历史 + 启发式引擎 + prefill)。
// workloadOverride:模型从多轮对话中抽取的特征(如用户说"大概 200GB"→estimatedDataGB:200),
// 合并进 workload 后重算——特征抽取交给模型,推荐值恒由确定性引擎给出。
async function recommendParameters(req: ParamAdviceRequest, workloadOverride?: Record<string, unknown>) {
  const merged: ParamAdviceRequest = workloadOverride
    ? { ...req, workload: { ...(req.workload || {}), ...workloadOverride } }
    : req;
  if (!catalogFor(merged.channel).length) {
    return { success: false, error: `未知参数通道: ${merged.channel}(可选 glue-etl/glue-sync/flink/dms)` };
  }
  const history = await probeHistory(merged.jobRef); // 完整历史只活在本次调用内
  const result = recommend(merged, history);
  return {
    success: true,
    channel: merged.channel,
    workload: merged.workload || {},
    recommendations: result.recommendations,
    prefill: result.prefill || null,
    questions: result.questions,
    confidence: result.confidence,
    historyFacts: history, // 摘要级(GlueRunStats 等本就是统计摘要,无重型明细)
  };
}

// ───────────────────────── 细化工具:深挖单作业运行历史 ─────────────────────────
async function inspectJobHistory(req: ParamAdviceRequest, jobRefIn?: { kind?: string; id?: string }) {
  const jobRef = jobRefIn?.id
    ? { kind: (jobRefIn.kind || "glue-job") as NonNullable<ParamAdviceRequest["jobRef"]>["kind"], id: String(jobRefIn.id) }
    : req.jobRef;
  if (!jobRef?.id) return { success: false, error: "缺少 jobRef(需含 kind + id)" };
  const facts = await probeHistory(jobRef);
  if (facts.degraded) return { success: false, error: `探测失败: ${facts.missing.join("; ")}` };
  return { success: true, historyFacts: facts };
}

// ───────────────────────── Observability(EMF,零权限零延迟) ─────────────────────────
function emitToolMetric(tool: string, isError: boolean) {
  try {
    console.log(JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: "BGP/ParamAdvisor", Dimensions: [["ToolName"]], Metrics: [{ Name: "Calls", Unit: "Count" }, { Name: "Errors", Unit: "Count" }] }],
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
    if (!req || !req.channel) {
      result = { success: false, error: "缺少 request(需含 channel)" };
    } else {
      switch (tool) {
        case "recommend_parameters":
          result = await recommendParameters(req, event.workloadOverride);
          break;
        case "inspect_job_history":
          result = await inspectJobHistory(req, event.jobRef);
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
