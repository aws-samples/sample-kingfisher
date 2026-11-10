// SQL 血缘自动解析 (v1.8.0)
//
// Heuristic, table-level SQL lineage extractor for Redshift SQL (作业开发 Redshift 作业 +
// Redshift 保存任务). Pure functions, no external deps, never throws (best-effort: on any
// parse trouble it returns whatever it found, matching om-push's "metadata must not break
// the write path" philosophy).
//
// Why heuristic (not an AST library): Redshift dialect (CTAS, MATERIALIZED VIEW, COPY/UNLOAD,
// SUPER, etc.) is only partially covered by general SQL AST parsers, which throw on the first
// unsupported token. For table-level lineage we only need "what does this statement WRITE and
// what does it READ", which regex + a small token scanner extract robustly.
//
// Granularity: TABLE level. (Column-level SQL lineage is out of scope this release; the sync
// path already pushes column-level lineage.)

import { stripSqlComments } from "@/lib/genbi/core/sql-comments";

export interface TableRef {
  database: string;
  schema: string;
  table: string;
}

export type SqlStatementKind =
  | "ctas"
  | "view"
  | "insert"
  | "merge"
  | "update"
  | "delete"
  | "select"
  | "other";

export interface SqlStatementLineage {
  kind: SqlStatementKind;
  target?: TableRef;
  sources: TableRef[];
}

export interface SqlLineageEdge {
  from: TableRef;
  to: TableRef;
}

export interface SqlLineageResult {
  targets: TableRef[];
  sources: TableRef[];
  edges: SqlLineageEdge[];
  statements: SqlStatementLineage[];
}

export interface ParseDefaults {
  database?: string; // default Redshift database when a ref omits it (default "dev")
  schema?: string; // default schema when a ref is unqualified (default "public")
}

export const RS_SERVICE = "bgp-redshift";

// OM Redshift FQN: bgp-redshift.<db>.<schema>.<table> (matches sync/ingestion conventions).
export function tableFqn(ref: TableRef): string {
  return `${RS_SERVICE}.${ref.database}.${ref.schema}.${ref.table}`;
}

// SQL keywords that may directly follow a table reference; used so the token scanner never
// mistakes a keyword for a bare table alias.
const KEYWORDS = new Set([
  "select", "from", "where", "group", "by", "order", "having", "limit", "offset",
  "join", "inner", "left", "right", "full", "outer", "cross", "natural", "on", "using",
  "union", "except", "intersect", "window", "qualify", "returning", "set", "values",
  "and", "or", "not", "as", "with", "distinct", "all", "into", "insert", "update",
  "delete", "create", "table", "view", "merge", "when", "then", "else", "end", "case",
  "over", "partition", "lateral", "tablesample", "fetch", "for",
]);

// 注释剥除唯一作者 lib/genbi/core/sql-comments(与问数只读闸共用;块注释下标扫描,不用会多项式回溯的正则)。
const stripComments = stripSqlComments;

// Replace single-quoted string literals (incl. doubled '' escapes) with empty literals so
// keywords/table-like tokens inside strings can't be mis-parsed. Double quotes are SQL
// identifiers in Redshift, so they are intentionally NOT stripped (handled at normalization).
function stripStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

function isIdent(tok: string): boolean {
  return /^[A-Za-z_"][\w".$]*$/.test(tok);
}

// Split into tokens, isolating ( ) , so the scanner can reason about subqueries / lists.
// schema.table stays a single token (the dot is kept).
function tokenize(stmt: string): string[] {
  return stmt
    .replace(/([(),])/g, " $1 ")
    .split(/\s+/)
    .filter(Boolean);
}

// CTE names defined in this statement's WITH clause: `name AS (`. (Also matches a CTAS
// `CREATE TABLE t AS (` target — harmless, since the target is excluded from sources anyway.)
function cteNames(stmt: string): Set<string> {
  const set = new Set<string>();
  const re = /\b([A-Za-z_]\w*)\s+as\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stmt))) set.add(m[1].toLowerCase());
  return set;
}

interface TargetMatch {
  kind: SqlStatementKind;
  targetRaw: string;
}

