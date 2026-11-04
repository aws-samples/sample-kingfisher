export const dynamic = "force-dynamic";
// 🔴 **改动前**:零守卫 + 注入面(52 SPEC §2 缺口B 第 8 面;台账 52 DESIGN §11.2 第 6 项)。
//
// 【两条注入路径,一次修法关掉两条】
//   ① **information_schema 探测**(原 :29):`table_schema='${schema}' AND table_name='${tableName}'`
//      两个值直接来自请求体。返回给调用方的只是 `tableExists` 布尔 ⇒ 这是一个**盲布尔注入**:
//      一位一位就能把整个 Redshift 目录枚举出来(而且**绕过任何项目边界** —— 它打的是平台 admin 身份)。
//      这条是本端点**独立的**危害。
//   ② **生成的 DDL**(原 :15):`fullName = ${schema}.${tableName}` 被拼进 `CREATE TABLE ${fullName}`,
//      而该 DDL 随后会被 `sync/execute-ddl` 用平台身份真执行。
//
// 🔴 **为什么用白名单校验而不是 SQL 参数化**:路径 ② **根本无法参数化** —— `CREATE TABLE :name`
//    不是合法 SQL,SQL 参数**不能当标识符**。而白名单(`^[A-Za-z_][A-Za-z0-9_]*$`)比转义**更强**:
//    它是"拒绝"而不是"编码",通过之后字符串里只剩 `[A-Za-z0-9_]`,拼接已经**结构上安全**。
//    ⇒ 一个 `safeIdent()` 同时关掉 ①②,不需要两套修法。
//    复用 `modeling/redshift.ts` 既有的 `safeIdent`(SPEC §3.0 明确禁止再造第 4 套 sanitize 分叉)。
//
// 🆕 生产上线批次 A(2026-10-09):列名 / 列类型白名单已在唯一作者 `lib/sync/target-ddl.ts` 里落地
//    (原登记的「execute-ddl 可直接执行任意 DDL」前提已不成立 —— 它现在只收建表参数、服务端现生成)。
//    「表已存在」探测原来把带双引号的 `"public"` 拼进 `table_schema='"public"'` ⇒ **恒为假**,
//    页面橙色标签从没亮过;现在走 `probeTables`(与 Glue 脚本守卫同一判据),并回报「是不是平台建的」。

import { NextRequest, NextResponse } from "next/server";
import { buildTargetDdl } from "@/lib/sync/target-ddl";
import { apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { safeIdent } from "@/lib/modeling/redshift";
// home-only 合同退役:存在性探测按 body 的 targetId(前端从 ds.ownerTargetId 派生)
// 在执行体里走 resolveRedshiftBinding,并带 binding 的 secretArn 执行(非 home 的 TaskRole 在该区 workgroup 没有 DB 用户)。
// 落点只认点名(缺 ⇒ 400,不默认主控区)
// 后一半:点名必须是**已注册且装好**的执行环境(不存在 ⇒ 409,不再写孤儿记录 / 回降级结果)
import { requestedRegisteredPlace } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { getCorrelationId } from "@/lib/observability/logger";
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";

// 探测主体在 lib/sync/long-ops.ts(sync-generate-ddl,只读、不占资源);数仓冷启动时探测可能排队几十秒,
//    超 45 秒由统一框架转 202,页面右下「正在后台执行:生成建表语句并探测目标表」,终态同形交回。
export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;

  const body = await req.json();
  const { redshiftConfig } = body;
  let tid: string;
  try {
    tid = (await requestedRegisteredPlace(body?.targetId, "生成建表语句")).targetId;
  } catch (e) {
    return placeErrorResponse(e) ?? apiError(String((e as Error)?.message ?? e), 400, { code: "VALIDATION_FAILED" });
  }

  // 🔴 白名单校验放在**任何拼接之前**(safeIdent + 列白名单,见 target-ddl);非法即 400,不带着它去打库。
  let spec: ReturnType<typeof buildTargetDdl>;
  try {
    safeIdent(redshiftConfig?.schema || "public");
    spec = buildTargetDdl(body);
  } catch (e) {
    return apiError(String((e as Error)?.message ?? e), 400, { code: "VALIDATION_FAILED" });
  }

  try {
    const result = await submitLongOp(
      {
        kind: "sync-generate-ddl",
        params: {
          targetId: tid,
          projectId: ctx.projectId,
          spec,
          ...(redshiftConfig?.workgroupName ? { workgroupOverride: String(redshiftConfig.workgroupName) } : {}),
          ...(redshiftConfig?.database ? { databaseOverride: String(redshiftConfig.database) } : {}),
        },
        correlationId: getCorrelationId(req),
      },
      { req, identity: ctx.identity },
    );
    return longOpResponse(req, result);
  } catch (e: any) {
    const lo = longOpErrorResponse(e);
    if (lo) return lo;
    return apiError(e.message, 500);
  }
}
