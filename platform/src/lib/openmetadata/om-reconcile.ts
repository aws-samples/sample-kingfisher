// **目录对账:OM 里「本轮完整采集没看见」的表 ⇒ 软删**(BUG-LEDGER 根治)。
//
// 🔴 缺陷原形:表的 OM 条目由平台多条路径 PUT 进去(同步 / 建模 / 血缘 / 目录同步),**全仓没有一处删除**
//   ⇒ 数仓里 DROP 掉的表(不论平台删还是用户在 SQL 里删)永远留在治理目录里;验收残留在主控区目录里
//   堆了几页,把真表挤出第一页。镜像侧早就会「本轮没看见就删」,只是到 OM 这一步被刻意跳过了。
//
// 🔴 删除只在**确知完整**时发生(每一条都是 fail-closed;宁可这一轮不删,也不许删掉一张真表):
//   ① 采集被截断(`complete=false`)⇒ 不删 —— 截断外的表本轮没看见,不等于不存在;
//   ② 采集一张表都没看见 ⇒ 不删 —— 「空输入 ⇒ 全删」是本仓吃过的同形缺陷(凭证 / 权限失效时采集回空);
//   ③ 列 OM 时任何一页读不清楚 ⇒ 整轮不删 —— 只拿到一半的清单去做差集,等于把另一半当成「已消失」;
//   ④ 读失败的库(`unreadDatabases`,如 LakeFormation 只授了部分库)⇒ 那个库里一张都不动;
//   ⑤ 只动**该 target 该来源**的 per-target service(`omServiceFor`)—— 别的区、别的来源的 service 不在范围内。
// 🔴 软删(`hardDelete=false`):目录页只列 non-deleted ⇒ 用户看不见;误删可恢复;同名表重建后 PUT 会把它复活。
// 🔴 本文件被周期 reconciler 可达(instrumentation 面)⇒ 只许 import 轻量层(om-client / om-service / om-mirror-push)。

import { isOmConfigured, omRequestStrict } from "@/lib/openmetadata/om-client";
import { omServiceFor, type OmMirrorSource } from "@/lib/openmetadata/om-service";
import { omCoordsOf } from "@/lib/openmetadata/om-mirror-push";

/** 一轮最多软删多少张(OM 逐个 HTTP);超出如实报 `truncated`,下一轮接着删。 */
export const OM_RECONCILE_MAX_DELETES = 300;
/** 列表分页上限(每页 200)。触顶 ⇒ 清单不完整 ⇒ 按 ③ 整轮不删。 */
const MAX_LIST_PAGES = 50;
const PAGE = 200;

export type OmReconcileSkip =
  | "om-not-configured"
  | "pull-incomplete"
  | "empty-pull"
  | "om-list-failed"
  | "om-list-truncated";

export interface OmReconcileResult {
  source: OmMirrorSource;
  service: string;
  /** OM 里该 service 下(可对账范围内)列到的表数 */
  listed: number;
  /** 本轮软删成功的表数 */
  deleted: number;
  /** 应删而因上限没删的(下一轮接着删) */
  truncated: boolean;
  /** 整轮没做删除的原因(有值 ⇒ deleted 必为 0) */
  skipped?: OmReconcileSkip;
  /** 读失败的明细或单表删除失败(非空 ⇒ 管理面要显示) */
  errors: Array<{ fqn: string; error: string }>;
}

const keyOf = (db: string, schema: string, table: string) => `${db}\u0000${schema}\u0000${table}`;

async function listAll(path: (after: string) => string): Promise<{ ok: true; data: any[] } | { ok: false; error: string; truncated?: boolean }> {
  const out: any[] = [];
  let after = "";
  for (let i = 0; i < MAX_LIST_PAGES; i++) {
    const r = await omRequestStrict("GET", path(after));
    // 404 = 父实体(service / database)在 OM 里不存在 ⇒ 确知为空(不是「读不清楚」)
    if (r.status === 404 && i === 0) return { ok: true, data: [] };
    if (!r.ok || !r.body || !Array.isArray(r.body.data)) {
      return { ok: false, error: `HTTP ${r.status}${r.body?.message ? ` ${String(r.body.message).slice(0, 160)}` : ""}` };
    }
    out.push(...r.body.data);
    after = String(r.body.paging?.after || "");
    if (!after) return { ok: true, data: out };
  }
  return { ok: false, error: `超过 ${MAX_LIST_PAGES} 页`, truncated: true };
}

