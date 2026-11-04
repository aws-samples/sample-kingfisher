export const dynamic = "force-dynamic";
// SQL 编辑器的执行历史(52 SPEC §2 缺口B 第 11 面:`redshift/history` —— 全平台共享 SQL 历史)。
//
// 🔴 **改动前的真实状态**(2026-09-03 逐行实测,比 SPEC 的描述更糟;台账 52 DESIGN §11.2 第 2 项):
//   · `GET` **连 `req` 参数都不收** ⇒ 端点内**没有任何鉴权的可能性**(middleware 只验 JWT);
//   · `userId` 是硬编码常量 `"default-user"`,读写都用它 ⇒ **全平台共用同一条历史**。
//   ⇒ 任一登录用户能读到**所有人执行过的 SQL**(表名、字段名、业务逻辑、甚至 WHERE 里的具体值),
//     还能往里写脏数据污染别人的历史。这不是"看不到别人的表",这是**直接读到别人的查询意图**。
//
// 🔴 **为什么不改分区键**:`userId = "default-user"` 是 `identity.ts` 里明确登记的
//   `LEGACY_PARTITION` —— 全平台**零迁移**约定(资源表仍按该常量分区,归属信息放
//   `projectId` / `createdBy` **属性**里)。改 pk 是破坏性键变更、会让存量历史整体失联,
//   与本批"纯安全修复、零数据迁移"的性质冲突。⇒ **加属性 + 读侧过滤**,pk 一个字不动。
//
// 🔴 **DDB 的 Limit×FilterExpression 陷阱(必须处理,否则修出一个新 bug)**:
//   DDB 先按 `Limit` 取页、**再**套 `FilterExpression`。历史是全平台混在一个分区里的,
//   若只写 `Limit: 100` + 项目过滤,非默认项目很可能"取到的 100 条全是别人的" ⇒ **返回 0 条**,
//   用户看到"历史空了"而其实数据都在。⇒ 必须**翻页累计到目标条数**(有页数上限,不无限翻)。
//   同一条纪律见 `exec-env/registry.ts:queryAllPages`(单页就返回 = 静默漏数据)。
import { NextRequest } from "next/server";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@/lib/aws/dynamodb";
import { apiOk } from "@/lib/api-response";
import { NextResponse } from "next/server";
import { ulid } from "ulid";
import { requireProject, projectFilter } from "@/lib/projects/guard";
// 执行历史按执行范围过滤。
// 行上**本来就有** `targetId`(POST 时从 body 盖的章),此前只是读侧没人用它 ⇒ 单区视角也会看到
// 别的区跑过的语句。🔴 过滤必须放在**翻页循环之内累计**:DDB 是先 Limit 取页、再套 FilterExpression,
// 过滤完直接返回会把「最近 100 条」变成「最近 100 条里恰好属于这个区的那几条」= 静默截断
// (与本文件头那条 Limit×Filter 纪律同一个坑,只是维度换成了区)。
import { readScope, scopeFilter } from "@/lib/exec-env/scope";
import { LEGACY_PARTITION } from "@/lib/auth/identity";
// 跨法域 target 的 SQL 原文留区
import { apiError } from "@/lib/api-response";
import { getTargetRaw } from "@/lib/exec-env/registry";
import { isHome } from "@/lib/exec-env/target-id";
// 后一半:点名必须是**已注册且装好**的执行环境(不存在 ⇒ 409,不再写孤儿记录 / 回降级结果)
import { requestedRegisteredPlace } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { isCrossJurisdiction, jurisdictionOf } from "@/lib/exec-env/residency";
import { putRegionSqlHistory } from "@/lib/exec-env/residency-store";

const TABLE = "bgp-sql-history";
/** 🔴 分区键沿用平台零迁移约定(见文件头);归属在 `projectId` / `createdBy` 属性上。 */
const USER_ID = LEGACY_PARTITION;
/** 返回给页面的条数(与改动前一致,不悄悄改变行为)。 */
const WANT = 100;
/** 翻页上限:纯防御。打到上限说明该分区里本项目的历史极稀疏,宁可少给也不无限扫。 */
const MAX_PAGES = 10;

