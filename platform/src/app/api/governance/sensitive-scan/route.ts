export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { runSensitiveScan, getScan, getLatestScan } from "@/lib/governance/sensitive/scan";
import { recordAudit } from "@/lib/audit";
// @kf-batch 50-WP2-directquery —— 执行目标从 **body** 来,不从 `?scope=`(50 SPEC §2.6.3)
import { getActiveProjectId } from "@/lib/projects/guard";
// @kf-batch 50-WP31-place-first-class
import { requestedTargetId, placeOfRequest } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";

// 模块 36 (E5): 敏感数据识别扫描。
//   GET   ?scanId=<id>  → 该次扫描结果；无参 → 最近一次扫描 summary+findings（登录可读）
//   POST  {database?, schema?, tables?}  → 跑扫描（仅平台管理员），只产建议不改分级

export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  const scanId = req.nextUrl.searchParams.get("scanId");
  try {
    if (scanId) {
      const result = await getScan(scanId);
      return apiOk(result || { summary: null, findings: [], errors: [] });
    }
    // @kf-batch 50-WP28-platform-action-node —— 🔴 「最近一次」必须**按区**:落点只认视角(读路由,`?scope=`)。
    //   视角是「全部」/ 对比 ⇒ PlaceUndecidable(400),不默认主控区 —— 原来全表取最新会把别的区的结果给你看。
    const ref = placeOfRequest(req);
    if (ref.kind !== "target") return apiError("「最近一次扫描」要先选一个执行环境", 400, { code: "VALIDATION_FAILED" });
    const result = await getLatestScan({ targetId: ref.targetId });
    return apiOk(result || { summary: null, findings: [], errors: [] });
  } catch (e: any) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    return apiError(e.message, 500);
  }
}

export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可运行敏感扫描", 403);
  const body = await req.json().catch(() => ({}));
  try {
    const result = await runSensitiveScan({
      database: body?.database,
      schema: body?.schema,
      tables: Array.isArray(body?.tables) ? body.tables : undefined,
      scannedBy: identity.username,
      scope: {
        // @kf-batch 50-WP31-place-first-class —— 🔴 落点必须点名(缺 / 非法 ⇒ 400,不再「没给 = 主控区」)
        targetId: requestedTargetId(body?.targetId, "敏感数据扫描"),
        projectId: getActiveProjectId(req),
      },
    });
    // 「该区没装数仓」= 能力态:如实回、**不写审计**(一张表都没扫)
    if ("capability" in result) return apiOk(result);
    recordAudit(req, "sensitive.scan", {
      resourceType: "sensitive-scan",
      resourceId: result.summary.scanId,
      detail: {
        database: result.summary.database,
        tablesScanned: result.summary.tablesScanned,
        findingsHigh: result.summary.findingsHigh,
        findingsMed: result.summary.findingsMed,
      },
    }).catch(() => {});
    return apiOk({ capability: "available" as const, ...result });
  } catch (e: any) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    return apiError(e.message, 500);
  }
}
