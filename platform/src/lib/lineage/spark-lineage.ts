// 计算血缘 — Spark / PySpark 脚本表级血缘启发式提取 (2026-07-08)
//
// EMR Serverless (and Glue) run free-form PySpark where table I/O is expressed many ways:
//   read : spark.table("cat.ns.tbl") / spark.read.table("...") / spark.sql("... FROM x JOIN y")
//   write: df.write.saveAsTable("...") / .insertInto("...") / spark.sql("INSERT INTO t ...")
//          + jobs that push into Redshift via boto3 redshift-data ("INSERT INTO schema.table ...")
//
// There is no structured I/O declaration, so we extract table references heuristically. Pure
// functions, no deps, NEVER throw (best-effort — same philosophy as sql-lineage / om-push).
// Conservative by design: we only emit references we are confident about, so we never fabricate
// a wrong lineage edge. What we can't resolve (dynamic names) is simply skipped.
//
// Simple variable resolution: `NS = "s3tablescatalog.gamedata"` then `spark.table(f"{NS}.ad_events")`
// is common; we resolve single-string assignments and substitute `{VAR}` / f-string parts so the
// real table name is recovered.

export interface SparkScriptLineage {
  inputs: string[]; // referenced source tables (raw identifiers as written, normalized lower-case)
  outputs: string[]; // written/target tables
}

// A table identifier token: word(.word)* — allows catalog.namespace.table, keeps underscores/$.
const TABLE_ID = "([A-Za-z_][\\w$]*(?:\\.[A-Za-z_][\\w$]*){0,3})";
// A string-arg table token that ALSO allows f-string `{VAR}` interpolation parts, e.g. `{NS}.ad_events`
// (resolveInterpolations then substitutes known string vars). Kept separate so bare-identifier
// scans (FROM/JOIN) stay strict while quoted spark.table("...") args accept interpolation.
const STR_TABLE_ID = "([A-Za-z_{][\\w$.{}]*)";

// Collect simple string-var assignments: NAME = "literal" / NAME = 'literal'. Used to resolve
// f-string interpolations like f"{NS}.tbl". Only single, whole-string literals (no concatenation).
function collectStringVars(script: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const re = /^\s*([A-Za-z_]\w*)\s*=\s*["']([^"'\n]+)["']\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(script))) vars[m[1]] = m[2];
  return vars;
}

