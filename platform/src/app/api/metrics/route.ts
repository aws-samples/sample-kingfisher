export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { listMetrics, createMetric } from "@/lib/metrics/service";
// @kf-batch 50-WP4quater-reads(工单 SC-13)—— 🔴 指标的**值**按区解析:计算路径本来就按区跑
// (`computeMetric(metricId, scope)`),但值原来只存一份 ⇒ 在 usw2 算一次就覆盖掉主控区的值,
// 而两个数字看起来都很正常。现在值按区存(`valueByTarget`),这里按当前范围解析出「这个区的值」。
// 与建模指标(SC-37 的 `metricValueFor`)刻意保持同一形状:该区没算过回 null,**不回落别区的数字**。
import { readScope } from "@/lib/exec-env/scope";
import { scopeTargets } from "@/lib/scope/scope";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { recordAudit } from "@/lib/audit";

// 模块 20: 指标定义。GET 列表（登录可读）；POST 建（仅平台管理员）。
export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  try {
    const rows = await listMetrics();
    const scope = readScope(req);
    if (!scope) return apiOk(rows); // 未传 `?scope=` / 全局 ⇒ 与改动前逐字节相同(回滚点)
    const wanted = scopeTargets(scope);
    const resolved = rows.map((m) => {
      const map = (m as { valueByTarget?: Record<string, { value: number; computedAt: string }> }).valueByTarget;
      if (wanted.length !== 1) {
        const per = wanted.map((t) => ({ targetId: t, ...(map?.[t] ?? { value: null, computedAt: null }) }));
        return { ...m, perTarget: per, computedTargets: per.filter((x) => x.value !== null).length };
      }
      const t = wanted[0];
      if (map && Object.keys(map).length > 0) {
        const hit = map[t];
        // 🔴 该区没算过 ⇒ value=null + noValueInScope,**绝不**回落 lastValue(那是别区的数字)
        return { ...m, value: hit?.value ?? null, computedAt: hit?.computedAt ?? null, valueTargetId: t, noValueInScope: !hit };
      }
      // 落章之前算的存量行:只有 lastValue ⇒ 如实标 legacy
      return { ...m, value: m.lastValue ?? null, computedAt: m.lastComputedAt ?? null, valueTargetId: HOME_TARGET_ID, valueIsLegacy: true };
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
    const metric = await createMetric(body, identity.username);
    recordAudit(req, "metric.create", { resourceType: "metric", resourceId: metric.metricId, detail: { name: metric.name, agg: metric.agg } }).catch(() => {});
    return apiOk(metric, 201);
  } catch (e: any) {
    return apiError(e.message);
  }
}
