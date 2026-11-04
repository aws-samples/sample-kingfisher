// (客户 2026-10-19 反馈 c:全平台无图形化建表 / 改表)
// **图形化改表的唯一作者**:把「现在的列」与「想要的列」做成一份变更计划(AlterPlan),再由计划生成 Redshift 语句。
//
// 【为什么要一个纯函数作者】此前全仓没有任何 ALTER TABLE:建模页改了列只会把 `applied` 置假,靠漂移检测 + 有损的
// FORCE-REBUILD(DROP + CREATE)。图形化改表要的是**无损**的结构演进,而 Redshift 能无损做的只有四件事:
//   ① ADD COLUMN(NOT NULL 必须带 DEFAULT,否则 Redshift 拒绝)② COMMENT ON COLUMN ③ ALTER COLUMN TYPE 只能**加宽 VARCHAR**
//   ④ DROP COLUMN(**不可逆**,PRINCIPLES §D-裁决「重档」:输入表名才放行,由调用方 / 路由把关)。
// 其余(改类型 / 改可空 / 改主键 / 改名)一律**如实拒绝并说明原因**,不悄悄 DROP 重建 —— 那正是「UI 宣称的能力必须有载体」。
//
// 🔴 计划与语句都只经本文件产出:home 直接执行、非主控区由 admin 执行器模板 `alter-model-table` 读台账上的计划再调本文件
//    (两边逐字节同一份语句;与 `buildCreateTableStatements` 的「home 与非 home 不能各建各的」同一条纪律)。
import { safeIdent, sqlString, normalizeColumnType } from "./redshift";
import { normalizeTypeName } from "./landing-shared";
import type { ModelColumn } from "./types";

/** 加列可带默认值(Redshift:新列 NOT NULL 必须有 DEFAULT)。 */
export interface AlterAddColumn extends ModelColumn {
  defaultValue?: string;
}

export interface AlterPlan {
  addColumns: AlterAddColumn[];
  /** 要删的列名(小写);不可逆 */
  dropColumns: string[];
  /** 注释变更;comment 为空串 = 清掉注释(COMMENT … IS NULL) */
  commentChanges: Array<{ column: string; comment: string }>;
  /** 只允许的类型变更:VARCHAR 加宽 */
  widenVarchar: Array<{ column: string; from: number; to: number }>;
}

export interface AlterRejection {
  column: string;
  reason: string;
}

export interface AlterPlanning {
  plan: AlterPlan;
  rejected: AlterRejection[];
}

export function emptyAlterPlan(): AlterPlan {
  return { addColumns: [], dropColumns: [], commentChanges: [], widenVarchar: [] };
}

export function isEmptyAlterPlan(plan: AlterPlan): boolean {
  return !plan.addColumns.length && !plan.dropColumns.length && !plan.commentChanges.length && !plan.widenVarchar.length;
}

/** 与 `applyModelTableById` 同一条口径的规范化类型(先 DDL 侧白名单,再观测侧别名归一)。 */
export function normalizedTypeOf(c: Pick<ModelColumn, "dataType" | "length" | "precision" | "scale">): string {
  return normalizeTypeName(normalizeColumnType(c.dataType, { length: c.length, precision: c.precision, scale: c.scale }));
}

const VARCHAR_RE = /^varchar\((\d+)\)$/;
const lower = (s: string) => String(s || "").trim().toLowerCase();

/**
 * 现在的列 × 想要的列 ⇒ 变更计划 + 被拒绝的项(每条带原因)。
 * 🔴 比较键是**小写列名**(Redshift 标识符不区分大小写);类型比较用规范化类型串。
 */
