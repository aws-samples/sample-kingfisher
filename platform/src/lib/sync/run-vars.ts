// @kf-batch 37-sync-capability —— 序 37「数据同步能力补齐」的**契约单一作者**。
//
// 同步任务的新能力(全部可选;不填 = 改动前的行为)都在这里定义合法形态,建任务 / 改任务路由、
// 脚本生成器、补数中心、向导界面引同一份,不各自再写一遍规则:
//   · whereClause          B-52:源端过滤条件(JDBC 源下推成子查询),可用日期变量
//   · 源表名模板            ④:sourceTables 里的表名可带日期变量(如 cf_point_${bizmonth}),必须显式给目标表名
//   · businessTimezone     ⑥:运行时没带业务日期参数时,按这个时区取「今天」(缺省 UTC,与平台 todayDs 同口径)
//   · derivedColumns       ⑤:派生列(如 create_date → month,格式 yyyyMM),写入前加到数据上
//   · overwriteScope       ⑤:覆盖写入的范围,table(缺省 = 整表)或 partitions(只覆盖本批涉及的分区)
//   · partitionKeys        ⑤:overwriteScope=partitions 时按哪些列判定「本批涉及的分区」
//   · allowEmptyOverwrite  B-53:覆盖写入读到 0 行默认失败;显式置 true 才允许清空
//   · sourceColumns        只读指定的源列(JDBC 投影下推;对应客户库 Reader 的 column 清单)。不填 = 全列(现状)。
//                          覆盖写进**已有** S3 Tables 表时按列名对齐,列集合 / 类型不一致就失败 —— 原来按位置 INSERT,
//                          列序不同会把值写进别的列(客户现有表的列序是客户自己配的,切换时必炸)。
//   · mergeKeys            B-61:writeMode=merge 时**必填**的合并键(按这些列 upsert)。🔴 没有缺省:缺键的 merge 任务
//                          建 / 改都是 400,生成器也拒 —— 原来 merge 静默退化成 append(重复行),正是「有静默合法默认值的参数」
//                          那一类缺陷。非 merge 任务带了它不报错、也不读。
//   · templateSampleTables 序 56(客户 2026-10-27 反馈):带日期变量的源表名 → 样例表(源库里一张同结构的真表)。样例表只用来
//                          读列结构(向导第 1 步字段映射 / 建表预览 / 派生列候选),**不会被同步**;键必须是本任务里带变量的源表名。
//   · 目标表名撞车守卫      序 56:任意两张源表(普通 / 带变量)解析并规范化后的目标表名相同 ⇒ 拒。客户为了「看列」把模板的某个
//                          月表也勾成普通表、两者目标名都是 ods_xxx ⇒ 同一次运行向同一张目标表写两次(覆盖模式下互相覆盖)。
//
// 🔴 日期变量的取值有两个作者:这里的 `syncRunVars`(TS,预览 / 校验用)与 `SYNC_RUN_VARS_PY`
//    (生成进 Glue 脚本、运行时算)。两份按同一张表实现,判据 run-vars-parity.test.ts 逐日比对。
//    调度 / 工作流节点重跑同一个 Glue 作业时不重新生成脚本,所以取值只能在脚本里运行时算。
import { paramSet, isValidDs } from "@/lib/etl/run-params";
import { resolveTargetTableName, type TargetNamingConfig } from "@/lib/sync/target-naming";
import { sanitizeS3TablesIdentifier } from "@/lib/sync/s3tables-identifier";

/** 业务日期参数名(与离线作业 Glue 路径同名;MWAA 运行时与补数都用它)。 */
export const SYNC_RUN_DATE_ARG = "--ds";

/** 手动运行 / 补数指定业务日期时传给 Glue StartJobRun 的参数。没指定日期就不传(脚本按时区取今天)。 */
export function syncRunArguments(runDate: string | undefined): Record<string, string> | undefined {
  if (!runDate) return undefined;
  if (!isValidDs(runDate)) throw new Error(`业务日期格式应为 YYYY-MM-DD:${JSON.stringify(runDate)}`);
  return { [SYNC_RUN_DATE_ARG]: runDate };
}

