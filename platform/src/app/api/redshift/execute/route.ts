export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { requireProject } from "@/lib/projects/guard";
import { readOnlySelect } from "@/lib/genbi/core/sql-guard";
import { apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
// @kf-batch 50-WP31-place-first-class
import { requestedTargets } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
// @kf-batch 50-P50.3-mrquery —— 多 region 并行提交的唯一作者(INTERACTION §4septies)。
import { submitToTargets, normalizeQueryTargets, MAX_QUERY_FANOUT } from "@/lib/redshift/multi-region-query";
// @kf-batch 50-W5-seg2-WP10a —— 同意前置(409 带文案)+ 残留错误 → 响应映射(单作者)
import { requireResidencyAckForTargets, residencyErrorResponse } from "@/lib/exec-env/residency-audit";

export async function POST(req: NextRequest) {
  // S0(50 SPEC §0/§3.7)— A 类提交点:statementId 会出站给客户端,故必须同时签发 handle,
  // 否则取回侧(result/[id])会因无 handle 而拒 = 合法查询取不到结果。
  //
  // 🔴🔴 **项目授权(2026-08-29 外部审核 P0-2 坐实)**:本端点此前**只认证不授权** ——
  // 只解析身份、然后以**共享 admin 身份执行任意 SQL**。那样 queryHandle 只能保护"怎么取结果",
  // 挡不住"未获项目授权的人先用 admin 身份读写数据、再作为 handle owner 合法取回",
  // 对外宣称"IDOR 已修死"是夸大。按 **52 SPEC:67 合同**补 `requireProject(editor)` + 审计。
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const sctx = ctx;
  const body = await req.json();
  const { sql, workgroupName, database } = body ?? {};
  if (!sql || !String(sql).trim()) return NextResponse.json({ error: "SQL 为空" }, { status: 400 });
  // 🔴 生产上线批次 A:直查以数仓 admin 身份执行 ⇒ 非平台管理员只许**只读**(单条 SELECT / WITH)。
  //   原来任何项目 editor 都能在这里 DROP / DELETE 客户的表。判定与问数同一份(readOnlySelect)。
  //   🔴 这只关掉「直查页随手执行写语句」这一条路:Redshift ETL 作业按设计要写库,项目级数据隔离要等 P52.5b。
  if (!sctx.identity.isPlatformAdmin) {
    const ro = readOnlySelect(String(sql));
    if (!ro.ok) {
      return apiError(`数仓直查对非平台管理员只允许只读查询(单条 SELECT / WITH):${ro.error}。写操作 / DDL 请联系平台管理员,或通过作业开发提交`, 403, { code: "RBAC_DENIED" });
    }
  }

  // @kf-batch 50-P50.3-mrquery
  // 🔴 **多 region**:@kf-batch 50-WP31-place-first-class —— `targets` 必须点名(缺 / 空 / 非法 ⇒ 400 PLACE_UNDECIDABLE);
  //    原来缺省 = `["tgt_home"]` ⇒ 漏传就静默在主控区数仓上执行。
  // 落点/凭证/客户端全部由 `submitToTargets` 逐 target 解析(与离线计算同一个 `resolveRedshiftBinding`),
  // 所以"手动查有数据、作业跑没数据"这类分叉不会在这里重新长出来。
  let targets: string[];
  try {
    targets = normalizeQueryTargets(requestedTargets(body, "数仓直查"));
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    throw e;
  }

  // @kf-batch 50-W5-seg2-WP10a
  // 🔴 同意前置**先判全部 target 再提交任何一个**(SPEC v3.23 §3.2):任一跨法域 target 缺同意 ⇒ 整个请求 409,
  //    响应带当前文案与版本,前端弹免责告知、同意后重试同一请求;home / 同法域 target 这里是空操作。
  //    区域审计本身在 submitOne 里逐 target 写(提交之前),写不成只拒那一个 target。
  try {
    await requireResidencyAckForTargets(sctx.identity, targets);
  } catch (e) {
    const r = residencyErrorResponse(e);
    if (r) return r;
    throw e;
  }

  let submissions;
  try {
    submissions = await submitToTargets({
      sql: String(sql),
      targets,
      projectId: sctx.projectId,
      identity: sctx.identity,
      // 🔴 只有**单区且是 home** 时才把界面填的 workgroup/database 当覆盖值传下去。
      // 多区时这两个输入框在界面上已被禁用(落点只能来自各目标的描述符);若还传下去,
      // 非 home 会被 `assertNoWarehouseConflict` 当场拒 —— 用户会看到一堆"落点冲突"而不知为何。
      workgroupOverride: targets.length === 1 && targets[0] === "tgt_home" ? workgroupName : undefined,
      databaseOverride: targets.length === 1 && targets[0] === "tgt_home" ? database : undefined,
    });
  } catch (err: any) {
    // 只有"超过扇出上限"这类**整体**性错误会走到这里;单个 target 的失败在它自己那一行。
    return NextResponse.json({ error: err?.message || String(err) }, { status: 400 });
  }

  // 52 SPEC:67 要求 recordAudit(SQL)。SQL 可能很长,截断存证;🔴 绝不记凭证。
  recordAudit(req, "redshift.execute", {
    resourceType: "redshift-statement",
    resourceId: submissions.map((s) => s.statementId).filter(Boolean).join(","),
    detail: {
      projectId: sctx.projectId,
      sql: String(sql).slice(0, 2000),
      // 逐区留痕:哪些区提交成功、哪些区**提交阶段**就被拒(排障第一手材料)
      submissions: submissions.map((s) => ({
        targetId: s.targetId, region: s.region, workgroup: s.workgroup,
        statementId: s.statementId ?? null, submitError: s.submitError ?? null,
      })),
    },
  });

  const first = submissions.find((s) => s.statementId);
  return NextResponse.json({
    // 🔴 顶层摊平第一个成功提交的 statementId/handleId —— **存量前端读的就是这两个字段**。
    // 多区结果在 `submissions` 里,新前端读它。
    statementId: first?.statementId,
    handleId: first?.handleId,
    submissions,
    // @kf-batch 50-W5-seg2-WP10a —— 跨法域 target 的区域审计 ID(SPEC §2.1:响应 += audit?: {[targetId]: auditId})
    ...(submissions.some((s) => s.auditId)
      ? { audit: Object.fromEntries(submissions.filter((s) => s.auditId).map((s) => [s.targetId, s.auditId])) }
      : {}),
    // 全部区都在提交阶段失败时,顶层也给一个 error,免得旧前端一直转
    ...(first ? {} : { error: submissions.map((s) => `${s.targetId}: ${s.submitError}`).join(" | ") }),
    maxFanout: MAX_QUERY_FANOUT,
  });
}
