// 网络顾问配置 — 镜像 genbi/config.ts 的做法：环境相关全走 env，默认值中性（无账号特定值）。
// 复用与 GenBI 相同的 Bedrock 模型/区域，保持平台大模型调用一致。
import { homeRegion } from "@/lib/place/home-region";
import { resolveModelId } from "@/lib/ai/model"; // 模型 ID 收敛 SSOT(ai-model.json)

function int(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) ? v : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = (process.env[name] || "").toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return fallback;
}

export const NET_ADVISOR = {
  region: homeRegion(),
  // @deprecated 保留字段不动对象形状;advisor-agent.ts 已改为调用时
  // 经运行时解析链求值(bgp-settings → env → SSOT)。此处只是部署期快照,不反映页面切换后的生效值。
  /** @deprecated 模块加载期快照(env ‖ SSOT),不含运行时配置层;勿在新代码读取。 */
  modelId: resolveModelId(),

  // L3 Converse tool-use 环参数。
  maxIters: int("NET_ADVISOR_MAX_ITERS", 10), // 工具调用循环上限（探测+逐目标裁决+补救，比 GenBI 略多）
  maxTokens: int("NET_ADVISOR_MAX_TOKENS", 3000), // Converse maxTokens（结构化建议较长）

  // L1 探测缓存（同一 region/vpc/目标签名短时间复用，省 Describe 调用）。
  cacheTtlSec: int("NET_ADVISOR_CACHE_TTL_SEC", 60),

  // 平台默认 VPC/子网（无源/目标线索时的回退；与 datasource-service detectNetwork 的 env 对齐）。
  defaultVpcId: process.env.DEFAULT_VPC_ID || "",

  // VPC Reachability Analyzer 升级（Phase 2；Phase 1 关闭）。
  reachabilityAnalyzer: {
    enabled: bool("NET_ADVISOR_REACHABILITY_ENABLED", false),
    pollMs: int("NET_ADVISOR_REACHABILITY_POLL_MS", 3000),
    pollAttempts: int("NET_ADVISOR_REACHABILITY_POLL_ATTEMPTS", 40),
    budgetUsd: int("NET_ADVISOR_REACHABILITY_BUDGET_USD", 5),
  },

  // 授权改网络（Phase 2；Phase 1 一律只读，apply 路由不启用）。
  applyEnabled: bool("NET_ADVISOR_APPLY_ENABLED", false),
} as const;

// 各 DB 类型默认端口（与 datasource-service.ts DB_PORT 一致）。
export const DEFAULT_DB_PORT: Record<string, number> = {
  mysql: 3306,
  postgresql: 5432,
  oracle: 1521,
  sqlserver: 1433,
};

// 目标 kind → 默认端口（resolver 未显式给 port 时用）。
export const TARGET_DEFAULT_PORT: Record<string, number> = {
  rds: 3306,
  aurora: 3306,
  redshift: 5439,
  opensearch: 443,
  msk: 9098, // IAM auth 默认；sasl-scram=9096, tls=9094, plaintext=9092（resolver 按 auth 细化）
};
