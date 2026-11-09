export const dynamic = "force-dynamic";
// 数据湖表桶路由 —— **只读路径**(任何登录用户可读:路由集决定作业注入的目录 / 直查表树 / 问数里会出现什么)。
//   GET ?targetId=   路由集(含隐式平台路由),处理器与管理面同一份 lib/lake/routes-api.ts#handleListRoutes
// 写(POST 登记 / PATCH|PUT 修改 / DELETE 撤销)只在管理面 /api/admin/lake-routes(网关 bgp-admin + 路由内 requireAdmin 两道门)。
// 2026-11-09:同步向导 / 作业高级属性 / 系统设置卡的读请求从管理面路径挪到这里 —— 网关对 /api/admin/** 不分读写一律要求 bgp-admin,
//   数据开发账号在向导里拿不到清单(下拉报错为空)。管理面路径的 GET 保留为别名(再导出这里的 GET),下一版删。
// 落点只经点名作者 requestedTargetId(缺 / 非法 ⇒ 400,不默认主控区);解析写在路由文件里(落点棘轮 L5 / 「服务端真读范围」判据钉这里)
import { NextRequest } from "next/server";
import { requestedTargetId } from "@/lib/place/resolve";
import { handleListRoutes, placeReject } from "@/lib/lake/routes-api";

export async function GET(req: NextRequest) {
  let tid: string;
  try { tid = requestedTargetId(req.nextUrl.searchParams.get("targetId"), "列数据湖路由"); } catch (e) { return placeReject(e); }
  return handleListRoutes(req, tid);
}
