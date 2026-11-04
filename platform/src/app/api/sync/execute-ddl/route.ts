export const dynamic = "force-dynamic";
// 🔴 **L1 的消根因那一刀**(52 DESIGN §11.6 定案;SPEC §3.5 的"6 处 TO PUBLIC 全撤"靠这一刀才成立)。
//
// 【为什么本文件是根因】改动前这里 `ExecuteStatementCommand` **不带 SecretArn** ⇒ 以调用方的
// IAM 身份(平台 ECS TaskRole)建表;而 Glue 同步作业(`glue-script-generator:339/421`)**优先用
// admin secret**、平台其它 16 处读路径也用 admin secret ⇒ **向导建的表与所有人都不同 owner**。
// 于是当年打了个省事补丁:建完表顺手把它**授权给 PUBLIC**(注释 SYNC-FIX(B4))——
// 那正是 52 要撤的 8 处授权之一,**它把每一张向导预建的表对库内所有身份放开**。
//
// 【为什么不是"把 GRANT 改窄到具体身份"】真环境 `pg_user` 实测只有 `IAMR:cdk-hnb659fds-cfn-exec-role-…`
// / `admin` / `rdsdb` 三个用户 —— 平台 TaskRole 与 `bgp-glue-role` **根本没有 DB 用户**
// (Redshift 的 `IAM:*`/`IAMR:*` 用户首次连接才惰性创建),而且用户名里**嵌着账号号**,
// 换账号就变 ⇒ 写进 SQL 又是一处"部署时快照"反模式。详见 52 DESIGN §11.6③。
//
// 【定案】本文件也用 **同一个 admin secret** 执行 DDL ⇒ 平台建的表与 Glue 建的表同 owner ⇒
// 身份错配从此不存在 ⇒ `TO PUBLIC` 可以**真删**(不是换个窄一点的授权对象)。
// 🔴 这是**收窄而不是提权**:平台早已在 16 处消费这同一个 secret,execute-ddl 不用它才是那个例外;
//    本笔只是把例外拉回既有形态,因此 L3(5b)把那 16 处换成 per-project 凭证时
//    **一次收窄就全覆盖,不会留下这个尾巴**。
import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
// home-only 合同退役:向导预建表按 body 的 targetId(前端从 ds.ownerTargetId 派生)
// 在执行体里走 resolveRedshiftBinding,区/workgroup/库/凭证四样一起来(home 逐字节等价)。
// 落点只认点名(缺 ⇒ 400,不默认主控区)
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { buildTargetDdl } from "@/lib/sync/target-ddl";
import { getCorrelationId } from "@/lib/observability/logger";
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";

// 🔴 生产上线批次 A(2026-10-09):本端点**不再接收客户端传来的 SQL**。
//   原来它以数仓 admin 身份执行请求体里的任意 `ddl` ⇒ 任何 editor 都能借它 DROP / DELETE 客户的表。
//   向导唯一的用途是「按预览建目标表」⇒ 现在只收建表参数(与 generate-ddl 同一份),服务端用唯一作者
//   `buildTargetDdl` 现生成那一条 CREATE TABLE IF NOT EXISTS 并执行,建成后打平台标记
//   (同步覆盖守卫据此认出「这是平台建的表」,见 lib/sync/target-table-guard.ts)。
// 建表主体(解析绑定 → 探测 → 建表 → 打标记,经 awaitTerminal 等终态)在 lib/sync/long-ops.ts(sync-execute-ddl)。
//   原来这里的 waitStatement 只等 15 秒就回 504「未打平台标记」;现在建表语句等到 120 秒,超 45 秒由统一框架转 202,
//   页面右下「正在后台执行:按预览建目标表」。对象租约 `table:<区>:<schema.table>`:同一张表同时建两次 ⇒ 第二次 409。
export async function POST(req: NextRequest) {
  const sctx = await requireProject(req, "editor");
  if (sctx instanceof NextResponse) return sctx;
  const body = await req.json();
  let tid: string;
  try {
    tid = requestedTargetId(body?.targetId, "执行建表语句");
  } catch (e) {
    return placeErrorResponse(e) ?? apiError(String((e as Error)?.message ?? e), 400, { code: "VALIDATION_FAILED" });
  }
  if (body?.ddl !== undefined) {
    return apiError("本接口不再接收 SQL 文本:请传建表参数(tableName / columns / sourceDb / redshiftConfig),由服务端生成建表语句", 400, { code: "VALIDATION_FAILED" });
  }
  let spec: ReturnType<typeof buildTargetDdl>;
  try {
    spec = buildTargetDdl(body);
  } catch (e) {
    return apiError(String((e as Error)?.message ?? e), 400, { code: "VALIDATION_FAILED" });
  }
  try {
    const result = await submitLongOp(
      {
        kind: "sync-execute-ddl",
        params: {
          targetId: tid,
          projectId: sctx.projectId,
          spec,
          ...(body?.redshiftConfig?.workgroupName ? { workgroupOverride: String(body.redshiftConfig.workgroupName) } : {}),
          ...(body?.redshiftConfig?.database ? { databaseOverride: String(body.redshiftConfig.database) } : {}),
        },
        correlationId: getCorrelationId(req),
      },
      { req, identity: sctx.identity },
    );
    return longOpResponse(req, result);
  } catch (e: any) {
    const lo = longOpErrorResponse(e);
    if (lo) return lo;
    return apiError(e.message, 500);
  }
}