function detectTarget(stmt: string): TargetMatch | null {
  let m: RegExpExecArray | null;
  const ID = `([A-Za-z_"][\\w".$]*)`;
  if ((m = new RegExp(`^\\s*create\\s+(?:or\\s+replace\\s+)?(?:local\\s+|global\\s+)?(?:temp(?:orary)?\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${ID}\\s+as\\b`, "i").exec(stmt)))
    return { kind: "ctas", targetRaw: m[1] };
  if ((m = new RegExp(`^\\s*create\\s+(?:or\\s+replace\\s+)?(?:materialized\\s+)?view\\s+(?:if\\s+not\\s+exists\\s+)?${ID}\\s+as\\b`, "i").exec(stmt)))
    return { kind: "view", targetRaw: m[1] };
  if ((m = new RegExp(`^\\s*insert\\s+into\\s+${ID}`, "i").exec(stmt)))
    return { kind: "insert", targetRaw: m[1] };
  if ((m = new RegExp(`^\\s*merge\\s+into\\s+${ID}`, "i").exec(stmt)))
    return { kind: "merge", targetRaw: m[1] };
  if ((m = new RegExp(`^\\s*update\\s+(?:only\\s+)?${ID}`, "i").exec(stmt)))
    return { kind: "update", targetRaw: m[1] };
  if ((m = new RegExp(`^\\s*delete\\s+from\\s+${ID}`, "i").exec(stmt)))
    return { kind: "delete", targetRaw: m[1] };
  return null;
}

// Extract table refs from FROM / JOIN clauses (incl. comma-separated FROM lists). Subqueries
// `( ... )` are skipped as table refs, but the outer scan still walks INTO them, so tables
// read inside derived tables / IN(...) subqueries are captured as real sources.
function extractFromJoin(stmt: string): string[] {
  const tokens = tokenize(stmt);
  const lower = tokens.map((t) => t.toLowerCase());
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const w = lower[i];
    const isFrom = w === "from";
    if (!isFrom && w !== "join") continue;
    let j = i + 1;
    // Read one table (FROM/JOIN); for FROM, continue across a comma-separated list.
    while (j < tokens.length) {
      const tok = tokens[j];
      if (tok === "(") {
        // subquery / derived table — skip its balanced parens (inner tables get picked up
        // by the outer loop when it reaches the nested FROM/JOIN).
        let depth = 1;
        j++;
        while (j < tokens.length && depth > 0) {
          if (tokens[j] === "(") depth++;
          else if (tokens[j] === ")") depth--;
          j++;
        }
      } else if (isIdent(tok)) {
        out.push(tok);
        j++;
      } else {
        break;
      }
      // optional alias after the table/subquery
      if (j < tokens.length && lower[j] === "as") {
        j++;
        if (j < tokens.length && isIdent(tokens[j])) j++;
      } else if (j < tokens.length && isIdent(tokens[j]) && !KEYWORDS.has(lower[j])) {
        j++; // bare alias
      }
      if (isFrom && j < tokens.length && tokens[j] === ",") {
        j++;
        continue; // next item in the FROM list
      }
      break;
    }
  }
  return out;
}

// Single table after a keyword (USING for DELETE ... USING / MERGE ... USING). A following
// `(` (e.g. JOIN ... USING (cols), or USING (subquery)) is not a table ref.
function extractAfterKeyword(stmt: string, kw: string): string[] {
  const tokens = tokenize(stmt);
  const lower = tokens.map((t) => t.toLowerCase());
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (lower[i] !== kw) continue;
    const next = tokens[i + 1];
    if (next && next !== "(" && isIdent(next)) out.push(next);
  }
  return out;
}

