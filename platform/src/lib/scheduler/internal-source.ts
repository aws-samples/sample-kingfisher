// @kf-batch 50-WP28-platform-action-node
// 内部端点来源判定的**纯头部**那两道(不 import 任何 node 内置 —— 中间件跑在 edge,
// `node:crypto` 一旦进了它的可达面就构建失败;密钥比对在 `internal-guard.ts`,只在 Node 路由里用)。
export const INTERNAL_KEY_HEADER = "x-bgp-internal-key";
export const INTERNAL_SOURCE_HEADER = "x-bgp-internal-source";
export const INTERNAL_SOURCE_ACTION_DISPATCHER = "action-dispatcher";
// @kf-batch 50-WP9a-durable-jobs —— 第二个登记来源:数据面长作业的推进泵(平台进程自己回环调用,WP-9 ④-2)
export const INTERNAL_SOURCE_DATAPLANE_JOB_PUMP = "dataplane-job-pump";
/** @kf-batch 50-B51-backfill-pump —— 补数计划的后台推进泵(回环调 `/api/internal/backfill/tick`)。 */
export const INTERNAL_SOURCE_BACKFILL_PUMP = "backfill-pump";
/**
 * 登记过的内部来源(封闭集合)。🔴 中间件只判「是不是登记过的来源」;**哪个端点收哪个来源**由路由守卫按
 * `expectedSource` 精确判(泵的密钥头敲不开分发 Lambda 的端点,反之亦然)。
 */
export const INTERNAL_SOURCES: readonly string[] = [INTERNAL_SOURCE_ACTION_DISPATCHER, INTERNAL_SOURCE_DATAPLANE_JOB_PUMP, INTERNAL_SOURCE_BACKFILL_PUMP];
/** CloudFront 回源一定会带的头(大小写不敏感)。 */
export const CLOUDFRONT_ORIGIN_HEADER = "x-amz-cf-id";
/** 系统主体(审计 actor;没有 Cognito 身份)。 */
export const INTERNAL_PRINCIPAL = { actor: "system:action-dispatcher", via: "schedule" } as const;
/** @kf-batch 50-WP9a-durable-jobs —— 推进泵的系统主体(审计 actor;没有 Cognito 身份) */
export const DATAPLANE_JOB_PUMP_PRINCIPAL = { actor: "system:dataplane-job-pump", via: "dataplane-job" } as const;
/** @kf-batch 50-B51-backfill-pump —— 补数推进泵的系统主体 */
export const BACKFILL_PUMP_PRINCIPAL = { actor: "system:backfill-pump", via: "backfill" } as const;

export type InternalPrincipal = typeof INTERNAL_PRINCIPAL | typeof DATAPLANE_JOB_PUMP_PRINCIPAL | typeof BACKFILL_PUMP_PRINCIPAL;

export type InternalVerdict =
  | { ok: true; principal: InternalPrincipal }
  | { ok: false; status: 401 | 403 | 503; reason: string };

/** 只看请求头的那两道(中间件与路由共用):经 CloudFront 进来 ⇒ 403;来源头不对 ⇒ 403。 */
export function internalSourceVerdict(headers: Headers): InternalVerdict | null {
  if (headers.get(CLOUDFRONT_ORIGIN_HEADER)) {
    return { ok: false, status: 403, reason: "内部端点不接受经 CloudFront(公网)进来的请求" };
  }
  const src = headers.get(INTERNAL_SOURCE_HEADER) ?? "";
  if (!INTERNAL_SOURCES.includes(src)) {
    return { ok: false, status: 403, reason: "未登记的内部调用来源" };
  }
  return null;
}

/** 内部端点的路径前缀(中间件据此跳过 Cognito JWT 校验、改由路由内的内部守卫鉴权)。 */
export const INTERNAL_API_PREFIX = "/api/internal/";
