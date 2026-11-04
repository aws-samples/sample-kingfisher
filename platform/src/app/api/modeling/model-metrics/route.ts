export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { listModelMetrics, createModelMetric, metricValueFor } from "@/lib/modeling/model-metrics";
// @kf-batch 50-WP4quater-reads(工单 SC-37)—— 🔴 指标**有计算值**,而值是从某个区的数仓算出来的。
// 单区视角必须给**那个区的**值;该区没算过就如实回「这个区还没算过」,而不是把别区的数字端出来。
import { readScope } from "@/lib/exec-env/scope";
import { scopeTargets } from "@/lib/scope/scope";
import { recordAudit } from "@/lib/audit";

// 模块 35 P1 D4: 指标体系(原子/派生)。GET 列表(登录可读);POST 建(仅平台管理员)。
export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  try {
    const rows = await listModelMetrics();
    const scope = readScope(req);
    if (!scope) return apiOk(rows); // 未传 `?scope=` / 全局 ⇒ 与改动前逐字节相同(回滚点)
    const wanted = scopeTargets(scope);
    // 🔴 单区视角:把 `value` / `computedAt` 解析成**那个区**的;多区分组:给出各区都算过没有的摘要。
    //    绝不在这里做「取第一个有值的区」这类兜底 —— 那就是把某个区的数字冒充成当前范围的。
    const resolved = rows.map((m) => {
      if (wanted.length === 1) {
        const v = metricValueFor(m, wanted[0]);
        return {
          ...m,
          value: v?.value ?? null,
          computedAt: v?.computedAt ?? null,
          valueTargetId: wanted[0],
          valueIsLegacy: v?.legacy ?? false,
          noValueInScope: v === null,
        };
      }
      const per = wanted.map((t) => ({ targetId: t, ...(metricValueFor(m, t) ?? { value: null, computedAt: null, legacy: false }) }));
      return { ...m, perTarget: per, computedTargets: per.filter((x) => x.value !== null).length, scopeTargetCount: wanted.length };
    });
    return apiOk(resolved);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可管理指标", 403);
  const body = await req.json().catch(() => ({}));
  try {
    const m = await createModelMetric(body, identity.username);
    recordAudit(req, "modeling.metric.create", { resourceType: "model-metric", resourceId: m.modelMetricId, detail: { name: m.name, metricType: m.metricType } }).catch(() => {});
    return apiOk(m, 201);
  } catch (e: any) {
    return apiError(e.message);
  }
}