export function planAlter(current: readonly ModelColumn[], desired: readonly AlterAddColumn[]): AlterPlanning {
  const plan = emptyAlterPlan();
  const rejected: AlterRejection[] = [];
  const cur = new Map<string, ModelColumn>();
  for (const c of current) cur.set(lower(c.name), c);
  const want = new Map<string, AlterAddColumn>();
  for (const c of desired) {
    const key = lower(c.name);
    if (!key) {
      rejected.push({ column: "", reason: "列名为空" });
      continue;
    }
    if (want.has(key)) {
      rejected.push({ column: c.name, reason: "列名重复(Redshift 标识符不区分大小写)" });
      continue;
    }
    want.set(key, c);
  }

  for (const [key, c] of Array.from(want.entries())) {
    const old = cur.get(key);
    if (!old) {
      // 新列
      try {
        safeIdent(c.name);
        normalizedTypeOf(c);
      } catch (e) {
        rejected.push({ column: c.name, reason: String((e as Error)?.message ?? e) });
        continue;
      }
      if (c.nullable === false && (c.defaultValue == null || String(c.defaultValue).trim() === "")) {
        rejected.push({ column: c.name, reason: "新加 NOT NULL 列必须带默认值(Redshift 对已有行要填一个值)" });
        continue;
      }
      if (c.isPrimaryKey) {
        rejected.push({ column: c.name, reason: "不能把新列加成主键(Redshift 不支持事后增删主键声明)" });
        continue;
      }
      plan.addColumns.push(c);
      continue;
    }
    // 已有列:只认 注释变更 / VARCHAR 加宽;其它变更逐条拒绝
    let oldType = "";
    let newType = "";
    try {
      oldType = normalizedTypeOf(old);
      newType = normalizedTypeOf(c);
    } catch (e) {
      rejected.push({ column: c.name, reason: String((e as Error)?.message ?? e) });
      continue;
    }
    if (oldType !== newType) {
      const a = oldType.match(VARCHAR_RE);
      const b = newType.match(VARCHAR_RE);
      if (a && b && Number(b[1]) > Number(a[1])) {
        plan.widenVarchar.push({ column: old.name, from: Number(a[1]), to: Number(b[1]) });
      } else {
        rejected.push({
          column: c.name,
          reason: `Redshift 不支持把 ${oldType} 直接改成 ${newType}(只允许加宽 VARCHAR);要改类型请新建一列迁数据后再删旧列`,
        });
        continue;
      }
    }
    if ((old.nullable !== false) !== (c.nullable !== false)) {
      rejected.push({ column: c.name, reason: "Redshift 不支持事后改可空性(NOT NULL ⇄ NULL)" });
      continue;
    }
    if (!!old.isPrimaryKey !== !!c.isPrimaryKey) {
      rejected.push({ column: c.name, reason: "Redshift 不支持事后增删主键声明" });
      continue;
    }
    const oldComment = String(old.comment ?? "");
    const newComment = String(c.comment ?? "");
    if (oldComment !== newComment) plan.commentChanges.push({ column: old.name, comment: newComment });
  }

  for (const [key, old] of Array.from(cur.entries())) {
    if (!want.has(key)) plan.dropColumns.push(old.name);
  }
  return { plan, rejected };
}

/** 默认值字面量:数字 / 布尔 / NULL / 常见时间函数原样,其余按字符串转义。 */
function defaultLiteral(v: string): string {
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  if (/^(true|false)$/i.test(s)) return s.toUpperCase();
  if (/^(null|current_timestamp|current_date|getdate\(\)|sysdate)$/i.test(s)) return s.toUpperCase();
  return sqlString(s);
}

/**
 * 计划 ⇒ Redshift 语句(每条一个语句;顺序:加列 → 加宽 → 注释 → 删列;删列放最后,前面任一条失败就不会走到不可逆那步)。
 * 🔴 标识符一律 `safeIdent`(双引号 + 白名单),注释一律 `sqlString`;类型经 `normalizeColumnType` 白名单。
 */