function shiftMonth(ds: string, offset: number): string {
  const y = Number(ds.slice(0, 4));
  const m = Number(ds.slice(5, 7));
  const idx = y * 12 + (m - 1) + offset;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`;
}

/**
 * 业务日期 ds(YYYY-MM-DD,缺省 = 运行当天)可用的全部变量。
 * 前六个 = 离线作业的 `paramSet`(同名同值);`run_date` / `yesterday` = 向导一直宣称可用的两个;
 * 月份变量;`bizdate` / `bizmonth` 系 = DataWorks 口径(bizdate = 运行日前一天,bizmonth = 运行日的上个月)。
 */
export function syncRunVars(ds: string): Record<string, string> {
  if (!isValidDs(ds)) throw new Error(`业务日期格式应为 YYYY-MM-DD:${JSON.stringify(ds)}`);
  const p = paramSet(ds);
  const lastMonth = shiftMonth(ds, -1);
  return {
    ...p,
    run_date: p.ds,
    yesterday: p.yesterday_ds,
    ds_month: ds.slice(0, 4) + ds.slice(5, 7),
    last_month: lastMonth.replace("-", ""),
    last_month_std: lastMonth,
    bizdate: p.yesterday_ds_nodash,
    bizdate_std: p.yesterday_ds,
    bizmonth: lastMonth.replace("-", ""),
    bizmonth_std: lastMonth,
  };
}

/** 全部合法变量名(顺序即界面展示顺序)。 */
export const SYNC_RUN_VAR_NAMES: readonly string[] = Object.keys(syncRunVars("2026-01-15"));

const VAR_RE = /\$\{([^}]*)\}/g;

/** 文本里出现的 `${...}` 变量名(含非法的)。 */
export function templateVarNames(text: unknown): string[] {
  if (typeof text !== "string") return [];
  return Array.from(text.matchAll(VAR_RE), (m) => m[1]);
}

function hasTemplate(text: unknown): boolean {
  return typeof text === "string" && text.includes("${");
}

/** 渲染(预览用;运行时由脚本里的 Python 同名函数做)。未知变量直接抛 —— 不许原样留在 SQL 里。 */
export function renderSyncTemplate(text: string, ds: string): string {
  const vars = syncRunVars(ds);
  const out = text.replace(VAR_RE, (m, k: string) => {
    if (!(k in vars)) throw new Error(`不支持的变量 \${${k}}(可用:${SYNC_RUN_VAR_NAMES.join(" / ")})`);
    return vars[k];
  });
  if (out.includes("${")) throw new Error(`变量写法不完整:${text}`);
  return out;
}

export const DERIVED_COLUMN_FORMATS = ["yyyyMM", "yyyyMMdd", "yyyy-MM", "yyyy-MM-dd", "yyyy"] as const;
export type DerivedColumnFormat = (typeof DERIVED_COLUMN_FORMATS)[number];
export interface DerivedColumn {
  /** 新列名(写进目标表;小写标识符) */
  name: string;
  /** 取值来源列(源表里的列;日期 / 时间戳 / 可转成时间戳的字符串) */
  sourceColumn: string;
  format: DerivedColumnFormat;
}
export const OVERWRITE_SCOPES = ["table", "partitions"] as const;
export type OverwriteScope = (typeof OVERWRITE_SCOPES)[number];

/** 序 37 新字段在任务行上的形态(全部可选)。 */
export interface SyncCapabilityFields {
  whereClause?: string;
  businessTimezone?: string;
  derivedColumns?: DerivedColumn[];
  overwriteScope?: OverwriteScope;
  partitionKeys?: string[];
  allowEmptyOverwrite?: boolean;
  sourceColumns?: Record<string, string[]>;
  /** B-61:合并键(writeMode=merge 时必填,非空;大小写不敏感去重) */
  mergeKeys?: string[];
}

const TARGET_IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const SOURCE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 这个任务的写入**走不走 Glue 脚本的 writeMode**。只有 Glue 通道的批 / 增量任务用它;
 * 实时(DMS CDC)与 Zero-ETL 通道有自己的写入语义(DMS 的删表与否由 targetTablePrepMode 决定)。
 * `validateSyncWriteFields`(写模式必填)与下面的合并键校验共用这一句 —— 两处口径不许分叉。
 */
export function usesGlueWriteMode(task: { syncMode?: unknown; channel?: unknown }): boolean {
  return task.syncMode !== "realtime" && task.channel !== "dms" && task.channel !== "zero-etl";
}

/**
 * 任务的合并键(规整后:去空白、大小写不敏感去重、保留首次出现的写法)。
 * 🔴 只做规整不做校验;合法性由 `validateSyncCapabilityFields` 判。不是数组 / 空 ⇒ `[]`(调用方据此拒绝,不许补缺省)。
 */
export function mergeKeysOf(task: { mergeKeys?: unknown }): string[] {
  if (!Array.isArray(task.mergeKeys)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of task.mergeKeys) {
    if (typeof k !== "string") continue;
    const s = k.trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out;
}

export function isValidBusinessTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 任务的过滤条件(去空白;空 = 没有)。 */
export function whereOf(task: { whereClause?: unknown }): string {
  return typeof task.whereClause === "string" ? task.whereClause.trim() : "";
}

/** 这个任务的运行结果是否取决于业务日期(⇒ 补数才有意义,运行时要解析日期)。 */
export function syncTaskUsesRunDate(task: { whereClause?: unknown; sourceTables?: unknown }): boolean {
  if (hasTemplate(whereOf(task))) return true;
  return Array.isArray(task.sourceTables) && task.sourceTables.some((t) => hasTemplate(t));
}

/** 任务指定的源列(源表名 → 列名数组;没指定的表不在里面 = 全列)。 */
export function sourceColumnsOf(task: { sourceColumns?: unknown }): Record<string, string[]> {
  const sc = task.sourceColumns;
  if (!sc || typeof sc !== "object" || Array.isArray(sc)) return {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(sc as Record<string, unknown>)) {
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) out[k] = v as string[];
  }
  return out;
}

/** 覆盖写入的实际范围(只在 writeMode=overwrite 且非增量时有意义)。 */
export function overwriteScopeOf(task: { overwriteScope?: unknown }): OverwriteScope {
  return task.overwriteScope === "partitions" ? "partitions" : "table";
}

type TaskLike = SyncCapabilityFields & {
  sourceTables?: unknown;
  targetTableNames?: unknown;
  targetTablePrefix?: unknown;
  targetTableSuffix?: unknown;
  templateSampleTables?: unknown;
  writeMode?: unknown;
  syncMode?: unknown;
  channel?: unknown;
  targetType?: unknown;
  s3Config?: { partitionFields?: Array<{ field?: unknown; type?: unknown }> } | null;
};

/** 任务上的目标表命名配置,规整成 resolveTargetTableName 能吃的形态(非字符串的键值一律当没填)。 */
function targetNamingOf(task: TaskLike): TargetNamingConfig {
  const names: Record<string, string> = {};
  if (task.targetTableNames && typeof task.targetTableNames === "object") {
    for (const [k, v] of Object.entries(task.targetTableNames as Record<string, unknown>)) if (typeof v === "string") names[k] = v;
  }
  return {
    targetTablePrefix: typeof task.targetTablePrefix === "string" ? task.targetTablePrefix : "",
    targetTableSuffix: typeof task.targetTableSuffix === "string" ? task.targetTableSuffix : "",
    targetTableNames: names,
  };
}

/** 任务的「带变量源表名 → 样例表」(序 56;只做规整不做校验,非对象 ⇒ {})。 */
export function templateSampleTablesOf(task: { templateSampleTables?: unknown }): Record<string, string> {
  const raw = task.templateSampleTables;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [tpl, sample] of Object.entries(raw as Record<string, unknown>)) if (typeof sample === "string" && sample.trim()) out[tpl] = sample.trim();
  return out;
}

/**
 * 序 56 守卫:两张源表(普通 / 带日期变量)解析后的目标表名相同 ⇒ 同一次运行向同一张目标表写两次
 * (覆盖模式下后写的盖掉先写的,追加模式下行数翻倍)。比较口径 = 生成器 Python 侧的 `_san`
 * (小写 + 非 [a-z0-9_] 换 _ + 数字开头补 _;TS 唯一作者 sanitizeS3TablesIdentifier),与真跑时落到哪张表一致。
 * 典型成因:为了看列结构,把模板的某个月表也勾成了普通表,两者的目标名都是 ods_xxx。返回说明文案;没有撞车 ⇒ null。
 */
export function targetTableNameCollision(task: TaskLike): string | null {
  const tables = Array.from(new Set(Array.isArray(task.sourceTables) ? task.sourceTables.map(String) : []));
  const naming = targetNamingOf(task);
  const firstBy = new Map<string, string>();
  for (const src of tables) {
    const target = sanitizeS3TablesIdentifier(resolveTargetTableName(src, naming));
    const prev = firstBy.get(target);
    if (prev === undefined) { firstBy.set(target, src); continue; }
    const tpl = hasTemplate(prev) ? prev : hasTemplate(src) ? src : null;
    const plain = tpl === prev ? src : prev;
    if (tpl && !hasTemplate(plain)) {
      return `普通表「${plain}」的目标表名「${target}」与带日期变量的表名「${tpl}」的固定目标表名相同:同一次运行会向同一张目标表写两次(覆盖模式下互相覆盖)。只想借「${plain}」的列结构,请把它设为「${tpl}」的样例表并取消勾选;确实要两份都同步,请改其中一个的目标表名`;
    }
    return `源表「${prev}」与「${src}」解析后的目标表名都是「${target}」:同一次运行会向同一张目标表写两次。请改其中一个的目标表名`;
  }
  return null;
}

/**
 * 校验序 37 新字段。返回第一条不合法的说明(中文,直接回给用户),全合法返回 null。
 * `paradigm`(数据源范式)已知时多校一条:过滤条件与表名模板只支持 JDBC 源。
 * 只看新字段;不带任何新字段的存量任务恒返回 null。
 */
export function validateSyncCapabilityFields(task: TaskLike, paradigm?: string): string | null {
  const t = task as Record<string, unknown>;
  if (t.whereClause !== undefined && t.whereClause !== null && typeof t.whereClause !== "string") {
    return "过滤条件(whereClause)必须是字符串";
  }
  const where = whereOf(task);
  const tables = Array.isArray(task.sourceTables) ? task.sourceTables.map(String) : [];
  const templated = tables.filter((x) => hasTemplate(x));
  for (const text of [where, ...templated]) {
    for (const name of templateVarNames(text)) {
      if (!SYNC_RUN_VAR_NAMES.includes(name)) {
        return `不支持的变量 \${${name}}(出现在「${text}」;可用:${SYNC_RUN_VAR_NAMES.join(" / ")})`;
      }
    }
    if (text.replace(VAR_RE, "").includes("${")) return `变量写法不完整:「${text}」`;
  }
  if (where.includes(";")) return "过滤条件里不能有分号(只写 WHERE 后面的条件)";
  if (paradigm && paradigm !== "jdbc" && (where || templated.length > 0)) {
    return `过滤条件与表名日期模板目前只支持 JDBC 类数据源(当前数据源范式 ${paradigm});请清空后再保存`;
  }
  const names = (task.targetTableNames && typeof task.targetTableNames === "object" ? task.targetTableNames : {}) as Record<string, unknown>;
  for (const tpl of templated) {
    const tn = names[tpl];
    if (typeof tn !== "string" || !tn.trim() || tn.includes("${")) {
      return `源表名「${tpl}」带日期变量,必须为它指定一个固定的目标表名(不能带变量)`;
    }
  }
  // 序 56:样例表只用来读列结构 —— 键必须是本任务里带变量的源表名,值是源库里一张真表(不带变量)
  if (t.templateSampleTables !== undefined && t.templateSampleTables !== null) {
    if (typeof t.templateSampleTables !== "object" || Array.isArray(t.templateSampleTables)) {
      return "样例表(templateSampleTables)必须是「带日期变量的源表名 → 样例表名」的对象";
    }
    for (const [tpl, sample] of Object.entries(t.templateSampleTables as Record<string, unknown>)) {
      if (!templated.includes(tpl)) return `样例表里的「${tpl}」不是本任务带日期变量的源表名`;
      if (typeof sample !== "string" || !sample.trim() || hasTemplate(sample)) {
        return `「${tpl}」的样例表名不合法:${JSON.stringify(sample)}(应是源库里一张真实存在的表,不带变量)`;
      }
    }
  }
  // 序 56:目标表名撞车(普通表 vs 模板的固定目标名 / 两张普通表规范化后同名)⇒ 拒,不等到真跑写两次
  const collision = targetTableNameCollision(task);
  if (collision) return collision;
  if (t.businessTimezone !== undefined && t.businessTimezone !== null && t.businessTimezone !== "" && !isValidBusinessTimezone(t.businessTimezone)) {
    return `业务日期时区不合法:${JSON.stringify(t.businessTimezone)}(应为 IANA 时区名,如 Asia/Singapore)`;
  }
  if (t.allowEmptyOverwrite !== undefined && typeof t.allowEmptyOverwrite !== "boolean") {
    return "allowEmptyOverwrite 必须是布尔值";
  }
  const derivedNames: string[] = [];
  if (t.derivedColumns !== undefined && t.derivedColumns !== null) {
    if (!Array.isArray(t.derivedColumns)) return "派生列(derivedColumns)必须是数组";
    for (const d of t.derivedColumns as Array<Record<string, unknown>>) {
      if (!d || typeof d !== "object") return "派生列每一项必须是对象";
      if (typeof d.name !== "string" || !TARGET_IDENT_RE.test(d.name)) return `派生列名不合法:${JSON.stringify(d.name)}(小写字母 / 数字 / 下划线,字母或下划线开头)`;
      if (typeof d.sourceColumn !== "string" || !SOURCE_IDENT_RE.test(d.sourceColumn)) return `派生列「${d.name}」的来源列不合法:${JSON.stringify(d.sourceColumn)}`;
      if (!(DERIVED_COLUMN_FORMATS as readonly string[]).includes(String(d.format))) return `派生列「${d.name}」的格式不支持:${JSON.stringify(d.format)}(可选:${DERIVED_COLUMN_FORMATS.join(" / ")})`;
      if (derivedNames.includes(d.name)) return `派生列名重复:${d.name}`;
      derivedNames.push(d.name);
    }
  }
  if (t.sourceColumns !== undefined && t.sourceColumns !== null) {
    if (typeof t.sourceColumns !== "object" || Array.isArray(t.sourceColumns)) return "sourceColumns 必须是「源表名 → 列名数组」的对象";
    const derivedSources = Array.isArray(t.derivedColumns)
      ? (t.derivedColumns as Array<{ sourceColumn?: unknown }>).map((d) => String(d?.sourceColumn ?? "").toLowerCase())
      : [];
    for (const [tbl, cols] of Object.entries(t.sourceColumns as Record<string, unknown>)) {
      if (!tables.includes(tbl)) return `sourceColumns 里的表「${tbl}」不在源表清单里`;
      if (!Array.isArray(cols) || cols.length === 0) return `源表「${tbl}」的列清单(sourceColumns)必须是非空数组`;
      const seen = new Set<string>();
      for (const c of cols) {
        if (typeof c !== "string" || !SOURCE_IDENT_RE.test(c)) return `源表「${tbl}」的列名不合法:${JSON.stringify(c)}`;
        if (seen.has(c.toLowerCase())) return `源表「${tbl}」的列名重复:${c}`;
        seen.add(c.toLowerCase());
      }
      for (const ds of derivedSources) {
        if (ds && !seen.has(ds)) return `源表「${tbl}」只读 ${(cols as string[]).join(", ")},而派生列的来源列 ${ds} 不在其中`;
      }
    }
    if (paradigm && paradigm !== "jdbc") return `指定源列(sourceColumns)目前只支持 JDBC 类数据源(当前数据源范式 ${paradigm})`;
  }
  // B-61:合并写入必须给合并键。只对走 Glue 脚本的任务判(实时 DMS 的 merge 是 CDC 自己的语义,不用这个字段);
  //   非 merge 带了 mergeKeys 不报错(生成器不读)。🔴 不给缺省、不猜主键 —— 猜错就是把别的行合并掉。
  if (task.writeMode === "merge" && usesGlueWriteMode(task)) {
    if (t.mergeKeys !== undefined && t.mergeKeys !== null && !Array.isArray(t.mergeKeys)) return "合并键(mergeKeys)必须是列名数组";
    const raw = Array.isArray(t.mergeKeys) ? (t.mergeKeys as unknown[]) : [];
    for (const k of raw) {
      if (typeof k !== "string" || !SOURCE_IDENT_RE.test(k.trim())) return `合并键不合法:${JSON.stringify(k)}(列名:字母 / 数字 / 下划线,字母或下划线开头)`;
    }
    if (mergeKeysOf(task).length === 0) return "合并写入(merge)必须指定合并键(mergeKeys,至少一列):按这些列判定「同一行」做更新,其余插入;不提供缺省";
  }
  if (t.overwriteScope !== undefined && t.overwriteScope !== null && !(OVERWRITE_SCOPES as readonly string[]).includes(String(t.overwriteScope))) {
    return `覆盖范围不合法:${JSON.stringify(t.overwriteScope)}(可选:table / partitions)`;
  }
  if (t.partitionKeys !== undefined && t.partitionKeys !== null) {
    if (!Array.isArray(t.partitionKeys) || t.partitionKeys.some((k) => typeof k !== "string" || !SOURCE_IDENT_RE.test(k))) {
      return "partitionKeys 必须是列名数组";
    }
  }
  if (overwriteScopeOf(task) === "partitions") {
    if (task.writeMode !== "overwrite" || task.syncMode === "incremental") {
      return "按分区覆盖只适用于「全量 + 覆盖写入」的任务";
    }
    const keys = Array.isArray(task.partitionKeys) ? task.partitionKeys : [];
    if (keys.length === 0) return "按分区覆盖必须指定分区列(partitionKeys)";
    if ((task.targetType === "redshift" || task.targetType === "both") && keys.length !== 1) {
      // Redshift 没有分区,按分区覆盖 = 一个事务里「删掉本批涉及的分区键 + 插入」;本期只支持单列分区键。
      return "写 Redshift 的按分区覆盖目前只支持一个分区列";
    }
    if (task.targetType === "s3-tables" || task.targetType === "both") {
      // 🔴 Iceberg 的动态分区覆盖按**表的分区规格**替换分区;规格若比分区列细(多一个 days(x))
      //    或粗(无分区 ⇒ 整表被替换),「只覆盖本批涉及的分区」就不成立。⇒ 规格必须恰好等于分区列(恒等变换)。
      const pf = task.s3Config?.partitionFields || [];
      const identity = pf.filter((p) => p && p.type !== "date" && p.type !== "year-month").map((p) => String(p.field));
      const transformed = pf.filter((p) => p && (p.type === "date" || p.type === "year-month"));
      const same = identity.length === keys.length && keys.every((k) => identity.includes(k));
      if (transformed.length > 0 || !same) {
        return `按分区覆盖写 S3 Tables 时,表的分区字段必须恰好是分区列 ${keys.join(", ")}(按原值分区,不能再带按天 / 按月变换)`;
      }
    }
  }
  return null;
}
