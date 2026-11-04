// 模块 55 / 序 50 第二批 —— 指标体系的长操作执行体:计算单个指标(模块 20;只读 Redshift 聚合 + 写快照)。
//
// 原路由(app/api/metrics/[id]/compute POST)的「主体」原样搬入:平台管理员鉴权 / 落点点名 **留在路由**;
// 这里只做「computeMetric(经数仓直查)→ 审计 → 回 data」。
// 🔴 为什么进长操作:指标 SQL 在真环境要跑十几秒,数仓冷启动再叠上去就撞 60s 墙;改成长操作后超 45 秒自动转 202。
//   「该区没装数仓」= 能力态:如实回、**不写审计**(一条 SQL 都没跑,写了就是台账里多一次没发生的计算)。

import { recordAudit } from "@/lib/audit";
import type { LongOpExecutor, LongOpExecutorRegistry } from "@/lib/long-ops/executor-types";
import { computeMetric } from "./service";

const metricCompute: LongOpExecutor<"metric-compute"> = async (params, ctx) => {
  const { metricId, targetId, projectId } = params;
  const out = await computeMetric(metricId, { targetId, projectId });
  if ("capability" in out) return { data: out };
  recordAudit(ctx.req, "metric.compute", { resourceType: "metric", resourceId: metricId, detail: { value: out.value, targetId } }).catch(() => {});
  return { data: { capability: "available" as const, ...out } };
};

export type MetricsLongOpKind = "metric-compute";
export const METRICS_LONG_OP_EXECUTORS: Pick<LongOpExecutorRegistry, MetricsLongOpKind> = {
  "metric-compute": metricCompute,
};
