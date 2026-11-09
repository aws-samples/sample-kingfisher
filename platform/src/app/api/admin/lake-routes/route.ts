export const dynamic = "force-dynamic";
// 数据湖表桶路由—— 执行环境的数据湖表桶**路由表**(设计稿 §6.10;规范路径)。
//   GET    ?targetId=                                  路由集 —— **别名**:规范只读路径是 /api/lake-routes(网关对 /api/admin/** 要求 bgp-admin,页面读请求不再走这里)
//   POST   { targetId, bucket, alias?, tier?, writable?, namespaces?, label? }   登记(平台管理员)
//   PATCH  { targetId, bucket, alias?, tier?, writable?, namespaces?, label?, confirmAliasChange? }   修改(PUT 同义;平台管理员)
//   DELETE ?targetId=&bucket=                          撤销(只删路由行,表桶一个不碰;仍被引用 ⇒ 409 CONFLICT 列出引用)
// 兼容别名 /api/admin/lake-buckets 保留一个版本(D9),同一份处理器 lib/lake/routes-api.ts。
// 落点只经点名作者 requestedTargetId(缺 / 非法 ⇒ 400,不默认主控区);解析写在路由文件里(落点棘轮 L5 / 「服务端真读范围」判据钉这里)
import { NextRequest } from "next/server";
import { requestedTargetId } from "@/lib/place/resolve";
import { handleRegisterRoute, handleRevokeRoute, handleUpdateRoute, placeReject, readJsonBody } from "@/lib/lake/routes-api";

// 读:别名 —— 实现在只读路径 app/api/lake-routes/route.ts(2026-11-09 挪出管理面;本别名保留一版,下一版删)。
export { GET } from "@/app/api/lake-routes/route";

export async function POST(req: NextRequest) {
  const body = await readJsonBody(req);
  let tid: string;
  try { tid = requestedTargetId(typeof body.targetId === "string" ? body.targetId : null, "登记数据湖路由"); } catch (e) { return placeReject(e); }
  return handleRegisterRoute(req, { tid, body });
}

async function update(req: NextRequest) {
  const body = await readJsonBody(req);
  let tid: string;
  try { tid = requestedTargetId(typeof body.targetId === "string" ? body.targetId : null, "修改数据湖路由"); } catch (e) { return placeReject(e); }
  return handleUpdateRoute(req, { tid, body });
}

export async function PATCH(req: NextRequest) {
  return update(req);
}

export async function PUT(req: NextRequest) {
  return update(req);
}

export async function DELETE(req: NextRequest) {
  let tid: string;
  try { tid = requestedTargetId(req.nextUrl.searchParams.get("targetId"), "撤销数据湖路由"); } catch (e) { return placeReject(e); }
  return handleRevokeRoute(req, { tid, bucket: req.nextUrl.searchParams.get("bucket") });
}
