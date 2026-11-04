// @kf-batch 37-sync-capability —— 同步向导「提交整形」的唯一作者(纯函数,判据见 __tests__/sync-task-payload.test.ts)。
//
// 从 SyncTaskModal.handleSubmit 原样抽出(改动前的输出被判据钉住),再加上序 37 新字段的整形:
//   🔴 存量任务零影响:编辑一个**没有**新字段的老任务、原样保存,请求体里**不许**多出任何新字段的缺省值
//      (overwriteScope:"table" / allowEmptyOverwrite:false / derivedColumns:[] / partitionKeys:[] / businessTimezone:"")。
//   🔴 但 PUT 是逐键 SET 合并(没出现在请求体里的字段保持原值)⇒ 老任务**原来就有**的新字段,用户把它改回
//      缺省时必须显式写回缺省值,否则「改回去」在服务端不生效。
//   ⇒ 判定 = 「等于缺省」且「原任务没有这个键」才剔除;否则照写。
//   whereClause / targetTableNames 是存量字段,原样透传(改动前就是这样)。
import type { DerivedColumn } from "@/lib/sync/run-vars";
import { whereOf } from "@/lib/sync/run-vars";

/** 列映射行(向导里每张表一组,include=false 的不提交)。 */
export interface FieldMappingRow {
  include?: boolean;
  [k: string]: unknown;
}

export interface BuildSyncTaskPayloadInput {
  /** form.getFieldsValue(true) 的结果 */
  formValues: Record<string, unknown>;
  /** 第 2 步勾选的普通源表(来自源库表清单) */
  selectedTables: string[];
  /** 带日期变量的源表名模板(不在源库表清单里,单独维护) */
  templateTables?: string[];
  /** 序 56:模板 → 样例表(只用来读列结构;不传 = 表单值里有什么用什么,没有就不写这个键) */
  templateSamples?: Record<string, string>;
  /** 每张表的列映射 */
  fieldMappings: Record<string, FieldMappingRow[] | undefined>;
  /** 编辑时的原任务(新建 = undefined) */
  original?: Record<string, unknown>;
}

/**
 * 序 37 新字段里有「缺省值」概念、需要零影响整形的那几个(whereClause 是存量字段,不在此列)。mergeKeys = B-61:只在 merge 时带。
 * templateSampleTables = 序 56:只带「仍在模板清单里且选了样例」的项,空 ⇒ 不写(存量任务零影响)。
 */
export const SYNC_CAPABILITY_SHAPED_KEYS = ["businessTimezone", "derivedColumns", "overwriteScope", "partitionKeys", "allowEmptyOverwrite", "mergeKeys", "templateSampleTables"] as const;

/** 合并键控件只在 writeMode=merge 时显示 / 提交(与向导里控件的显示条件同一句)。 */
export function mergeKeysApply(v: { writeMode?: unknown }): boolean {
  return v.writeMode === "merge";
}

/** 覆盖范围 / 空结果开关只在这种任务上有意义(与向导里控件的显示条件同一句)。 */
export function overwriteOptionsApply(v: { writeMode?: unknown; syncMode?: unknown }): boolean {
  return v.writeMode === "overwrite" && v.syncMode === "full";
}

/** 只在 writeMode=overwrite 时有意义的「读到 0 行也允许清空」。 */
export function allowEmptyApplies(v: { writeMode?: unknown }): boolean {
  return v.writeMode === "overwrite";
}

function isBlankDerived(d: unknown): boolean {
  if (!d || typeof d !== "object") return true;
  const r = d as Partial<DerivedColumn>;
  return !r.name && !r.sourceColumn && !r.format;
}

/**
 * 把一个新字段的「当前值」规整成「该提交的值」:返回 undefined 表示「等于缺省」。
 * 控件被隐藏时(写入模式 / 同步模式不适用)它的值一律视为缺省 —— 否则隐藏控件里残留的「按分区」
 * 会让一个追加任务过不了校验,用户却看不见是哪儿错了。
 */