export function buildAlterTableStatements(args: { schema: string; physicalTable: string; plan: AlterPlan }): string[] {
  const tbl = `${safeIdent(args.schema)}.${safeIdent(args.physicalTable)}`;
  const out: string[] = [];
  for (const c of args.plan.addColumns) {
    const type = normalizeColumnType(c.dataType, { length: c.length, precision: c.precision, scale: c.scale });
    const def = c.defaultValue != null && String(c.defaultValue).trim() !== "" ? ` DEFAULT ${defaultLiteral(String(c.defaultValue))}` : "";
    const nn = c.nullable === false ? " NOT NULL" : "";
    out.push(`ALTER TABLE ${tbl} ADD COLUMN ${safeIdent(c.name)} ${type}${def}${nn}`);
    if (c.comment) out.push(`COMMENT ON COLUMN ${tbl}.${safeIdent(c.name)} IS ${sqlString(c.comment)}`);
  }
  for (const w of args.plan.widenVarchar) {
    out.push(`ALTER TABLE ${tbl} ALTER COLUMN ${safeIdent(w.column)} TYPE VARCHAR(${Math.floor(w.to)})`);
  }
  for (const cc of args.plan.commentChanges) {
    out.push(`COMMENT ON COLUMN ${tbl}.${safeIdent(cc.column)} IS ${cc.comment ? sqlString(cc.comment) : "NULL"}`);
  }
  for (const d of args.plan.dropColumns) {
    out.push(`ALTER TABLE ${tbl} DROP COLUMN ${safeIdent(d)}`);
  }
  return out;
}

/** 观测到的真实列(来自 svv_columns / information_schema.columns)。 */
export interface CatalogLiveColumn {
  name: string;
  /** information_schema 口径的类型名,如 character varying / numeric / timestamp without time zone */
  dataType: string;
  length?: number | null;
  precision?: number | null;
  scale?: number | null;
  nullable?: boolean;
  comment?: string | null;
}

/** information_schema 类型名 ⇒ 平台 DDL 白名单类型(`DDL_TYPES` 的键)。不在白名单的类型**拒绝**,不猜。 */
const CATALOG_TYPE_MAP: Record<string, string> = {
  "character varying": "VARCHAR",
  varchar: "VARCHAR",
  character: "CHAR",
  char: "CHAR",
  bpchar: "CHAR",
  integer: "INTEGER",
  int4: "INTEGER",
  int: "INTEGER",
  bigint: "BIGINT",
  int8: "BIGINT",
  smallint: "SMALLINT",
  int2: "SMALLINT",
  numeric: "DECIMAL",
  decimal: "DECIMAL",
  real: "REAL",
  float4: "REAL",
  "double precision": "DOUBLE PRECISION",
  float8: "DOUBLE PRECISION",
  boolean: "BOOLEAN",
  bool: "BOOLEAN",
  date: "DATE",
  "timestamp without time zone": "TIMESTAMP",
  timestamp: "TIMESTAMP",
  "timestamp with time zone": "TIMESTAMPTZ",
  timestamptz: "TIMESTAMPTZ",
  super: "SUPER",
};

export class CatalogTypeUnsupported extends Error {
  constructor(public readonly column: string, public readonly dataType: string) {
    super(`列 ${column} 的类型 ${dataType} 不在平台 DDL 类型白名单里 ⇒ 这张表不能图形化改表(避免生成一条平台无法保证的语句)`);
    this.name = "CatalogTypeUnsupported";
  }
}

/** 真实列 ⇒ 台账列定义(图形化改表「认领」一张已存在的表时用)。 */
export function modelColumnFromCatalog(row: CatalogLiveColumn): ModelColumn {
  const raw = lower(row.dataType).replace(/\(.*\)$/, "").trim();
  const base = CATALOG_TYPE_MAP[raw];
  if (!base) throw new CatalogTypeUnsupported(row.name, row.dataType);
  const col: ModelColumn = { name: row.name, dataType: base, nullable: row.nullable !== false };
  if (base === "VARCHAR" || base === "CHAR") {
    if (row.length != null && Number.isFinite(Number(row.length))) col.length = Number(row.length);
  }
  if (base === "DECIMAL") {
    if (row.precision != null && Number.isFinite(Number(row.precision))) col.precision = Number(row.precision);
    if (row.scale != null && Number.isFinite(Number(row.scale))) col.scale = Number(row.scale);
  }
  if (row.comment) col.comment = String(row.comment);
  return col;
}
