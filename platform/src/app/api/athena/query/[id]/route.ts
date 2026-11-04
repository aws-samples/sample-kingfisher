export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
// @kf-batch 50-WP31-place-first-class —— 落点只认点名(缺 ⇒ 400,不默认主控区)
import { requestedTargetId } from "@/lib/place/resolve";
import { requireProject } from "@/lib/projects/guard";
import { getExecution, resolveAthenaPlace } from "@/lib/athena/client";

// 查询执行状态 + 统计（扫描字节 / 耗时）。RBAC: viewer。
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  try {
    // @kf-batch 50-WP4ter-coverage —— 打到发起它的那个区(缺省主控区,现网行为不变)
    const place = await resolveAthenaPlace(requestedTargetId(req.nextUrl.searchParams.get("targetId"), "查 Athena 查询状态"));
    const status = await getExecution(params.id, place.region);
    return NextResponse.json(status);
  } catch (err: any) {
    // 本路由沿用自己的信封;落点拒因带上 code(PLACE_UNDECIDABLE)让前端 / 判据分得清
    return NextResponse.json({ error: err.message || String(err), ...(err?.code ? { code: err.code } : {}) }, { status: 400 });
  }
}
