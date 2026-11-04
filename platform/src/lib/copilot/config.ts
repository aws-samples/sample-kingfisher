// 统一 Copilot 配置。全部环境相关值走 env,默认中性(无账号/区域字面量),
// 面向全球用户自行下载安装:换账号/区域改 env 即跑。形态照抄 lib/genbi/config.ts。
// 记忆:[[global-self-install-architecture]] [[module44-unified-copilot]]。
import { homeRegion } from "@/lib/place/home-region";
import { resolveModelId } from "@/lib/ai/model"; // 模型 ID 收敛 SSOT(ai-model.json)

function int(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) ? v : fallback;
}

export const COPILOT = {
  region: homeRegion(),
  // @deprecated 保留字段不动对象形状;agent.ts / planner.ts 已改为调用时
  // 经运行时解析链求值(bgp-settings → env → SSOT)。此处只是部署期快照,不反映页面切换后的生效值。
  /** @deprecated 模块加载期快照(env ‖ SSOT),不含运行时配置层;勿在新代码读取。 */
  modelId: resolveModelId(),

  // 后端:agentcore(Runtime)| inprocess(默认,进程内直调 Bedrock,零基建即可用)。
  backend: (process.env.COPILOT_BACKEND || "inprocess").toLowerCase(),
  runtimeArn: process.env.COPILOT_RUNTIME_ARN || "",

  // 托管 Memory 双后端(标准契约 6):selfmanaged(默认,DynamoDB TTL)| agentcore。
  memoryBackend: (process.env.COPILOT_MEMORY_BACKEND || "selfmanaged").toLowerCase(),
  memoryId: process.env.COPILOT_MEMORY_ID || "",

  // Tunables(合理默认;可 env 覆盖)。
  maxIters: int("COPILOT_MAX_ITERS", 6), // tool-use 循环上限(只读工具通常 1-2 轮足够)
  maxTokens: int("COPILOT_MAX_TOKENS", 2400), // Converse maxTokens
  historyTurns: int("COPILOT_HISTORY_TURNS", 8), // 注入模型的最近多轮对话数
  // 墙钟软上限(ms):同步请求须 < CloudFront origin 60s 硬超时,否则 504。默认 45s 留足收尾余量。
  deadlineMs: int("COPILOT_DEADLINE_MS", 45000),

  // ── 规划大脑(Strands planner)专用调参 ──
  // 规划=发现(多次只读工具)+ 结构化产出(强制 StructuredOutputTool 至少 1 轮),
  // 比问答需要更多轮次与更大 token。turns 要给发现留足空间且不撞墙钟。
  planTurns: int("COPILOT_PLAN_TURNS", 10), // 发现工具轮 + 结构化输出轮(6 太紧,发现用完就没轮次产计划)
  planMaxTokens: int("COPILOT_PLAN_MAX_TOKENS", 4096), // 多步骤计划的结构化 JSON 需要更大输出预算
  planDeadlineMs: int("COPILOT_PLAN_DEADLINE_MS", 52000), // 墙钟软上限,<CloudFront 60s;比问答给足
} as const;

// 是否启用 AgentCore 后端(env 配了 runtime-arn 且 backend=agentcore)。
export function isAgentCoreConfigured(): boolean {
  return COPILOT.backend === "agentcore" && !!COPILOT.runtimeArn;
}