export async function GET(req: NextRequest) {
  // 🔴 读历史 = 读别人的查询意图 ⇒ 至少要求是本项目成员(viewer)。
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;

  const { clause, values } = projectFilter(ctx.projectId);
  // 🔴 `readScope` 回 null(未传 `?scope=` / 全局)⇒ `sf` 为 null ⇒ 表达式与改动前**逐字节相同**(回滚点)。
  const scope = readScope(req);
  const sf = scope ? scopeFilter(scope, "sqlHistory") : null;
  const filterExpr = sf ? `(${clause}) AND (${sf.clause})` : clause;
  try {
    const items: Record<string, unknown>[] = [];
    let startKey: Record<string, unknown> | undefined;
    for (let page = 0; page < MAX_PAGES && items.length < WANT; page++) {
      const r = await docClient.send(
        new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: "userId = :uid",
          // 🔴 legacy 兜底只在**默认工作区**成立(projectFilter 内部判定):存量历史没有
          //    `projectId` 属性,默认工作区仍看得到;非默认项目则严格按 projectId 过滤。
          FilterExpression: filterExpr,
          ...(sf ? { ExpressionAttributeNames: sf.names } : {}),
          ExpressionAttributeValues: { ":uid": USER_ID, ...values, ...(sf ? sf.values : {}) },
          ScanIndexForward: false,
          // 每页多取一些,补偿"过滤在 Limit 之后"造成的损耗
          Limit: WANT * 3,
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        })
      );
      items.push(...((r.Items as Record<string, unknown>[] | undefined) ?? []));
      startKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
      if (!startKey) break; // 分区扫完了
    }
    return apiOk(items.slice(0, WANT));
  } catch {
    // 表不存在/首次使用 ⇒ 空列表(与改动前行为一致,不把"没历史"变成报错)
    return apiOk([]);
  }
}

export async function POST(req: NextRequest) {
  // 🔴 写自己的历史用 viewer 而不是 editor:能看数据的人就会产生查询历史。
  //    用 editor 会让 viewer 的历史**静默丢失**(下面的 catch 会把 403 吞掉)——
  //    "写不进去也不报错"是最难查的一类,守卫不该制造它。
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;

  const body = await req.json();
  const { sql, status, duration, rowCount, error } = body ?? {};
  // 🔴 每条历史必须点名在哪个区跑的(缺 / 非法 ⇒ 400)。原来缺就**不盖章**
  //    ⇒ 读侧归主控区;非法值还会原样写进权威字段。
  let tid: string;
  try {
    tid = (await requestedRegisteredPlace(body?.targetId, "写直查历史")).targetId;
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    throw e;
  }
  const historyId = ulid();
  const createdAt = new Date().toISOString();

  // 🔴 **跨法域 target 的 SQL 原文留区**(SPEC v3.23 §3.2):中央 `bgp-sql-history` 行**不存 sql**,只存指针
  //    `{residency:"region", sqlAvailable:"on-demand", region, jurisdiction, sqlRef}`;原文写进该 target 的区域结果表
  //    (`bgp-region-results-<slug>`,pk=<projectId>#<targetId>,sk=sql-history#<ts>#<historyId>)。
  //    区域表写不成 ⇒ **503、中央也不写**(不许「中央有行、原文丢了」这种半截状态)。home / 同法域行**逐字节不变**。
  let sqlForCentral: unknown = sql;
  let residencyFields: Record<string, unknown> = {};
  if (!isHome(tid)) {
    const t = await getTargetRaw(tid);
    if (t && isCrossJurisdiction(t)) {
      try {
        const { sqlRef } = await putRegionSqlHistory(t, {
          projectId: ctx.projectId,
          historyId,
          sqlText: String(sql ?? ""),
          operatorSub: ctx.identity.sub,
          ts: createdAt,
        });
        sqlForCentral = undefined;
        residencyFields = { residency: "region", sqlAvailable: "on-demand", region: t.region, jurisdiction: jurisdictionOf(t), sqlRef };
      } catch (e) {
        return apiError(
          `执行目标 ${tid} 的区域结果表当前写不进去,本条历史未记录(SQL 原文只许留在该区):${String((e as Error)?.message ?? e)}`,
          503,
          { code: "UPSTREAM_ERROR", detail: { reason: "region-results-unavailable", targetId: tid } }
        );
      }
    }
  }

  const item = {
    userId: USER_ID,
    historyId,
    sql: sqlForCentral,
    status,
    duration,
    rowCount,
    error,
    // 🔴 **多 region 直查:每个区各写一条历史**,否则一条 SQL 打了 3 个区、历史里只有一条,
    // 用户回头看不出"哪个区成了哪个区没成"。纯追加属性、存量行没有它就当 home(读侧同口径)。
    targetId: tid,
    ...residencyFields,
    // 🔴 本批新增的两个归属属性:projectId 决定谁能读到它;createdBy 留给后续
    //    "只看自己的历史"这一档细化(现在按 SPEC 的口径:项目内共享)。
    projectId: ctx.projectId,
    createdBy: ctx.identity.username,
    createdAt,
  };
  try {
    await docClient.send(new PutCommand({ TableName: TABLE, Item: item }));
  } catch {}
  return apiOk(item);
}
