// GenBI configuration — everything environment-specific comes from env vars.
// Defaults are neutral (no account-specific values), mirroring the DataAgent
// reference project. Override freely via the platform's env.
import { homeRegion } from "@/lib/place/home-region";
import { resolveModelId } from "@/lib/ai/model";
// @kf-batch 50-P50.1-workgroup-ssot — 数仓落点唯一出口(收编兜底字面量)。
import { homeWorkgroup, homeDatabase } from "@/lib/redshift/warehouse-location"; // 模块47 L0:模型 ID 收敛 SSOT(ai-model.json)

function int(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) ? v : fallback;
}

export const GENBI = {
  region: homeRegion(),
  // @kf-batch 50-W5-seg2-WP8 — 模块 51:@deprecated 保留字段不动对象形状。9 个消费点已不再读它
  // (改为调用时经 lib/ai/model.ts 的运行时解析链求值:bgp-settings → env → SSOT),这里只是部署期快照,
  // 不反映页面上切换后的生效值。新代码请用 resolveModelIdRuntime("<capability>") / invokeConverse。
  /** @deprecated 模块加载期快照(env ‖ SSOT),不含运行时配置层;勿在新代码读取。 */
  modelId: resolveModelId(),

  // Redshift target (the warehouse the platform loads data into).
  workgroup: homeWorkgroup(),
  database: homeDatabase(),

  // Tunables (sane defaults; mirror DataAgent).
  maxIters: int("GENBI_MAX_ITERS", 8), // tool-use loop cap
  maxTokens: int("GENBI_MAX_TOKENS", 2200), // Converse maxTokens
  modelRows: int("GENBI_MODEL_ROWS", 50), // rows handed back to the model
  maxRows: int("GENBI_MAX_ROWS", 200), // hard cap on rows fetched/displayed
  pollAttempts: int("GENBI_POLL_ATTEMPTS", 40),
  pollIntervalMs: int("GENBI_POLL_MS", 800),
} as const;
