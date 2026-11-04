export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { DescribeStatementCommand, GetStatementResultCommand } from "@aws-sdk/client-redshift-data";
// @kf-batch 50-WP2-directquery —— 主控区 region 的唯一出口(env 字面量只许出现在工厂/本出口)
import { maskRows } from "@/lib/governance/masking";
import { requireQueryHandle, peekHandleTargetId, HANDLE_PARAM } from "@/lib/security/query-handle";
import { recordAudit } from "@/lib/audit";
// @kf-batch 50-WP31-place-first-class
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
// @kf-batch 50-P50.3-mrquery —— 🔴 statementId 是 **region 内**的:拿 home 的客户端去 Describe
// us-west-2 的语句会永远查不到,前端就卡在「执行中」(W3-a 已被这条咬过一次)。
import { redshiftDataClientFor } from "@/lib/exec-env/target-clients";
import { regionOfTarget } from "@/lib/exec-env/data-plane-target";
import { classifyEngineError } from "@/lib/redshift/multi-region-query";
// @kf-batch 50-W5-seg2-WP10a —— 取结果行前的区域审计(落点 = handle 里的 targetId)
import { residencyAudit, residencyErrorResponse, userActor } from "@/lib/exec-env/residency-audit";

/**
 * 解析该 statement 所在 region 的客户端。
 *
 * 判据优先级:**句柄里的 `targetId`** > 显式 `?targetId=`;@kf-batch 50-WP31-place-first-class:两样都没有 / 显式值非法 ⇒ 400,
 * 目标不存在 ⇒ 照抛(原来两种都回落主控区客户端 ⇒ 漏传时到主控区去查别的区的语句)。
 * 🔴 句柄优先的意义:取结果这条路径的 region **不可被客户端操纵**(句柄是服务端签发的)。
 * 🔴 显式参数只是**状态轮询**的回落(SPEC §3.7 规定状态轮询不要求句柄);它选错 region 的
 * 唯一后果是 Describe 查不到 ⇒ 前端显示失败,**绝不会**造成"在错误的区域执行"——
 * 执行 region 在提交那一刻就定死了。
 */
async function clientForStatement(req: NextRequest) {
  const fromHandle = await peekHandleTargetId(req.nextUrl.searchParams.get(HANDLE_PARAM));
  const targetId = fromHandle || requestedTargetId(req.nextUrl.searchParams.get("targetId"), "取直查结果");
  return redshiftDataClientFor(await regionOfTarget(targetId));
}

