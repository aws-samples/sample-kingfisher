export const dynamic = "force-dynamic";
// 执行环境的外部 S3 Tables 表桶登记(平台管理员)。
// 数据湖表桶路由(2026-11-04)—— 本路径从此只是 **/api/admin/lake-routes 的兼容别名**,保留一个版本:
//   GET    ?targetId=              外部路由数组(新字段 alias / tier / writable / namespaces 一起带;不含隐式平台路由 —— 与改动前同形)
//   POST   { targetId, bucket, label? }   登记:别名按桶名派生、分层 other、可写(想指定别名 / 分层 / 归属请用 /api/admin/lake-routes)
//   DELETE ?targetId=&bucket=      撤销(只删路由行,表桶一个不碰;仍被引用 ⇒ 409 CONFLICT)
// 同一份处理器 lib/lake/routes-api.ts;落点只经点名作者 requestedTargetId(缺 / 非法 ⇒ 400,不默认主控区),解析写在路由文件里。
import { NextRequest } from "next/server";
import { requestedTargetId } from "@/lib/place/resolve";
import { handleListExternalBuckets, handleRegisterRoute, handleRevokeRoute, placeReject, readJsonBody } from "@/lib/lake/routes-api";

export async function GET(req: NextRequest) {
  let tid: string;
  try { tid = requestedTargetId(req.nextUrl.searchParams.get("targetId"), "列数据湖外部表桶"); } catch (e) { return placeReject(e); }
  return handleListExternalBuckets(req, tid);
}

export async function POST(req: NextRequest) {
  const body = await readJsonBody(req);
  let tid: string;
  try { tid = requestedTargetId(typeof body.targetId === "string" ? body.targetId : null, "登记数据湖外部表桶"); } catch (e) { return placeReject(e); }
  return handleRegisterRoute(req, { tid, body, compat: true });
}

export async function DELETE(req: NextRequest) {
  let tid: string;
  try { tid = requestedTargetId(req.nextUrl.searchParams.get("targetId"), "撤销数据湖外部表桶登记"); } catch (e) { return placeReject(e); }
  return handleRevokeRoute(req, { tid, bucket: req.nextUrl.searchParams.get("bucket") });
}