// Resolve f-string interpolations `{VAR}` inside a captured table token using known string vars.
// Returns null if any {..} placeholder can't be resolved (so we skip rather than emit a bad name).
function resolveInterpolations(raw: string, vars: Record<string, string>): string | null {
  if (!raw.includes("{")) return raw;
  let out = raw;
  const re = /\{([A-Za-z_]\w*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const v = vars[m[1]];
    if (v == null) return null; // unresolved dynamic part → skip this reference
    out = out.replace(m[0], v);
  }
  // after substitution there must be no leftover braces / quotes
  if (/[{}"']/.test(out)) return null;
  return out;
}

function norm(id: string): string {
  return id.replace(/["'`]/g, "").trim().toLowerCase();
}

// 非表标识黑名单:PySpark 代码里 `from pyspark.sql import ...` / `spark.sql(...)` 等会被
// FROM/JOIN 的启发式误当成「表」捕获(如 `from pyspark.sql import` → 抓到 `pyspark.sql`),
// 产生 redshift.dev.pyspark.sql 这类假血缘边。这些是 Python 模块/API 路径,不是数据表——
// 全部过滤掉,根治假节点。匹配整个规范化标识(而非子串),避免误伤真表。
const NON_TABLE_REFS = new Set<string>([
  "pyspark.sql", "pyspark.sql.functions", "pyspark.sql.types", "pyspark.sql.window",
  "spark.sql", "pyspark.context", "pyspark.conf", "pyspark.storagelevel",
  "functions.col", "f.col", "pyspark.ml", "pyspark.sql.session",
]);
// 常见的 Python 模块首段(FROM <module>.<sub> import 的误捕获):首段是这些则判非表。
const NON_TABLE_HEADS = new Set<string>(["pyspark", "spark", "boto3", "botocore", "awsglue", "datetime", "os", "sys", "json", "typing", "functools", "itertools", "collections"]);

// Is this a plausible qualified table (has at least one dot, i.e. schema.table or cat.ns.table)?
// Bare single-word names are ambiguous (could be a CTE/alias/df var) so we require qualification
// to stay conservative and avoid false edges. 同时排除 Python 模块/API 路径(见上)。
function isQualified(id: string): boolean {
  const n = norm(id);
  if (!/\w\.\w/.test(n) || n.includes(" ")) return false;
  if (NON_TABLE_REFS.has(n)) return false;
  if (NON_TABLE_HEADS.has(n.split(".")[0])) return false;
  return true;
}

/**
 * Extract table-level inputs/outputs from a PySpark / Spark-SQL script. Best-effort; never throws.
 * Only qualified (schema.table or catalog.ns.table) references are returned.
 */
export function parseSparkScriptLineage(script: string): SparkScriptLineage {
  const inputs = new Set<string>();
  const outputs = new Set<string>();
  if (!script || !script.trim()) return { inputs: [], outputs: [] };
  try {
    const vars = collectStringVars(script);
    const add = (set: Set<string>, raw?: string) => {
      if (!raw) return;
      const resolved = resolveInterpolations(raw, vars);
      if (resolved == null) return;
      if (isQualified(resolved)) set.add(norm(resolved));
    };

    // Run a global regex over the script, applying `fn` to each match's group 1 (ES5-safe: exec loop).
    const eachMatch = (re: RegExp, fn: (g1: string) => void) => {
      let m: RegExpExecArray | null;
      while ((m = re.exec(script))) fn(m[1]);
    };

    // ---- READS ----
    // spark.table("X") / spark.read.table("X")  (string arg — allows f"{VAR}.tbl" interpolation)
    eachMatch(new RegExp(`\\.(?:read\\s*\\.\\s*)?table\\s*\\(\\s*f?["']${STR_TABLE_ID}["']`, "gi"), (g) => add(inputs, g));
    // FROM X / JOIN X inside embedded SQL strings (also covers boto3 redshift-data run("... FROM x"))
    eachMatch(new RegExp(`\\b(?:from|join)\\s+${TABLE_ID}`, "gi"), (g) => add(inputs, g));

    // ---- WRITES ----
    // .saveAsTable("X") / .insertInto("X")  (string arg — allows f"{VAR}.tbl" interpolation)
    eachMatch(new RegExp(`\\.(?:saveAsTable|insertInto)\\s*\\(\\s*f?["']${STR_TABLE_ID}["']`, "gi"), (g) => add(outputs, g));
    // INSERT INTO X / INSERT OVERWRITE TABLE X / CREATE TABLE X (embedded SQL)
    eachMatch(new RegExp(`\\binsert\\s+(?:into|overwrite(?:\\s+table)?)\\s+${TABLE_ID}`, "gi"), (g) => add(outputs, g));
    eachMatch(new RegExp(`\\bcreate\\s+(?:or\\s+replace\\s+)?(?:external\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${TABLE_ID}`, "gi"), (g) => add(outputs, g));

    // A table that is both created/inserted and read is a target, not a source (avoid self-loop).
    Array.from(outputs).forEach((o) => inputs.delete(o));
  } catch {
    // best-effort
  }
  return { inputs: Array.from(inputs), outputs: Array.from(outputs) };
}

// ─────────────────────────────────────────────────────────────────────────────
// FQN mapping for the platform lineage table (bgp-lineage), NON-prefixed convention so compute
// nodes connect to sync nodes / catalog fallback:
//   - S3 Tables catalog ref  cat.namespace.table  →  s3.<namespace>.<table>   (matches S3 sync side)
//   - Redshift schema.table   →  redshift.<db>.<schema>.<table>
//   - bare schema.table (Redshift default db) → redshift.<db>.<schema>.<table>
// The S3-Tables catalog name is stripped (it's an engine catalog, not part of the asset identity);
// what identifies the lake asset is namespace.table, aligned with the S3 sync FQN tail.
// ─────────────────────────────────────────────────────────────────────────────
export function sparkRefToFqn(ref: string, opts: { redshiftDb?: string; s3Catalogs?: string[] } = {}): string | null {
  const n = norm(ref);
  if (!n || !n.includes(".")) return null;
  const parts = n.split(".").filter(Boolean);
  const s3Catalogs = (opts.s3Catalogs || ["s3tablescatalog", "s3tables", "glue_catalog", "iceberg"]).map((c) => c.toLowerCase());
  // catalog.namespace.table (3 parts) with a known S3/Iceberg catalog → s3.<ns>.<table>
  if (parts.length >= 3 && s3Catalogs.includes(parts[0])) {
    const table = parts[parts.length - 1];
    const ns = parts[parts.length - 2];
    return `s3.${ns}.${table}`;
  }
  // namespace.table for an S3/Iceberg-only reference isn't distinguishable from redshift here;
  // default to Redshift convention (schema.table under the default db) unless 3-part.
  const db = (opts.redshiftDb || process.env.REDSHIFT_DATABASE || "dev").toLowerCase();
  if (parts.length >= 3) {
    // db.schema.table
    const n3 = parts.length;
    return `redshift.${parts[n3 - 3]}.${parts[n3 - 2]}.${parts[n3 - 1]}`;
  }
  // schema.table → redshift.<db>.<schema>.<table>
  return `redshift.${db}.${parts[0]}.${parts[1]}`;
}