// S0(50 SPEC §0/§3.7)— 本端点曾是**现网越权(IDOR)**:只凭 URL 里的 statementId 取结果、
// 全程无鉴权(resolveIdentity 只喂列脱敏且 .catch(()=>null))⇒ 任一登录用户知道 statementId
// 即可读他人查询结果。现在**返回结果行之前必须校验 queryHandle**(`?handleId=`)。
//
// 🔴 分档(SPEC §3.7 定稿):**状态轮询不要求 handle**(避免轮询被句柄问题打断),
// **一旦返回结果行则必须校验**。故 handle 校验放在 GetStatementResult 之前、而不是函数入口。
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  // 落点错误 ⇒ 400(不许被下面那个「一切异常都当 FAILED」的兜底吞掉)
  let client: Awaited<ReturnType<typeof clientForStatement>>;
  try {
    client = await clientForStatement(req);
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    return NextResponse.json({ status: "FAILED", error: (e as Error)?.message || String(e) }, { status: 200 });
  }
  try {
    const desc = await client.send(new DescribeStatementCommand({ Id: params.id }));

    if (desc.Status === "FINISHED") {
      // 非 SELECT 语句(CREATE/INSERT/UPDATE/DELETE/SET/GRANT 等 DDL/DML)没有结果集——
      // 此时调 GetStatementResult 会抛 ResourceNotFoundException("Query does not have result")。
      // 用 HasResultSet 判定:无结果集则返回受影响行数,不去取结果(修偶发查询报错的根因)。
      if (desc.HasResultSet === false) {
        return NextResponse.json({
          status: "FINISHED",
          columns: [],
          rows: [],
          totalRows: 0,
          resultRows: desc.ResultRows ?? 0, // 受影响行数(DML)或 -1(DDL)
          hasResultSet: false,
        });
      }

      // 🔴 S0 —— 取结果行的唯一入口,此处必须过 handle 校验(不匹配 403 / 过期 410)。
      const chk = await requireQueryHandle(req, params.id, "redshift");
      if (chk instanceof NextResponse) return chk;

      // @kf-batch 50-W5-seg2-WP10a
      // 🔴 取结果行**之前**写区域审计(entry=result;SPEC v3.23 §3.2 / E-188):落点由 **handle 里的 targetId** 决定 ——
      //    伪造 / 删掉 `x-bgp-region` 之类 header 改变不了它(句柄是服务端签发的)。home / 同法域 ⇒ null,一字不变。
      //    写不成 ⇒ 503、不返回任何结果行;缺同意 ⇒ 409(前端弹告知后重试)。
      const handleTarget = chk.handle?.targetId;
      if (handleTarget && chk.identity) {
        try {
          await residencyAudit({
            actor: userActor(chk.identity),
            targetId: handleTarget,
            entry: "result",
            statementId: params.id,
            projectId: chk.handle?.projectId,
          });
        } catch (e) {
          const r = residencyErrorResponse(e);
          if (r) return r;
          throw e;
        }
      }

      const result = await client.send(new GetStatementResultCommand({ Id: params.id }));
      const meta = result.ColumnMetadata || [];
      const columns = meta.map((c) => c.name || "");
      const rawRows = result.Records?.map((row) => row.map((cell) => Object.values(cell)[0])) || [];

      // 模块 18: server-side column masking. ColumnMetadata carries schemaName/tableName so we
      // can pinpoint each result column's table; the query text (QueryString) is a fallback.
      // Platform admins / grant holders are exempt (handled inside maskRows).
      // S0:身份复用 handle 校验已解析出的 identity,不再重复解析一次。
      const identity = chk.identity;
      const { rows, maskedColumns } = await maskRows({
        columns: meta.map((c) => ({ name: c.name, schemaName: c.schemaName, tableName: c.tableName })),
        rows: rawRows,
        sql: desc.QueryString,
        database: "dev",
        identity,
      });

      // S0 验收要求:审计留 who / statementId / 结果行数(fire-and-forget,不阻塞响应)。
      recordAudit(req, "redshift.result.read", {
        resourceType: "redshift-statement",
        resourceId: params.id,
        detail: { rowCount: rows.length, totalRows: result.TotalNumRows ?? null, projectId: chk.handle?.projectId },
      });

      return NextResponse.json({
        status: "FINISHED",
        columns,
        rows,
        totalRows: result.TotalNumRows,
        ...(maskedColumns.length ? { maskedColumns } : {}),
      });
    }

    // @kf-batch 50-P50.3-mrquery
    // 🔴 **归类由服务端做**(INTERACTION §4septies.3 的错误三段之第二段):前端只负责显示。
    // 归类是"哪类问题 + 去哪修",属业务判断,放前端会在 Athena / 问数各写一遍而漂移。
    // 匹配不上就是 `other`,而 `other` 仍然把**原始错误原文**返回 ⇒ 归类漏了只少一句建议,不吞错误。
    const cls = desc.Status === "FAILED" || desc.Status === "ABORTED" ? classifyEngineError(desc.Error) : null;
    return NextResponse.json({
      status: desc.Status,
      error: desc.Error,
      ...(cls ? { errorKind: cls.kind, errorHint: cls.hint } : {}),
    });
  } catch (err: any) {
    // 防御性:任何 Data API 异常(如结果过期 ResourceNotFound、限流)都当作可读错误返回,
    // 让前端轮询能落到 FAILED 分支停下来,而不是 500 后无限轮询卡在「执行中」。
    return NextResponse.json({ status: "FAILED", error: err?.message || String(err) }, { status: 200 });
  }
}
