// 字段配置器的 schema 探查:GET /api/bi/schema?engine=redshift|athena
// 复用现有只读纯函数 introspectSchema(Redshift)/ introspectS3Tables(Athena),返回表+列(带类型)。
// viewer 权限;只读、不写库、不扩权。字段配置器据此列出可选表/字段(白名单来源)。
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { introspectSchema } from "@/lib/genbi/schema";
import { introspectS3Tables, S3TABLES_NAMESPACE } from "@/lib/genbi/athena";
import { GENBI } from "@/lib/genbi/config";

export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const engine = req.nextUrl.searchParams.get("engine") === "athena" ? "athena" : "redshift";
  // 字段配置器的**可选表清单**必须来自那个区
  // (否则用户在 us-west-2 拖出一张主控区才有的表,保存后一跑就报「表不存在」)。
  // 读路由,但这里点名的是「去哪个区取结构」⇒ 与 `/redshift` 左侧树同款用 `?targetId=`。
  // 落点只认点名(缺 ⇒ 400);主控区也走描述符解析,不再拿 GENBI.workgroup 顶
  let targetId: string;
  try {
    targetId = requestedTargetId(req.nextUrl.searchParams.get("targetId"), "取表结构");
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    throw e;
  }
  try {
    const tables =
      engine === "athena"
        ? await introspectS3Tables(S3TABLES_NAMESPACE, { targetId })
        : // 工作组 / 库一律由落点作者解析(主控区解析出的就是 GENBI 那对 —— 同源 homeWorkgroup / homeDatabase)
          await introspectSchema("", "", { targetId, project: ctx.projectId });
    // 返回统一结构 { schema, table, columns:[{name,type}] };字段配置器直接消费。
    return apiOk({ engine, tables });
  } catch (e: any) {
    return apiError(e?.message || "获取数据表结构失败", 502, { code: "UPSTREAM_ERROR" });
  }
}
