// 数据质量规则模板库 (v1.10.0)
//
// 同构纯 TS：前端 import 元数据（QUALITY_TEMPLATES_META / DIMENSION_LABELS）渲染表单；
// 后端 import 全部（含 buildSql / evaluate / validateRule）生成校验 SQL 并判定结果。
//
// 安全（防 SQL 注入，高质量要点）：
//  - 标识符（schema/表/列）SQL 无法参数化 → 严格白名单校验后用双引号包裹；非法即抛错。
//  - 字面量：数值参数校验为有限数字后内联（数字无注入面）；字符串取值用单引号转义（'' ）后内联。
//  任何用户输入要么经白名单校验、要么经数字校验、要么经转义，绝不原样进入 SQL。

export type QualityDimension =
  | "completeness"
  | "uniqueness"
  | "validity"
  | "consistency"
  | "freshness";

export type Severity = "error" | "warn";
export type RuleStatus = "passed" | "failed" | "error";

export interface QualityParamSpec {
  key: string;
  label: string;
  type: "number" | "text" | "list";
  required?: boolean;
  placeholder?: string;
}

export interface QualityTemplateMeta {
  type: string;
  label: string;
  dimension: QualityDimension;
  needsColumn: boolean;
  description: string;
  params: QualityParamSpec[];
}

export const DIMENSION_LABELS: Record<QualityDimension, string> = {
  completeness: "完整性",
  uniqueness: "唯一性",
  validity: "有效性",
  consistency: "一致性",
  freshness: "新鲜度",
};

// Front-end-safe metadata (no SQL logic) used to render the "添加规则" form.
export const QUALITY_TEMPLATES_META: QualityTemplateMeta[] = [
  {
    type: "not_null",
    label: "非空 (Not Null)",
    dimension: "completeness",
    needsColumn: true,
    description: "字段空值率不超过阈值（默认 0%，即不允许空值）。",
    params: [{ key: "maxNullPct", label: "最大空值率 %", type: "number", placeholder: "默认 0" }],
  },
  {
    type: "unique",
    label: "唯一 (Unique)",
    dimension: "uniqueness",
    needsColumn: true,
    description: "字段值唯一，重复行数不超过阈值（默认 0）。",
    params: [{ key: "maxDupRows", label: "最大重复行数", type: "number", placeholder: "默认 0" }],
  },
  {
    type: "range",
    label: "数值范围 (Range)",
    dimension: "validity",
    needsColumn: true,
    description: "数值字段落在 [最小值, 最大值] 内（至少填一个）。",
    params: [
      { key: "min", label: "最小值", type: "number" },
      { key: "max", label: "最大值", type: "number" },
    ],
  },
  {
    type: "accepted_values",
    label: "枚举值 (Accepted Values)",
    dimension: "validity",
    needsColumn: true,
    description: "字段取值在允许集合内（逗号分隔）。",
    params: [{ key: "values", label: "允许值（逗号分隔）", type: "list", required: true, placeholder: "如: A,B,C" }],
  },
  {
    type: "row_count",
    label: "行数 (Row Count)",
    dimension: "consistency",
    needsColumn: false,
    description: "表行数落在 [最小值, 最大值] 内（至少填一个）。",
    params: [
      { key: "min", label: "最小行数", type: "number" },
      { key: "max", label: "最大行数", type: "number" },
    ],
  },
  {
    type: "freshness",
    label: "新鲜度 / SLA (Freshness)",
    dimension: "freshness",
    needsColumn: true,
    description: "时间字段的最新值距今不超过 SLA 小时数（超时即 SLA 违约）。",
    params: [{ key: "slaHours", label: "SLA 小时数", type: "number", required: true, placeholder: "如: 24" }],
  },
];

export function getTemplateMeta(type: string): QualityTemplateMeta | undefined {
  return QUALITY_TEMPLATES_META.find((t) => t.type === type);
}

