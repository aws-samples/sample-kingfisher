export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { ZEROETL_WORKGROUP, getZeroEtlSecretArn } from "@/lib/realtime/zeroetl-service";
import { requireProject } from "@/lib/projects/guard";
// @kf-batch 50-WP31-place-first-class
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
// @kf-batch 50-WP2-directquery
// 🔴 裸客户端 / 落点 / 轮询收编;`?targetId=` 跟编辑器自己的执行目标选择走(不读 `?scope=`)。
// 🔴 zero-ETL 分支**原样保留**:它是主控区里的**独立 namespace**,有自己的密钥缓存
//    (R9★ 教训:只改 admin-secret 会让 zero-etl 查询绕过隔离)⇒ 那条路的 SecretArn 不许被落点覆盖。
import {
  directQueryRaw,
  resolveDirectQueryPlaceSafe,
  type DirectQueryPlace,
} from "@/lib/redshift/direct-query";

// Unwrap a Redshift Data API cell to its scalar value. The cell is a single-key union like
// { stringValue } / { longValue } / { doubleValue } / { booleanValue } / { isNull: true }.
// CRITICAL: an SQL NULL comes back as { isNull: true }; blindly taking Object.values(cell)[0]
// would yield the boolean `true`, which is exactly how unresolved columns were rendering as a
// bogus "true" column name/type. Treat isNull as NULL so LEFT JOIN misses become empty, not "true".
function cellValue(cell: any): unknown {
  if (cell == null || cell.isNull === true) return null;
  if ("stringValue" in cell) return cell.stringValue;
  if ("longValue" in cell) return cell.longValue;
  if ("doubleValue" in cell) return cell.doubleValue;
  if ("booleanValue" in cell) return cell.booleanValue;
  const v = Object.values(cell)[0];
  return v == null ? null : v;
}

// @kf-batch 52-P52.5a-supply — 加 `project` 形参(静态归类:**project-context**)。
// 🔴 上面那段注释说的"必须用 superuser 才看得到别人 owner 的列"在 flag=on 下会**变成**
//    "只看得到本项目 schema 的列" —— 那正是本模块要的隔离(也正是本路由注释里
//    「仍欠:按项目过滤返回的 schema 集合」那条欠账被真正还掉的方式)。
//    ⇒ 但它要求现网数据已迁进 `proj_<id>`(P52.5b),所以 flag 缺省 off。
async function runQuery(sql: string, place: DirectQueryPlace) {
  // Execute with the shared admin (superuser) secret — same identity as /api/redshift/execute
  // and GenBI introspectSchema. Without it the query runs as the ECS task role (a non-superuser),
  // which information_schema.columns filters by privilege, so columns of tables owned by other
  // roles (dms_ingest / ETL-created) come back as NULL → the schema tree showed them as a single
  // "true" column even though the table really has many columns (visible when you actually query
  // it, since that path already uses the admin secret). Zero-ETL namespace uses its own secret.
  // zero-etl 分支不传 project(独立 namespace 的自有密钥,同 /api/redshift/execute 的理由)。
  // zero-ETL 的 namespace 用它自己的密钥(见文件头);其余用落点带来的那把。
  const SecretArn =
    place.workgroup === ZEROETL_WORKGROUP ? await getZeroEtlSecretArn() : place.secretArn;
  try {
    // 🔴 轮询预算保持**该站点原值 30 × 1000ms**;失败文案原样 `desc.Error || desc.Status`;
    //    **超时不抛而是回空数组**(编辑器左侧树宁可空着也不弹错)—— 这三点都与收编前逐字一致。
    const raw = await directQueryRaw(
      { ...place, ...(SecretArn ? { secretArn: SecretArn } : { secretArn: undefined }) },
      sql,
      { rounds: 30, intervalMs: 1000, failedMessage: (status, err) => err || status, timeoutMessage: "__TIMEOUT__" }
    );
    return raw.records.map((row) => (row as unknown[]).map((cell) => cellValue(cell)));
  } catch (e) {
    if (e instanceof Error && e.message === "__TIMEOUT__") return [];
    throw e;
  }
}

