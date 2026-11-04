export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
// 落点只认点名(缺 ⇒ 400,不默认主控区)
import { requestedTargetId } from "@/lib/place/resolve";
import { requireProject } from "@/lib/projects/guard";
import { getResults, resolveAthenaPlace } from "@/lib/athena/client";
import { requireQueryHandle } from "@/lib/security/query-handle";
import { recordAudit } from "@/lib/audit";

// 取查询结果（columns + rows，支持 nextToken 分页）。RBAC: viewer。
//
// S0(50 SPEC §0/§3.7)— 本端点原先只有 `requireProject(viewer)`,**不校验该 queryExecutionId
// 是否属于本项目** ⇒ 与 redshift/result/[id] 同构的跨项目越权(拿到别的项目的执行 id 即可取行)。
// 现在必须同时过 queryHandle 校验:handle 记录了该 id 的 ownerSub + projectId。
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  // 🔴 本端点**只返回结果行**(无状态轮询分支),故校验放在函数入口。
  const chk = await requireQueryHandle(req, params.id, "athena");
  if (chk instanceof NextResponse) return chk;
  const nextToken = req.nextUrl.searchParams.get("nextToken") || undefined;
  try {
    const place = await resolveAthenaPlace(requestedTargetId(req.nextUrl.searchParams.get("targetId"), "取 Athena 结果"));
    const results = await getResults(params.id, 1000, nextToken, place.region);
    recordAudit(req, "athena.result.read", {
      resourceType: "athena-query",
      resourceId: params.id,
      detail: { rowCount: Array.isArray((results as any)?.rows) ? (results as any).rows.length : null, projectId: chk.handle?.projectId },
    });
    return NextResponse.json(results);
  } catch (err: any) {
    // 本路由沿用自己的信封;落点拒因带上 code(PLACE_UNDECIDABLE)让前端 / 判据分得清
    return NextResponse.json({ error: err.message || String(err), ...(err?.code ? { code: err.code } : {}) }, { status: 400 });
  }
}
