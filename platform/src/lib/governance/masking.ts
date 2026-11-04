// 模块 18 — 字段脱敏 (v1.9.0;B-119 2026-10-23 结果列按物理列对分级)
//
// Server-side value masking applied to QUERY RESULTS only (never alters stored data).
// Used by the Redshift result path and GenBI. Platform admins bypass; users with an
// approved grant on a table see its columns unmasked. Best-effort: never throws (a failure
// returns the rows unchanged rather than breaking the query path).
//
// 🔴 B-119(序 41 页面驱动 gbc GC-11 真撞):分级落在**物理列**上,而结果列名是 SQL 给的 —— 问数模型几乎总写
//   `country AS 地区`,直查 / BI 里 `AS` 改名也是常态 ⇒ 只按结果列名匹配就永远对不上,L3 字段明文给非授权用户
//   (设计稿 18 §9 第 1 条自 v1.9.0 起一直「记入局限」)。现在每个结果列先经 `parseSelectOutputs` 解析成「它引用的
//   物理列」(别名链 / 表达式 / CTE / 子查询逐层展开),分级按**结果列名 ∪ 物理列**的任一命中取最强策略;
//   解析不出来(`*`、非 select)就只剩结果列名本身 —— 与修前同,不会更松。

import { createHash } from "crypto";
import { parseSqlLineage, parseSelectOutputs, tableFqn, type SelectOutput } from "@/lib/lineage/sql-lineage";
import { getClassificationsForTables, getUserGrantSet, type MaskStrategy } from "./classification";
import type { Identity } from "@/lib/auth/identity";

const RS = "bgp-redshift";

// FQN 约定不统一的兼容层:数据分级页存的 fqn 无前缀(redshift.dev.public.t),而 SQL 血缘/
// ColumnMetadata 侧构造带 OM 前缀(bgp-redshift.dev.public.t)。历史两套约定([[lineage-physical-endpoints]])
// 若只按一种匹配,脱敏配置永远命中不上→脱敏静默失效(安全 bug)。故查分级时对每个表 FQN 同时
// 尝试「带 bgp- 前缀」「去 bgp- 前缀」两种形态。
function fqnVariants(fqn: string): string[] {
  const v = new Set<string>([fqn]);
  if (fqn.startsWith("bgp-")) v.add(fqn.slice(4));
  else v.add("bgp-" + fqn);
  return Array.from(v);
}

function maskPartial(s: string): string {
  if (s.length <= 2) return "***";
  return s[0] + "*".repeat(s.length - 2) + s[s.length - 1];
}

// Mask a single value per strategy. null / empty are returned unchanged.
export function applyMask(value: unknown, strategy: MaskStrategy): unknown {
  if (value === null || value === undefined || strategy === "none") return value;
  const s = String(value);
  if (s === "") return value;
  switch (strategy) {
    case "full":
      return "***";
    case "hash":
      return "sha256:" + createHash("sha256").update(s).digest("hex").slice(0, 8);
    case "email": {
      const at = s.indexOf("@");
      if (at <= 0) return maskPartial(s);
      return `${s[0]}***${s.slice(at)}`;
    }
    case "partial":
      return maskPartial(s);
    default:
      return "***";
  }
}

// Pick the stronger of two strategies (used when a column name matches classifications in
// multiple referenced tables).
const STRENGTH: Record<MaskStrategy, number> = { none: 0, partial: 1, email: 1, hash: 2, full: 3 };
function strongest(a: MaskStrategy | null, b: MaskStrategy): MaskStrategy {
  if (!a) return b;
  return STRENGTH[b] > STRENGTH[a] ? b : a;
}

export interface MaskColumnMeta {
  name?: string;
  schemaName?: string;
  tableName?: string;
}

export interface MaskRowsInput {
  columns: MaskColumnMeta[];
  rows: unknown[][];
  sql?: string;
  database?: string;
  identity: Identity | null;
}

export interface MaskRowsOutput {
  rows: unknown[][];
  maskedColumns: string[];
}

/**
 * Mask classified columns in a query result for the given identity. Returns the (possibly
 * masked) rows + the list of masked column names. Best-effort; never throws.
 */