/**
 * 把 OM 里 `omServiceFor(source, targetId)` 下的表,与本轮采集看见的表对账;没看见的软删。
 *
 * @param seen     本轮该来源采到的**表**的镜像 fqn(`redshift.db.schema.table` / `glue.db.table`)
 * @param complete 本轮该来源的采集是否完整(未截断)
 * @param unreadDatabases 本轮读失败的库名(这些库一律不动)
 */
export async function reconcileOmTables(args: {
  targetId: string;
  source: OmMirrorSource;
  seen: readonly string[];
  complete: boolean;
  unreadDatabases: readonly string[];
}): Promise<OmReconcileResult> {
  const service = omServiceFor(args.source, args.targetId);
  const out: OmReconcileResult = { source: args.source, service, listed: 0, deleted: 0, truncated: false, errors: [] };
  if (!isOmConfigured()) return { ...out, skipped: "om-not-configured" };
  if (!args.complete) return { ...out, skipped: "pull-incomplete" };

  const seen = new Set<string>();
  for (const fqn of args.seen) {
    const c = omCoordsOf(fqn);
    if (c && c.source === args.source) seen.add(keyOf(c.database, c.schema, c.table));
  }
  if (seen.size === 0) return { ...out, skipped: "empty-pull" };
  const unread = new Set(args.unreadDatabases);

  const dbs = await listAll((after) =>
    `/api/v1/databases?service=${encodeURIComponent(service)}&limit=${PAGE}&include=non-deleted${after ? `&after=${encodeURIComponent(after)}` : ""}`
  );
  if (!dbs.ok) {
    return { ...out, skipped: dbs.truncated ? "om-list-truncated" : "om-list-failed", errors: [{ fqn: service, error: dbs.error }] };
  }

  const stale: Array<{ id: string; fqn: string }> = [];
  for (const d of dbs.data) {
    const dbName = String(d?.name ?? "");
    const dbFqn = String(d?.fullyQualifiedName ?? "");
    if (!dbName || !dbFqn) {
      return { ...out, skipped: "om-list-failed", errors: [{ fqn: service, error: "OM 回的库条目缺 name / fullyQualifiedName" }] };
    }
    if (unread.has(dbName)) continue;
    const tables = await listAll((after) =>
      `/api/v1/tables?database=${encodeURIComponent(dbFqn)}&limit=${PAGE}&include=non-deleted${after ? `&after=${encodeURIComponent(after)}` : ""}`
    );
    if (!tables.ok) {
      return { ...out, skipped: tables.truncated ? "om-list-truncated" : "om-list-failed", errors: [{ fqn: dbFqn, error: tables.error }] };
    }
    for (const t of tables.data) {
      const schema = String(t?.databaseSchema?.name ?? "");
      const name = String(t?.name ?? "");
      const id = String(t?.id ?? "");
      if (!schema || !name || !id) {
        return { ...out, skipped: "om-list-failed", errors: [{ fqn: dbFqn, error: "OM 回的表条目缺 id / name / databaseSchema" }] };
      }
      out.listed += 1;
      if (!seen.has(keyOf(dbName, schema, name))) stale.push({ id, fqn: String(t?.fullyQualifiedName ?? `${dbFqn}.${schema}.${name}`) });
    }
  }

  // 清单完整之后才删(③):任何一页读不清楚都在上面 return 了
  out.truncated = stale.length > OM_RECONCILE_MAX_DELETES;
  for (const s of stale.slice(0, OM_RECONCILE_MAX_DELETES)) {
    const r = await omRequestStrict("DELETE", `/api/v1/tables/${encodeURIComponent(s.id)}?hardDelete=false&recursive=false`);
    if (r.ok || r.status === 404) out.deleted += 1;
    else out.errors.push({ fqn: s.fqn, error: `HTTP ${r.status}${r.body?.message ? ` ${String(r.body.message).slice(0, 160)}` : ""}` });
  }
  return out;
}
