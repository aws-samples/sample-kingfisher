export const dynamic = "force-dynamic";
// 序 38 B-71 —— 执行环境的外部 S3 Tables 表桶登记(平台管理员)。
//   GET    ?targetId=   已登记清单(任何登录用户可看:它决定表树 / 目录 / 问数里会出现什么)
//   POST   { targetId, bucket, label? }   登记(核名字 / 不是平台表桶 / 该区真有)
//   DELETE ?targetId=&bucket=            撤销登记(只删登记行,表桶一个不碰)
// @kf-batch 50-WP31-place-first-class —— 落点只经点名作者 requestedTargetId(缺 / 非法 ⇒ 400,不默认主控区)
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { recordAudit } from "@/lib/audit";
import {
  listExternalTableBuckets, registerExternalTableBucket, unregisterExternalTableBucket, ExternalTableBucketError,
} from "@/lib/lake/external-table-buckets";

async function requireLakeAdmin(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效,请重新登录", 401, { code: "UNAUTHENTICATED" });
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员(bgp-admin)可登记 / 撤销数据湖外部表桶", 403, { code: "RBAC_DENIED" });
  return identity;
}

/** 点名作者抛的落点错 ⇒ 400 响应(PLACE_UNDECIDABLE 等 code 原样);别的错也 400。 */
function placeReject(e: unknown): Response {
  const pr = placeErrorResponse(e);
  if (pr) return pr;
  return apiError(String((e as Error)?.message || e), 400, { code: "VALIDATION_FAILED" });
}

export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效,请重新登录", 401, { code: "UNAUTHENTICATED" });
  let tid: string;
  try { tid = requestedTargetId(req.nextUrl.searchParams.get("targetId"), "列数据湖外部表桶"); } catch (e) { return placeReject(e); }
  try {
    return apiOk(await listExternalTableBuckets(tid));
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

export async function POST(req: NextRequest) {
  const admin = await requireLakeAdmin(req);
  if (admin instanceof Response) return admin;
  const body = await req.json().catch(() => ({}));
  let tid: string;
  try { tid = requestedTargetId(typeof body?.targetId === "string" ? body.targetId : null, "登记数据湖外部表桶"); } catch (e) { return placeReject(e); }
  try {
    const row = await registerExternalTableBucket({ targetId: tid, bucket: body?.bucket, label: body?.label, addedBy: admin.username });
    recordAudit(req, "lake.external-bucket.register", { resourceType: "s3-table-bucket", resourceId: row.bucket, detail: { targetId: row.targetId, region: row.region } }).catch(() => {});
    return apiOk(row, 201);
  } catch (e: any) {
    if (e instanceof ExternalTableBucketError) return apiError(e.message, e.status, { code: e.status === 409 ? "CONFLICT" : e.status === 404 ? "NOT_FOUND" : "VALIDATION_FAILED" });
    return apiError(String(e?.message || e), 500);
  }
}

export async function DELETE(req: NextRequest) {
  const admin = await requireLakeAdmin(req);
  if (admin instanceof Response) return admin;
  let tid: string;
  try { tid = requestedTargetId(req.nextUrl.searchParams.get("targetId"), "撤销数据湖外部表桶登记"); } catch (e) { return placeReject(e); }
  try {
    const removed = await unregisterExternalTableBucket(tid, req.nextUrl.searchParams.get("bucket"));
    if (!removed) return apiError("这个表桶没有在该执行环境登记过", 404, { code: "NOT_FOUND" });
    recordAudit(req, "lake.external-bucket.unregister", { resourceType: "s3-table-bucket", resourceId: String(req.nextUrl.searchParams.get("bucket")), detail: { targetId: tid } }).catch(() => {});
    return apiOk({ removed: true });
  } catch (e: any) {
    if (e instanceof ExternalTableBucketError) return apiError(e.message, e.status, { code: "VALIDATION_FAILED" });
    return apiError(String(e?.message || e), 500);
  }
}