// 🔴 P1-10(2026-08-29 外部审核):本端点此前**无任何守卫** —— 任一登录用户即可用**共享 admin
// 身份**枚举全库 schema/表/列(见下方 runQuery 的注释:它刻意用 superuser 以便看到别人建的表)。
// 那是跨项目元数据泄露,且它**不在 52 的"12 越权面"清单里** ⇒ 该清单须扩为 **13 面**。
// 本批先补最低门槛 `requireProject(viewer)`(至少要求调用者是某个项目的成员);
// ⚠️ 仍欠(属 P52.1):按项目过滤返回的 schema 集合 —— 现在成员仍能看到**全部** schema,
// 真正的收口要等 `proj_<id>` 数据面隔离(52 §7bis)落地后按项目 schema 白名单裁剪。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const sp = req.nextUrl.searchParams;
  // @kf-batch 50-WP2-directquery —— 落点:`?targetId=` +(编辑器显式给的)workgroup / database。
  // 该 target 没装数仓 ⇒ 回能力态,页面把左侧树置灰并说清原因(而不是给一棵空树)。
  let pre: Awaited<ReturnType<typeof resolveDirectQueryPlaceSafe>>;
  try {
    pre = await resolveDirectQueryPlaceSafe({
      // @kf-batch 50-WP31-place-first-class —— 🔴 落点必须点名(缺 / 非法 ⇒ 400,不再「没给 = 主控区」)
      targetId: requestedTargetId(sp.get("targetId"), "列库表结构"),
      projectId: ctx.projectId,
      workgroupOverride: sp.get("workgroup"),
      databaseOverride: sp.get("database"),
    });
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    // 🔴 落点解析的拒因(不存在 / 无权 / **落点冲突** / 缺凭证)都是**用户可修**的 ⇒ 409 + 原句,
    //    不是 500。落点冲突最常见的成因就是「页面把主控区的 workgroup 带给了别的区」——
    //    报 500 会让人去查平台故障,而实际动作是换 workgroup(或别带)。
    return NextResponse.json(
      { capability: "unavailable", reason: (e as Error)?.message || String(e), schemas: [], tables: [] },
      { status: 409 }
    );
  }
  if (pre.capability === "unavailable") return NextResponse.json({ ...pre, schemas: [], tables: [] });
  const place = pre.place;

  try {
    // 序 49 ⑦ UX ③:`?mode=schemas` ⇒ 只列 schema 名(含还没有表的空 schema),不扫表与列 —— 「新建表」向导的
    //   schema 下拉用(用户 10-20 拍板:schema 从手打改成「下拉已有 + 可输新」)。系统 schema 与 pg_ 前缀剔掉;
    //   项目私有 proj_* 由向导侧过滤(服务端建表校验仍是权威)。
    if (sp.get("mode") === "schemas") {
      const rows = await runQuery(`
        SELECT nspname FROM pg_namespace
        WHERE nspname NOT LIKE 'pg\\_%' AND nspname NOT IN ('information_schema', 'catalog_history')
        ORDER BY nspname
      `, place);
      return NextResponse.json({ mode: "schemas", schemas: rows.map((r) => ({ name: String(r[0]) })), tables: [] });
    }
    // Single query to get schemas + tables + columns together
    const rows = await runQuery(`
      SELECT t.schemaname, t.tablename, t.tableowner,
             c.column_name, c.data_type, c.ordinal_position
      FROM pg_tables t
      LEFT JOIN information_schema.columns c
        ON c.table_schema = t.schemaname AND c.table_name = t.tablename
      WHERE t.schemaname NOT IN ('information_schema','pg_catalog','pg_internal','pg_automv')
      ORDER BY t.schemaname, t.tablename, c.ordinal_position
    `, place);

    // Build structured response
    const schemaSet = new Set<string>();
    const tableMap: Record<string, { schema: string; table: string; owner: string; columns: any[] }> = {};

    for (const r of rows) {
      const schema = String(r[0]);
      const table = String(r[1]);
      const key = `${schema}.${table}`;
      schemaSet.add(schema);
      if (!tableMap[key]) {
        tableMap[key] = { schema, table, owner: String(r[2]), columns: [] };
      }
      if (r[3]) {
        tableMap[key].columns.push({ name: String(r[3]), type: String(r[4]), position: r[5] });
      }
    }

    return NextResponse.json({
      schemas: Array.from(schemaSet).map((s) => ({ name: s })),
      tables: Object.values(tableMap),
    });
  } catch (err: any) {
    return NextResponse.json({ schemas: [], tables: [], error: err.message }, { status: 200 });
  }
}