// ─── 安全工具 ────────────────────────────────────────────────────────────────
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function safeIdent(name: string): string {
  if (!name || !IDENT_RE.test(name)) throw new Error(`非法标识符: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

// Physical "schema"."table" from an OM FQN (bgp-redshift.<db>.<schema>.<table>) or raw schema.table.
export function physicalTable(fqn: string): { schema: string; table: string } {
  const parts = (fqn || "").split(".").filter(Boolean);
  if (parts.length < 2) throw new Error(`无法解析表名: ${fqn}`);
  return { schema: parts[parts.length - 2], table: parts[parts.length - 1] };
}

function quoteTable(fqn: string): string {
  const { schema, table } = physicalTable(fqn);
  return `${safeIdent(schema)}.${safeIdent(table)}`;
}

function toFiniteNumber(v: unknown, label: string): number {
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) throw new Error(`${label} 必须是数字`);
  return n;
}

// Safe SQL string literal (single-quote escaped).
function strLit(v: unknown): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}

// Parse a comma-separated list into trimmed non-empty values.
function parseList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─── 规则实现 ────────────────────────────────────────────────────────────────
export interface RuleSpec {
  type: string;
  column?: string;
  params?: Record<string, unknown>;
}

export interface ResultRow {
  [alias: string]: number | null;
}

export interface RuleEvaluation {
  status: Exclude<RuleStatus, "error">;
  metric: number; // representative metric (null-% / dup rows / out-of-range / hours / row count)
  total?: number;
  failed?: number;
  detail: string;
  hours?: number; // freshness only
  slaHours?: number; // freshness only
}

interface TemplateImpl {
  build(fqn: string, column: string | undefined, params: Record<string, unknown>): string;
  evaluate(row: ResultRow, params: Record<string, unknown>): RuleEvaluation;
}

const round = (n: number, d = 0): number => {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
};

const IMPLS: Record<string, TemplateImpl> = {
  not_null: {
    build: (fqn, col) =>
      `SELECT COUNT(*) AS total, COUNT(*) - COUNT(${safeIdent(col!)}) AS failed FROM ${quoteTable(fqn)}`,
    evaluate: (row, params) => {
      const total = row.total ?? 0;
      const failed = row.failed ?? 0;
      const maxNullPct = params.maxNullPct == null || params.maxNullPct === "" ? 0 : toFiniteNumber(params.maxNullPct, "最大空值率");
      const pct = total > 0 ? (failed / total) * 100 : 0;
      return {
        status: pct <= maxNullPct ? "passed" : "failed",
        metric: round(pct, 2),
        total,
        failed,
        detail: `${failed}/${total} 空值（${round(pct, 2)}%，阈值 ${maxNullPct}%）`,
      };
    },
  },
  unique: {
    build: (fqn, col) =>
      `SELECT COUNT(*) AS total, COUNT(*) - COUNT(DISTINCT ${safeIdent(col!)}) AS failed FROM ${quoteTable(fqn)}`,
    evaluate: (row, params) => {
      const total = row.total ?? 0;
      const failed = row.failed ?? 0;
      const maxDup = params.maxDupRows == null || params.maxDupRows === "" ? 0 : toFiniteNumber(params.maxDupRows, "最大重复行数");
      return {
        status: failed <= maxDup ? "passed" : "failed",
        metric: failed,
        total,
        failed,
        detail: `${failed} 重复行（阈值 ${maxDup}）`,
      };
    },
  },
  range: {
    build: (fqn, col, params) => {
      const c = safeIdent(col!);
      const conds: string[] = [];
      if (params.min != null && params.min !== "") conds.push(`${c} < ${toFiniteNumber(params.min, "最小值")}`);
      if (params.max != null && params.max !== "") conds.push(`${c} > ${toFiniteNumber(params.max, "最大值")}`);
      if (!conds.length) throw new Error("范围规则需至少填写最小值或最大值");
      return `SELECT COUNT(*) AS total, SUM(CASE WHEN ${conds.join(" OR ")} THEN 1 ELSE 0 END) AS failed FROM ${quoteTable(fqn)}`;
    },
    evaluate: (row) => {
      const total = row.total ?? 0;
      const failed = row.failed ?? 0;
      return {
        status: failed === 0 ? "passed" : "failed",
        metric: failed,
        total,
        failed,
        detail: `${failed}/${total} 超出范围`,
      };
    },
  },
  accepted_values: {
    build: (fqn, col, params) => {
      const c = safeIdent(col!);
      const values = parseList(params.values);
      if (!values.length) throw new Error("枚举规则需至少一个允许值");
      const inList = values.map(strLit).join(", ");
      return `SELECT COUNT(*) AS total, SUM(CASE WHEN ${c} IS NOT NULL AND ${c}::varchar NOT IN (${inList}) THEN 1 ELSE 0 END) AS failed FROM ${quoteTable(fqn)}`;
    },
    evaluate: (row, params) => {
      const total = row.total ?? 0;
      const failed = row.failed ?? 0;
      const values = parseList(params.values);
      return {
        status: failed === 0 ? "passed" : "failed",
        metric: failed,
        total,
        failed,
        detail: `${failed}/${total} 不在允许集合 {${values.join(", ")}}`,
      };
    },
  },
  row_count: {
    build: (fqn) => `SELECT COUNT(*) AS total FROM ${quoteTable(fqn)}`,
    evaluate: (row, params) => {
      const total = row.total ?? 0;
      const hasMin = params.min != null && params.min !== "";
      const hasMax = params.max != null && params.max !== "";
      if (!hasMin && !hasMax) throw new Error("行数规则需至少填写最小或最大行数");
      const min = hasMin ? toFiniteNumber(params.min, "最小行数") : -Infinity;
      const max = hasMax ? toFiniteNumber(params.max, "最大行数") : Infinity;
      const ok = total >= min && total <= max;
      return {
        status: ok ? "passed" : "failed",
        metric: total,
        total,
        detail: `行数 ${total}（区间 [${hasMin ? min : "-"}, ${hasMax ? max : "-"}]）`,
      };
    },
  },
  freshness: {
    build: (fqn, col) =>
      `SELECT (DATEDIFF(second, MAX(${safeIdent(col!)}), GETDATE()) / 3600.0) AS hours FROM ${quoteTable(fqn)}`,
    evaluate: (row, params) => {
      const slaHours = toFiniteNumber(params.slaHours, "SLA 小时数");
      const hours = row.hours;
      if (hours == null) {
        return { status: "failed", metric: -1, detail: "无数据或时间列为空，无法计算新鲜度", slaHours };
      }
      const h = round(hours, 1);
      return {
        status: h <= slaHours ? "passed" : "failed",
        metric: h,
        hours: h,
        slaHours,
        detail: `最新数据距今 ${h} 小时（SLA ≤ ${slaHours} 小时）`,
      };
    },
  },
};

export function buildCheckSql(fqn: string, rule: RuleSpec): string {
  const impl = IMPLS[rule.type];
  if (!impl) throw new Error(`未知规则类型: ${rule.type}`);
  return impl.build(fqn, rule.column, rule.params || {});
}

export function evaluateRule(rule: RuleSpec, row: ResultRow): RuleEvaluation {
  const impl = IMPLS[rule.type];
  if (!impl) throw new Error(`未知规则类型: ${rule.type}`);
  return impl.evaluate(row, rule.params || {});
}

// Validate + normalize a rule on create. Throws a user-facing error on invalid input.
export function validateRuleInput(input: {
  type?: string;
  column?: string;
  params?: Record<string, unknown>;
  fqn?: string;
}): { type: string; column?: string; params: Record<string, unknown> } {
  const meta = input.type ? getTemplateMeta(input.type) : undefined;
  if (!meta) throw new Error("非法或缺失的规则类型");
  if (meta.needsColumn) {
    if (!input.column || !IDENT_RE.test(input.column)) throw new Error("该规则需要合法的字段名");
  }
  const params = input.params || {};
  // Build once against the (real) table to surface any param/identifier errors early.
  buildCheckSql(input.fqn || "bgp-redshift.dev.public.__validate__", {
    type: input.type!,
    column: input.column,
    params,
  });
  return { type: input.type!, column: meta.needsColumn ? input.column : undefined, params };
}
