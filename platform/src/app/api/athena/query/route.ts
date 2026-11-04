export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
// 落点只认点名(缺 ⇒ 400,不默认主控区)
import { requestedTargetId } from "@/lib/place/resolve";
import { requireProject } from "@/lib/projects/guard";
import { sanitizeReadOnly } from "@/lib/athena/sql-guard";
import { startQuery, resolveAthenaPlace } from "@/lib/athena/client";
import { issueHandle } from "@/lib/security/query-handle";

const MAX_ROWS = 1000;

// 启动一条只读 Athena 查询（查 S3 Tables）。RBAC: 项目 viewer 即可（统一只读）。
export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;

  // 执行落点只来自 **body.targetId**
  // (SPEC §2.6.3:写/执行路由不读 `?scope=` —— 地址栏是视图状态,不该决定在哪个区真跑)。
  const body = await req.json().catch(() => ({} as { sql?: string; targetId?: unknown }));
  const sql: string = body?.sql || "";
  const guard = sanitizeReadOnly(sql || "", MAX_ROWS);
  if (!guard.ok || !guard.sql) {
    return NextResponse.json({ error: guard.error || "无效查询" }, { status: 400 });
  }

  try {
    const place = await resolveAthenaPlace(requestedTargetId(body?.targetId, "Athena 查询"));
    const queryExecutionId = await startQuery(guard.sql, undefined, place);
    // S0(50 SPEC §0/§3.7)— A 类提交点:queryExecutionId 出站,故同时签发 handle。
    // 归属用本请求的 ctx(requireProject 已解析),不另解析一遍身份。
    const handleId = await issueHandle({
      statementId: queryExecutionId,
      identity: ctx.identity,
      projectId: ctx.projectId,
      engine: "athena",
    });
    // 🔴 把落点回给前端:后续取状态 / 取结果 / 取消**必须打到同一个区**
    // (QueryExecutionId 只在它自己的 region 里存在,打错区的症状是「永远查不到状态」)。
    return NextResponse.json({ queryExecutionId, handleId, targetId: place.targetId, region: place.region });
  } catch (err: any) {
    // 本路由沿用自己的信封;落点拒因带上 code(PLACE_UNDECIDABLE)让前端 / 判据分得清
    return NextResponse.json({ error: err.message || String(err), ...(err?.code ? { code: err.code } : {}) }, { status: 400 });
  }
}