export async function maskRows(input: MaskRowsInput): Promise<MaskRowsOutput> {
  const { columns, rows, identity } = input;
  const passthrough: MaskRowsOutput = { rows, maskedColumns: [] };
  try {
    if (!columns?.length) return passthrough;
    if (identity?.isPlatformAdmin) return passthrough; // admins / super-users bypass
    const database = (input.database || "dev").toLowerCase();

    // Tables referenced by the query: precise from ColumnMetadata, plus SQL parse as fallback.
    // 每个表都展开两种 FQN 前缀形态,兼容分级存储(无前缀)与血缘(带 bgp- 前缀)两套约定。
    const refTables = new Set<string>();
    const addWithVariants = (fqn: string) => { for (const v of fqnVariants(fqn)) refTables.add(v); };
    for (const c of columns) {
      if (c.tableName) {
        addWithVariants(`${RS}.${database}.${(c.schemaName || "public").toLowerCase()}.${c.tableName.toLowerCase()}`);
      }
    }
    if (input.sql) {
      const parsed = parseSqlLineage(input.sql, { database });
      for (const s of parsed.sources) addWithVariants(tableFqn(s));
      for (const t of parsed.targets) addWithVariants(tableFqn(t));
    }
    if (!refTables.size) return passthrough;

    const classified = await getClassificationsForTables(refTables);
    let anyMaskable = false;
    for (const cols of Array.from(classified.values())) {
      for (const c of Array.from(cols.values())) if (c.maskStrategy !== "none") anyMaskable = true;
    }
    if (!anyMaskable) return passthrough;

    const grants = identity ? await getUserGrantSet(identity.username) : new Set<string>();

    // B-119:结果列 → 它引用的物理列。按位置对(结果集列序 = select 列表序,两边列数相等时)再按名对;
    //   候选 = 结果列名本身 ∪ 解析出的物理列(别名链展开)。没有 SQL / 解析不出 ⇒ 候选只剩结果列名(修前行为)。
    const outputs = input.sql ? parseSelectOutputs(input.sql) : null;
    const candidatesOf = (idx: number, cname: string): string[] => {
      const set = new Set<string>([cname]);
      if (outputs) {
        const byPos: SelectOutput | undefined = outputs.top.length === columns.length ? outputs.top[idx] : undefined;
        const byName = outputs.top.find((o) => o.name === cname);
        for (const o of [byPos, byName]) if (o) for (const s of o.sources) set.add(s);
      }
      return Array.from(set);
    };

    const colStrategy: (MaskStrategy | null)[] = columns.map((c, idx) => {
      const cname = (c.name || "").toLowerCase();
      if (!cname) return null;
      const cands = candidatesOf(idx, cname);
      // 1) exact: the column's own table (when ColumnMetadata.tableName is known)
      if (c.tableName) {
        const variants = fqnVariants(`${RS}.${database}.${(c.schemaName || "public").toLowerCase()}.${c.tableName.toLowerCase()}`);
        if (variants.some((f) => grants.has(f))) return null;
        let exact: MaskStrategy | null = null;
        for (const f of variants) {
          for (const cand of cands) {
            const m = classified.get(f)?.get(cand);
            if (m && m.maskStrategy !== "none") exact = strongest(exact, m.maskStrategy);
          }
        }
        return exact;
      }
      // 2) fallback: match by (result name ∪ physical sources) across referenced, non-granted tables
      let strat: MaskStrategy | null = null;
      for (const [fqn, cols] of Array.from(classified.entries())) {
        if (grants.has(fqn)) continue;
        for (const cand of cands) {
          const m = cols.get(cand);
          if (m && m.maskStrategy !== "none") strat = strongest(strat, m.maskStrategy);
        }
      }
      return strat;
    });

    if (!colStrategy.some(Boolean)) return passthrough;

    const maskedColumns: string[] = [];
    columns.forEach((c, i) => {
      if (colStrategy[i]) maskedColumns.push(c.name || `col${i}`);
    });
    const maskedRows = rows.map((row) =>
      row.map((v, i) => (colStrategy[i] ? applyMask(v, colStrategy[i] as MaskStrategy) : v))
    );
    return { rows: maskedRows, maskedColumns };
  } catch {
    return passthrough; // best-effort: never break the query path
  }
}
