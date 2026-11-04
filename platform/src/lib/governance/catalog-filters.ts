// @kf-batch 50-SEQ47d-catalog-filters —— 数据目录页的筛选(来源 / 库·表桶 / schema·命名空间 / 格式 / 敏感级别)。
//
// 🔴 为什么是一个纯模块而不是写在页面里:客户 2026-10-19 反馈「数据目录缺少数据库类型、schema、bucket 等筛选条件」;
//   目录行的「数据库」一列是 `<db>.<schema>` 一个字符串(Redshift = `dev.public`;S3 Tables 的 FQN 约定
//   `bgp-s3tables.<bucket>.<namespace>.<table>` ⇒ 这一列 = `<表桶>.<命名空间>`,见 lib/openmetadata/om-push.ts)。
//   拆分 / 过滤 / 候选项 / URL 往返四件事都是**事实**,要能被单测钉住;页面只负责渲染与收用户输入。
// 🔴 空筛选 = 恒等(与改动前逐字节一致):不筛的时候一行都不许少。

export interface CatalogRowLike {
  fqn?: string | null;
  name?: string | null;
  type?: string | null;
  source?: string | null;
  database?: string | null;
  format?: string | null;
  sensitivity?: string | null;
}

export interface CatalogFilter {
  /** 来源(目录行 `source`:Redshift / S3 Tables / S3 / Glue / 数据源 …);空数组 = 不筛 */
  sources: string[];
  /** 库(Redshift 的 database)/ 表桶(S3 Tables 的 table bucket);空串 = 不筛 */
  db: string;
  /** schema(Redshift)/ 命名空间(S3 Tables);空串 = 不筛 */
  schema: string;
  /** 格式(Table / Iceberg / Parquet / MySQL …);空数组 = 不筛 */
  formats: string[];
  /** 敏感级别(目录行 `sensitivity`;`none` 表示「未分级」);空数组 = 不筛 */
  sensitivities: string[];
}

export const EMPTY_CATALOG_FILTER: CatalogFilter = { sources: [], db: "", schema: "", formats: [], sensitivities: [] };

/** 未分级行在筛选里的取值(目录行 sensitivity 为 null / 空) */
export const SENSITIVITY_NONE = "none";

/** 把目录行的 `database` 一列拆成 { db, schema }:`a.b` ⇒ db=a schema=b;只有一段 ⇒ schema 空;没有 ⇒ 都空。 */
export function splitDatabase(row: CatalogRowLike): { db: string; schema: string } {
  const raw = (row.database || "").trim();
  if (!raw) return { db: "", schema: "" };
  const i = raw.indexOf(".");
  if (i < 0) return { db: raw, schema: "" };
  return { db: raw.slice(0, i), schema: raw.slice(i + 1) };
}

/** S3 Tables 行的「库」就是表桶,「schema」就是命名空间 —— 列头文案按行类型区分用这个判。 */
export function isLakeRow(row: CatalogRowLike): boolean {
  return row.type === "s3" || row.source === "S3 Tables" || (row.fqn || "").startsWith("bgp-s3tables");
}

function sensitivityOf(row: CatalogRowLike): string {
  return row.sensitivity ? String(row.sensitivity) : SENSITIVITY_NONE;
}

export function isEmptyCatalogFilter(f: CatalogFilter): boolean {
  return !f.sources.length && !f.db && !f.schema && !f.formats.length && !f.sensitivities.length;
}

/** 过滤:每个维度内「任一命中」,维度之间「全部满足」;空筛选恒等。 */
export function applyCatalogFilter<T extends CatalogRowLike>(rows: readonly T[], f: CatalogFilter): T[] {
  if (isEmptyCatalogFilter(f)) return rows.slice();
  return rows.filter((r) => {
    if (f.sources.length && !f.sources.includes(r.source || "")) return false;
    const { db, schema } = splitDatabase(r);
    if (f.db && db !== f.db) return false;
    if (f.schema && schema !== f.schema) return false;
    if (f.formats.length && !f.formats.includes(r.format || "")) return false;
    if (f.sensitivities.length && !f.sensitivities.includes(sensitivityOf(r))) return false;
    return true;
  });
}

export interface CatalogFilterOptions {
  sources: string[];
  dbs: string[];
  /** 只给选中的库下的 schema;没选库 ⇒ 全部 schema */
  schemas: string[];
  formats: string[];
  sensitivities: string[];
}

function uniqSorted(xs: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(xs).filter((x) => x !== ""))).sort((a, b) => a.localeCompare(b));
}

/** 候选项来自**当前目录数据本身**(不另打接口):用户只会看到真有的值。 */
export function catalogFilterOptions(rows: readonly CatalogRowLike[], selectedDb = ""): CatalogFilterOptions {
  const parts = rows.map((r) => ({ r, ...splitDatabase(r) }));
  return {
    sources: uniqSorted(rows.map((r) => r.source || "")),
    dbs: uniqSorted(parts.map((p) => p.db)),
    schemas: uniqSorted(parts.filter((p) => !selectedDb || p.db === selectedDb).map((p) => p.schema)),
    formats: uniqSorted(rows.map((r) => r.format || "")),
    sensitivities: uniqSorted(rows.map(sensitivityOf)),
  };
}

// ── URL 往返:筛选条件写进地址栏才能分享 / 刷新不丢(键名短而稳定;多值用逗号)──
const Q = { sources: "src", db: "db", schema: "schema", formats: "fmt", sensitivities: "sens" } as const;

export function catalogFilterFromSearch(search: string | URLSearchParams): CatalogFilter {
  const p = typeof search === "string" ? new URLSearchParams(search) : search;
  const list = (k: string) => (p.get(k) || "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    sources: list(Q.sources),
    db: (p.get(Q.db) || "").trim(),
    schema: (p.get(Q.schema) || "").trim(),
    formats: list(Q.formats),
    sensitivities: list(Q.sensitivities),
  };
}

/** 把筛选写回已有的查询串(只动自己的 5 个键,别的键 —— 比如执行范围 `scope` —— 原样保留)。 */
export function catalogFilterToSearch(f: CatalogFilter, existing: string | URLSearchParams = ""): string {
  const p = new URLSearchParams(typeof existing === "string" ? existing : existing.toString());
  const set = (k: string, v: string) => (v ? p.set(k, v) : p.delete(k));
  set(Q.sources, f.sources.join(","));
  set(Q.db, f.db);
  set(Q.schema, f.schema);
  set(Q.formats, f.formats.join(","));
  set(Q.sensitivities, f.sensitivities.join(","));
  const s = p.toString();
  return s ? `?${s}` : "";
}