function normalizeRef(raw: string, def: Required<ParseDefaults>): TableRef {
  const parts = raw
    .split(".")
    .map((p) => p.replace(/"/g, "").trim().toLowerCase())
    .filter(Boolean);
  if (parts.length >= 3) {
    const n = parts.length;
    return { database: parts[n - 3], schema: parts[n - 2], table: parts[n - 1] };
  }
  if (parts.length === 2) return { database: def.database, schema: parts[0], table: parts[1] };
  return { database: def.database, schema: def.schema, table: parts[0] || raw.toLowerCase() };
}

/**
 * Parse Redshift SQL (one or many `;`-separated statements) into table-level lineage.
 * Best-effort; never throws.
 */
export function parseSqlLineage(sql: string, defaults: ParseDefaults = {}): SqlLineageResult {
  const def: Required<ParseDefaults> = {
    database: (defaults.database || "dev").toLowerCase(),
    schema: (defaults.schema || "public").toLowerCase(),
  };
  const result: SqlLineageResult = { targets: [], sources: [], edges: [], statements: [] };
  if (!sql || !sql.trim()) return result;

  try {
    const clean = stripStrings(stripComments(sql));
    const seenEdge = new Set<string>();
    const seenTarget = new Set<string>();
    const seenSource = new Set<string>();

    for (const rawStmt of clean.split(";")) {
      const stmt = rawStmt.replace(/\s+/g, " ").trim();
      if (!stmt) continue;

      const cte = cteNames(stmt);
      const tgt = detectTarget(stmt);
      const kind: SqlStatementKind =
        tgt?.kind || (/^\s*(select|with)\b/i.test(stmt) ? "select" : "other");

      const sourceRaws =
        tgt && (tgt.kind === "delete" || tgt.kind === "merge")
          ? extractAfterKeyword(stmt, "using")
          : extractFromJoin(stmt);

      const target = tgt ? normalizeRef(tgt.targetRaw, def) : undefined;
      const targetFqn = target ? tableFqn(target) : "";

      const stmtSources: TableRef[] = [];
      for (const raw of sourceRaws) {
        const low = raw.replace(/"/g, "").toLowerCase();
        const last = low.split(".").pop() || low;
        if (cte.has(low) || cte.has(last)) continue; // CTE, not a real table
        const ref = normalizeRef(raw, def);
        const fqn = tableFqn(ref);
        if (target && fqn === targetFqn) continue; // self-reference
        stmtSources.push(ref);
        if (!seenSource.has(fqn)) {
          seenSource.add(fqn);
          result.sources.push(ref);
        }
      }

      result.statements.push({ kind, target, sources: stmtSources });

      if (target) {
        if (!seenTarget.has(targetFqn)) {
          seenTarget.add(targetFqn);
          result.targets.push(target);
        }
        for (const s of stmtSources) {
          const key = `${tableFqn(s)}->${targetFqn}`;
          if (!seenEdge.has(key)) {
            seenEdge.add(key);
            result.edges.push({ from: s, to: target });
          }
        }
      }
    }
  } catch {
    // best-effort: return whatever was collected so far
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 结果列 → 物理列
//
// 为什么:字段脱敏按「结果列名」去对分级,而问数模型生成的 SQL 几乎总给中文别名(`country AS 地区`),
//   直查 / BI 里 `AS` 改名也是家常便饭 ⇒ 分级落在物理列 `country` 上、结果列却叫「地区」⇒ 永远对不上
//   ⇒ L3 字段明文给非授权用户(设计稿 18 §9 第 1 条自 v1.9.0 起一直「记入局限」;页面驱动验收 gbc GC-11
//   用模型真回的 SQL 当场撞到)。这里把每个结果列解析成「它引用了哪些物理列」(别名链 / 表达式 / CTE 与子查询
//   逐层展开),脱敏按物理列对分级。
// 口径:保守 —— 表达式引用了敏感列(`upper(email)`、`count(distinct phone)`)也算引用,按最强策略脱敏;
//   `*` / 解析不出来的列回落到原来的「按结果列名」匹配,**不会**比修前更松。best-effort,永不抛。
// ─────────────────────────────────────────────────────────────────────────────
export interface SelectOutput {
  /** 结果列名(小写、去引号):别名,或裸列名;纯表达式且无别名 ⇒ null */
  name: string | null;
  /** 该结果列引用到的物理列名(小写、去引号;`t.col` 只取 `col`;经别名链展开,去重) */
  sources: string[];
}

export interface SelectOutputs {
  /** 最外层 select 的结果列(按出现顺序 —— 与结果集列顺序一致) */
  top: SelectOutput[];
  /** 全部层级里「别名 → 它引用的列」(CTE / 子查询里的别名也在) */
  aliasSources: Map<string, string[]>;
}

const IDENT_SRC = "(?:\"[^\"]+\"|[\\p{L}_][\\p{L}\\p{N}_$]*)";
const IDENT_PATH_SRC = `(?<![\\p{L}\\p{N}_$."])${IDENT_SRC}(?:\\.${IDENT_SRC})*`;
const ALIAS_AS_RE = new RegExp(`^([\\s\\S]*?\\S)\\s+as\\s+(${IDENT_SRC})\\s*$`, "iu");
const ALIAS_BARE_RE = new RegExp(`^([\\s\\S]*?[\\p{L}\\p{N}_)"$])\\s+(${IDENT_SRC})\\s*$`, "u");
const PLAIN_PATH_RE = new RegExp(`^${IDENT_SRC}(?:\\.${IDENT_SRC})*$`, "u");

// 表达式里不算「列引用」的词:SQL 关键字 / 常量 / 类型名 / 日期部件 / 窗口子句(函数名按「后面跟 (」识别)
const EXPR_NON_COLUMN = new Set<string>([
  ...Array.from(KEYWORDS),
  "null", "true", "false", "is", "like", "ilike", "similar", "to", "escape", "between", "in", "exists", "any", "some",
  "interval", "cast", "extract", "asc", "desc", "nulls", "first", "last", "at", "zone", "filter", "within", "rows", "range",
  "unbounded", "preceding", "following", "current", "row", "ignore", "respect", "date", "timestamp", "timestamptz", "time",
  "boolean", "bool", "int", "int2", "int4", "int8", "integer", "bigint", "smallint", "decimal", "numeric", "varchar",
  "character", "varying", "char", "text", "float", "float4", "float8", "double", "precision", "real", "year", "month",
  "day", "hour", "minute", "second", "week", "quarter", "epoch", "dow", "doy", "current_date", "current_timestamp",
  "current_time", "getdate", "sysdate", "now", "localtime", "localtimestamp",
]);

function unquoteLower(tok: string): string {
  return tok.replace(/"/g, "").toLowerCase();
}

/** `t.col` / `"a"."b c"` ⇒ 最后一段(小写、去引号)。 */
function lastSegment(path: string): string {
  const parts = path.match(new RegExp(IDENT_SRC, "gu")) || [path];
  return unquoteLower(parts[parts.length - 1]);
}

/** 按深度 0 的逗号切 select 列表项。 */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** 表达式里引用到的列名(小写、取路径最后一段;函数名 / 关键字 / 类型名 / `::type` 不算)。 */
function columnRefsIn(expr: string): string[] {
  const out: string[] = [];
  const re = new RegExp(IDENT_PATH_SRC, "gu");
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) {
    const tok = m[0];
    const before = expr.slice(0, m.index);
    const after = expr.slice(m.index + tok.length);
    if (/^\s*\(/.test(after)) continue; // 函数名
    if (/::\s*$/.test(before)) continue; // `x::varchar` 的类型
    if (!tok.includes(".") && !tok.startsWith("\"") && EXPR_NON_COLUMN.has(tok.toLowerCase())) continue;
    const col = lastSegment(tok);
    if (col && !out.includes(col)) out.push(col);
  }
  return out;
}

/** 一个 select 列表项 ⇒ (结果列名, 表达式文本)。 */
function splitAlias(item: string): { name: string | null; expr: string } {
  const trimmed = item.trim();
  if (trimmed === "*" || /\.\*$/.test(trimmed)) return { name: null, expr: "" };
  const asM = ALIAS_AS_RE.exec(trimmed);
  if (asM) return { name: unquoteLower(asM[2]), expr: asM[1] };
  const bareM = ALIAS_BARE_RE.exec(trimmed);
  if (bareM) {
    const alias = bareM[2];
    const exprEnd = (bareM[1].match(new RegExp(`${IDENT_SRC}\\s*$`, "u")) || [""])[0].toLowerCase();
    const aliasIsKeyword = !alias.startsWith("\"") && EXPR_NON_COLUMN.has(alias.toLowerCase());
    const exprEndsWithKeyword = !!exprEnd && exprEnd !== "end" && EXPR_NON_COLUMN.has(exprEnd); // `… then x` 不是别名
    if (!aliasIsKeyword && !exprEndsWithKeyword) return { name: unquoteLower(alias), expr: bareM[1] };
  }
  if (PLAIN_PATH_RE.test(trimmed)) return { name: lastSegment(trimmed), expr: trimmed }; // 裸列(可带路径)
  return { name: null, expr: trimmed };
}

/** SQL 里每个 `select … from` 的列表文本(含子查询 / CTE),并标出最外层(括号深度 0)那个。 */
function selectLists(sql: string): { list: string; top: boolean }[] {
  const depthAt: number[] = new Array(sql.length + 1);
  let d = 0;
  for (let i = 0; i < sql.length; i++) {
    depthAt[i] = d;
    if (sql[i] === "(") d++;
    else if (sql[i] === ")") d = Math.max(0, d - 1);
  }
  depthAt[sql.length] = d;
  const out: { list: string; top: boolean }[] = [];
  const selRe = /\bselect\b/gi;
  let m: RegExpExecArray | null;
  while ((m = selRe.exec(sql))) {
    const start = m.index + m[0].length;
    const depth = depthAt[m.index];
    let close = sql.length; // 本层括号闭合处(select 1 这种没 from 的靠它收尾)
    for (let i = start; i < sql.length; i++) {
      if (depthAt[i] < depth) {
        close = i;
        break;
      }
    }
    let end = close;
    const fromRe = /\bfrom\b/gi;
    fromRe.lastIndex = start;
    let fm: RegExpExecArray | null;
    while ((fm = fromRe.exec(sql)) && fm.index < close) {
      if (depthAt[fm.index] === depth) {
        end = fm.index;
        break;
      }
    }
    const semi = sql.indexOf(";", start);
    if (semi !== -1 && semi < end && depthAt[semi] === depth) end = semi;
    const list = sql.slice(start, end).replace(/^\s*(distinct|all)\b/i, "").replace(/^\s*top\s+\d+\b/i, "");
    out.push({ list, top: depth === 0 });
  }
  return out;
}

/** 把引用到的名字沿别名链展开(外层 `select 地区 from x` 的「地区」是 CTE 里 `country AS 地区` 起的名 ⇒ 展开到 country);
 *  `seen` 挡环、深度 ≤ 4 挡链太长;**不**按「与结果列同名」跳过 —— 外层裸引用内层别名时两者本来就同名。 */
function expandAliases(refs: string[], aliasSources: Map<string, string[]>): string[] {
  const out = new Set<string>();
  const seen = new Set<string>();
  const walk = (names: string[], depth: number) => {
    for (const n of names) {
      if (seen.has(n)) continue;
      seen.add(n);
      out.add(n);
      const inner = aliasSources.get(n);
      if (inner && depth < 4) walk(inner, depth + 1);
    }
  };
  walk(refs, 0);
  return Array.from(out);
}

/**
 * 解析 SQL 的结果列:最外层 select 每一列叫什么、引用了哪些物理列(别名链 / 子查询 / CTE 逐层展开)。
 * 脱敏据此把「结果列」对回「分级落在的物理列」。best-effort:解析失败回空(调用方回落到按结果列名匹配)。
 */
export function parseSelectOutputs(sql: string): SelectOutputs {
  const out: SelectOutputs = { top: [], aliasSources: new Map() };
  try {
    const clean = stripStrings(stripComments(sql || ""));
    const lists = selectLists(clean);
    const items = lists.map((l) => splitTopLevel(l.list).map(splitAlias));
    for (const arr of items) {
      for (const it of arr) {
        if (!it.name || !it.expr) continue;
        const refs = columnRefsIn(it.expr);
        if (!refs.length || (refs.length === 1 && refs[0] === it.name)) continue; // 裸列 / 自引用不算别名
        out.aliasSources.set(it.name, refs);
      }
    }
    const topIdx = lists.findIndex((l) => l.top);
    if (topIdx >= 0) {
      out.top = items[topIdx].map((it) => ({
        name: it.name,
        sources: expandAliases(it.expr ? columnRefsIn(it.expr) : [], out.aliasSources),
      }));
    }
  } catch {
    // best-effort
  }
  return out;
}
