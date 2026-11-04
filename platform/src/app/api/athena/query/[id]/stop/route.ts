export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
// @kf-batch 50-WP31-place-first-class —— 落点只认点名(缺 ⇒ 400,不默认主控区)
import { requestedTargetId } from "@/lib/place/resolve";
import { requireProject } from "@/lib/projects/guard";
import { stopQuery, resolveAthenaPlace } from "@/lib/athena/client";
import { requireQueryHandle } from "@/lib/security/query-handle";
import { recordAudit } from "@/lib/audit";

// 取消正在执行的查询。
//
// S0(50 SPEC §0/§3.7)— 本端点原先只有 `requireProject(viewer)`,**不校验该 queryExecutionId
// 是否由调用者发起**:注释写着"取消自己发起的只读查询",但没有任何东西强制"自己发起的"
// ⇒ 任一项目 viewer 可停他人(乃至他项目)的查询 = 与 `redshift/cancel` 同构的越权。
// 按 §3.7 对 cancel 的定案同样处理:**按 handle 归属判**;无 handle 的存量语句走 editor 兜底 + 审计。
//
// 🔴 本端点不在 SPEC §3.7 原枚举里(那里只列了 redshift/cancel),是 S0 施工时扫调用方扫出来的,
// 已回灌 SPEC。
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;

  // 🔴🔴 **legacy 兜底已删除(2026-08-29 外部审核 P0-1)**:与 `redshift/cancel` 同一个绕过 ——
  // 原实现按"客户端是否带 handleId"分叉,主动省略即落 editor 兜底,任何项目 editor 照样能停他人查询。
  // 定案:handle 无条件必需(理由与代价见 redshift/cancel 的注释)。
  const chk = await requireQueryHandle(req, params.id, "athena");
  if (chk instanceof NextResponse) return chk;

  try {
    // @kf-batch 50-WP4ter-coverage
    const place = await resolveAthenaPlace(requestedTargetId(req.nextUrl.searchParams.get("targetId"), "停止 Athena 查询"));
    await stopQuery(params.id, place.region);
    recordAudit(req, "athena.stop", { resourceType: "athena-query", resourceId: params.id });
    return NextResponse.json({ stopped: true });
  } catch (err: any) {
    // 本路由沿用自己的信封;落点拒因带上 code(PLACE_UNDECIDABLE)让前端 / 判据分得清
    return NextResponse.json({ error: err.message || String(err), ...(err?.code ? { code: err.code } : {}) }, { status: 400 });
  }
}