function effectiveValue(key: (typeof SYNC_CAPABILITY_SHAPED_KEYS)[number], v: Record<string, unknown>): unknown {
  const raw = v[key];
  switch (key) {
    case "businessTimezone":
      return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
    case "derivedColumns": {
      if (!Array.isArray(raw)) return undefined;
      const rows = raw.filter((d) => !isBlankDerived(d));
      return rows.length ? rows : undefined;
    }
    case "overwriteScope":
      return overwriteOptionsApply(v) && raw === "partitions" ? "partitions" : undefined;
    case "partitionKeys":
      return overwriteOptionsApply(v) && v.overwriteScope === "partitions" && Array.isArray(raw) && raw.length ? raw : undefined;
    case "allowEmptyOverwrite":
      return allowEmptyApplies(v) && raw === true ? true : undefined;
    case "mergeKeys": {
      // 非 merge 时控件隐藏,残留的键不进请求体;merge 时非空数组照写(合法性由 validateSyncCapabilityFields 判)
      if (!mergeKeysApply(v) || !Array.isArray(raw)) return undefined;
      const keys = raw.filter((k) => typeof k === "string" && k.trim()).map((k) => String(k).trim());
      return keys.length ? keys : undefined;
    }
    case "templateSampleTables": {
      // 序 56:只保留「仍在源表清单里的带变量表名 → 非空样例」;模板被删 / 样例被清 ⇒ 这一项不带
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
      const templates = Array.isArray(v.sourceTables) ? v.sourceTables.filter((x) => typeof x === "string" && x.includes("$" + "{")) : [];
      const out: Record<string, string> = {};
      for (const [tpl, sample] of Object.entries(raw as Record<string, unknown>)) {
        if (templates.includes(tpl) && typeof sample === "string" && sample.trim()) out[tpl] = sample.trim();
      }
      return Object.keys(out).length ? out : undefined;
    }
  }
}

/** 「等于缺省」时要显式写回的缺省值(只用于原任务本来就有这个键的情形)。 */
const EXPLICIT_DEFAULT: Record<(typeof SYNC_CAPABILITY_SHAPED_KEYS)[number], unknown> = {
  businessTimezone: "",
  derivedColumns: [],
  overwriteScope: "table",
  partitionKeys: [],
  allowEmptyOverwrite: false,
  mergeKeys: [],
  templateSampleTables: {},
};

export function buildSyncTaskPayload(input: BuildSyncTaskPayloadInput): Record<string, unknown> {
  const { formValues, selectedTables, templateTables = [], templateSamples, fieldMappings, original } = input;
  const values: Record<string, unknown> = { ...formValues };
  // 序 56:样例表是向导状态(不在 Form 里),先放进 values 再由下面的整形按模板清单过滤
  if (templateSamples !== undefined) values.templateSampleTables = templateSamples;
  // @kf-batch 44-sync-switch-datasource —— 编辑时换了数据源:表单里预填的 sourceDatabase 是**旧源的库名**,不许带回去
  //   (服务端按新源重算;…7698 探针 2026-10-15:换到 sys 库后 PUT 仍带 sourceDatabase=ecommerce 并被原样落库)。
  if (original && original.datasourceId !== undefined && values.datasourceId !== original.datasourceId) delete values.sourceDatabase;
  // ── 改动前的整形(原样):源表 = 勾选的表;列映射只带 include 的列 ──
  const sourceTables = [...selectedTables, ...templateTables.filter((x) => !selectedTables.includes(x))];
  values.sourceTables = sourceTables;
  const fm: Record<string, FieldMappingRow[]> = {};
  sourceTables.forEach((tbl) => { fm[tbl] = fieldMappings[tbl]?.filter((f) => f.include) || []; });
  values.fieldMappings = fm;
  // ── 序 37 新字段:等于缺省且原任务没有这个键 ⇒ 剔除;原任务有 ⇒ 显式写回缺省 ──
  for (const key of SYNC_CAPABILITY_SHAPED_KEYS) {
    const eff = effectiveValue(key, values);
    if (eff !== undefined) { values[key] = eff; continue; }
    if (original && Object.prototype.hasOwnProperty.call(original, key) && original[key] !== undefined) values[key] = EXPLICIT_DEFAULT[key];
    else delete values[key];
  }
  return values;
}

/**
 * 前端校验时要不要带数据源范式(带了 ⇒ 非 JDBC 源上的过滤条件 / 表名模板会被拒)。
 * 存量任务里那条**从前不生效**的过滤条件原样保存时不带范式 —— 不因为源不是 JDBC 就拦住一次与它无关的编辑;
 * 只要过滤条件改过、或者有表名模板,就照常带上。
 */
export function paradigmForCapabilityCheck(payload: Record<string, unknown>, original: Record<string, unknown> | undefined, paradigm: string | undefined): string | undefined {
  const templated = Array.isArray(payload.sourceTables) && payload.sourceTables.some((x) => typeof x === "string" && x.includes("$" + "{"));
  if (original && !templated && whereOf(original) === whereOf(payload)) return undefined;
  return paradigm;
}
