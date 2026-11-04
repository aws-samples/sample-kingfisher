// @kf-batch 50-PROD-A-launch-hardening
/**
 * 同步写 Redshift 时「**不许静默清空客户已有的表**」的唯一作者。
 *
 * 【为什么有它(生产上线批次 A,2026-10-09)】
 * 平台要接客户**已有**的数仓。原来:
 *   · 全量 `overwrite` 每次跑都 `DELETE FROM <整表>`;「增量但水位为空」同样整表清空;
 *   · 「表已存在」检测把带双引号的 `"public"` 拼进 `table_schema='"public"'` ⇒ 恒为假 ⇒ 页面上那个
 *     橙色「表已存在」标签从来没亮过;
 *   · 于是选中一张同名的客户表 ⇒ 第一次运行就把它清空,全程没有任何提示。
 *
 * 【规则 —— 守在「真正清空」的那一刻,而不是只守在建任务时】
 * 建任务时的检查挡不住:定时调度 / API / Copilot 都不经过向导,客户也可能在建任务**之后**才建出同名表。
 * 唯一所有入口都必经的点 = Glue 脚本里的整表 `DELETE`。规则:
 *   ① 平台**自己建的**表打标记(`COMMENT ON TABLE … IS '<PLATFORM_TABLE_MARKER>'`)——
 *      两个建表入口都打:同步脚本里的 `CREATE TABLE IF NOT EXISTS`、向导的 `/api/sync/execute-ddl`;
 *   ② 要整表清空一张**已存在且没有平台标记**的表 ⇒ 它必须在任务的 `overwriteConfirmedTables` 里
 *      (用户在页面上逐表确认过),否则**这次运行直接失败、一行都不删**;
 *   ③ 建任务 / 改任务时提前探一次,把「将被清空的非平台表」列给用户确认(409 + 清单)—— 这是体验,
 *      不是防线;探不到(数仓暂不可达)不拦创建,防线在 ②。
 *
 * 【序 37 B-60:S3 Tables 路与 Redshift 规则逐字对齐】原来这套只守 Redshift;覆盖写进客户已有的 S3 Tables 表直接替换。
 *   · 标记:平台建的 Iceberg 表在 TBLPROPERTIES 里带 `bgp.created-by = <PLATFORM_TABLE_MARKER>`(S3_TABLE_MARKER_PROPERTY);
 *   · 守卫:脚本在任何写 / 删之前 SHOW TBLPROPERTIES,无标记且不在确认清单 ⇒ SYNC_REFUSED_CLEAR_FOREIGN_TABLE;
 *   · 确认项形态 = Spark 三段名 `s3tablescatalog.<namespace>.<table>`(与脚本里 s3t_table 逐字相等,不会与 schema.table 混淆);
 *   · 提前告知:GetTable 拿 metadataLocation → 读 Iceberg 元数据 JSON 的 properties 看标记;任何一步失败 ⇒ unknown(防线在脚本)。
 *   · merge(B-61)不整表清空 ⇒ 两条路都不需要确认。
 */
import { ExecuteStatementCommand, DescribeStatementCommand, GetStatementResultCommand } from "@aws-sdk/client-redshift-data";
import { GetTableCommand, ListTableBucketsCommand } from "@aws-sdk/client-s3tables";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { redshiftDataClientFor, s3ClientFor, s3tablesClientFor } from "@/lib/exec-env/target-clients";
import { bindingTargets, resolveGlueBinding, resolveRedshiftBinding } from "@/lib/exec-env/data-plane-target";
// @kf-batch 56-B127-exec-env-own-table-bucket —— 「任务写哪个表桶」的唯一作者(与 start-run / 生成器同一函数)
import { effectiveTableBucket } from "./table-bucket";
import { buildTargetNameMap } from "./target-naming";
import { sanitizeS3TablesIdentifier } from "./s3tables-identifier";
import { usesGlueWriteMode } from "./run-vars";

/** 平台建表的标记。Python 脚本侧由生成器注入同一个值(不在 Python 里写第二份字面量)。 */
export const PLATFORM_TABLE_MARKER = "bgp-platform-created";
/** S3 Tables(Iceberg)表上放这个标记的表属性键;值 = PLATFORM_TABLE_MARKER。生成器注入,Python 不写第二份。 */
export const S3_TABLE_MARKER_PROPERTY = "bgp.created-by";
/** Spark 侧 S3 Tables 目录名(脚本里 s3t_table 的第一段;与生成器 S3T_CATALOG 同值)。 */
export const S3T_CATALOG = "s3tablescatalog";

/** 同步任务的写入模式 —— 合法值唯一来源。🔴 没有缺省值:缺 = 400,不许静默变成 overwrite。 */
export const SYNC_WRITE_MODES = ["overwrite", "append", "merge"] as const;
export type SyncWriteMode = (typeof SYNC_WRITE_MODES)[number];
export function isSyncWriteMode(v: unknown): v is SyncWriteMode {
  return typeof v === "string" && (SYNC_WRITE_MODES as readonly string[]).includes(v);
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Redshift `schema.table` 形态(小写、已安全化)。 */
const FQ = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
/** S3 Tables Spark 三段名 `s3tablescatalog.namespace.table`(小写、已安全化;与脚本 s3t_table 逐字相等)。 */
const S3_FQ = /^s3tablescatalog\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
/** 确认清单只收这两种形态,别的一律 400。`s3tablescatalog.` 开头的必须是三段(两段会被当成一个叫 s3tablescatalog 的 Redshift schema,歧义 ⇒ 拒)。 */
const CONFIRMABLE = (s: string) => S3_FQ.test(s) || (FQ.test(s) && !s.startsWith(`${S3T_CATALOG}.`));

export interface GuardTaskShape {
  targetType?: string;
  syncMode?: string;
  writeMode?: string;
  incrementalColumn?: string;
  incrementalValue?: unknown;
  sourceTables?: string[];
  redshiftConfig?: { schema?: string };
  s3Config?: { namespace?: string; tableBucket?: string } | null;
  targetTablePrefix?: string;
  targetTableSuffix?: string;
  targetTableNames?: Record<string, string>;
  overwriteConfirmedTables?: unknown;
}

/** 这个任务的某次运行**会不会整表清空**目标表。与脚本里两条整表 DELETE 的条件逐字对齐。 */
export function clearsWholeTable(task: GuardTaskShape): boolean {
  // 脚本:INCREMENTAL = (syncMode == incremental);inc_where 只在「有增量列 且 有水位」时非空;
  //   INCREMENTAL 且 inc_where 为空 ⇒ 整表 DELETE;非增量 ⇒ 按 writeMode(overwrite = 整表 DELETE)。
  //   序 37 B-61:merge 按键合并,不走预删也不清表(增量 + merge 同样走 merge 分支)⇒ 恒不清空。
  if (task.writeMode === "merge") return false;
  if (task.syncMode === "incremental") {
    const v = task.incrementalValue;
    return !task.incrementalColumn || v === undefined || v === null || String(v) === "";
  }
  return task.writeMode === "overwrite";
}

export function writesRedshift(task: GuardTaskShape): boolean {
  return task.targetType === "redshift" || task.targetType === "both";
}

export function writesS3Tables(task: GuardTaskShape): boolean {
  return task.targetType === "s3-tables" || task.targetType === "both";
}

/** 目标 schema(与脚本 `rs_schema` 同源);非法标识符 ⇒ 抛(调用方 400)。 */
export function targetSchemaOf(task: GuardTaskShape): string {
  const s = task.redshiftConfig?.schema || "public";
  if (!IDENT.test(s)) throw new Error(`非法 schema「${s}」`);
  return s.toLowerCase();
}

/** 目标表全名清单(`schema.table`),与脚本里 target_names + 安全化的结果逐字一致。 */
export function redshiftTargetTables(task: GuardTaskShape): string[] {
  const schema = targetSchemaOf(task);
  const map = buildTargetNameMap(task.sourceTables || [], task);
  return Object.values(map).map((n) => `${schema}.${sanitizeS3TablesIdentifier(n)}`);
}

/**
 * S3 Tables 目标表的 Spark 三段名清单(`s3tablescatalog.<namespace>.<table>`),与脚本里 `s3t_table` 逐字一致。
 * namespace 与脚本 / 启动路由同一口径:`sanitizeS3TablesIdentifier(task.s3Config?.namespace || ds.database || "default")`。
 * 🔴 任务没自带 namespace 又拿不到数据源行(`ds === undefined`)⇒ 抛(调用方按 unknown 处理),不猜一个 namespace。
 */
export function s3TargetTables(task: GuardTaskShape, ds: { database?: unknown } | undefined): string[] {
  const own = typeof task.s3Config?.namespace === "string" ? task.s3Config.namespace : "";
  if (!own && ds === undefined) throw new Error("任务没有 s3Config.namespace 且拿不到数据源行,无法确定 S3 Tables 命名空间");
  const dsDb = typeof ds?.database === "string" ? ds.database : "";
  const namespace = sanitizeS3TablesIdentifier(own || dsDb || "default");
  const map = buildTargetNameMap(task.sourceTables || [], task);
  return Object.values(map).map((n) => `${S3T_CATALOG}.${namespace}.${sanitizeS3TablesIdentifier(n)}`);
}

/** 确认清单的校验与规整:`schema.table` 或 `s3tablescatalog.ns.table` 字符串数组;缺省 = 空清单(= 什么都没确认)。 */
export function parseConfirmedTables(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !CONFIRMABLE(x))) {
    throw new Error("overwriteConfirmedTables 必须是 schema.table(Redshift)或 s3tablescatalog.namespace.table(S3 Tables)形态(小写字母数字下划线)的字符串数组");
  }
  return Array.from(new Set(v as string[])).sort();
}

export interface TableState { fq: string; exists: boolean; platformCreated: boolean }

/** 一次 Data API 查询拿到一组表「在不在 / 是不是平台建的」。名字先过校验再拼(结构上只含 [a-z0-9_])。 */
export async function probeTables(
  rsb: { region: string; workgroup: string; database: string; secretArn?: string },
  fqs: string[],
): Promise<TableState[]> {
  if (fqs.length === 0) return [];
  for (const fq of fqs) if (!FQ.test(fq)) throw new Error(`非法表名「${fq}」`);
  const pairs = fqs.map((fq) => { const [s, t] = fq.split("."); return `(n.nspname = '${s}' AND c.relname = '${t}')`; }).join(" OR ");
  const sql =
    "SELECT n.nspname, c.relname, COALESCE(d.description, '') " +
    "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
    "LEFT JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0 " +
    `WHERE c.relkind = 'r' AND (${pairs})`;
  const rs = redshiftDataClientFor(rsb.region);
  const { Id } = await rs.send(new ExecuteStatementCommand({
    Sql: sql, WorkgroupName: rsb.workgroup, Database: rsb.database, ...(rsb.secretArn ? { SecretArn: rsb.secretArn } : {}),
  }));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const d = await rs.send(new DescribeStatementCommand({ Id }));
    if (d.Status === "FAILED" || d.Status === "ABORTED") throw new Error(`探测目标表失败:${d.Error || d.Status}`);
    if (d.Status !== "FINISHED") continue;
    const found = new Map<string, boolean>();
    if (d.HasResultSet) {
      const r = await rs.send(new GetStatementResultCommand({ Id }));
      for (const row of r.Records || []) {
        const fq = `${row[0]?.stringValue}.${row[1]?.stringValue}`;
        found.set(fq, String(row[2]?.stringValue || "") === PLATFORM_TABLE_MARKER);
      }
    }
    return fqs.map((fq) => ({ fq, exists: found.has(fq), platformCreated: found.get(fq) === true }));
  }
  throw new Error("探测目标表超时");
}

/**
 * 序 37 B-60:一组 S3 Tables 表「在不在 / 是不是平台建的」。**尽力而为**:
 *   ListTableBuckets 找到表桶 ARN → GetTable(不存在 = NotFoundException)→ 读 `metadataLocation` 指向的 Iceberg
 *   元数据 JSON,看 `properties[S3_TABLE_MARKER_PROPERTY]`。除「表不存在」外任何失败都抛(调用方按 unknown 处理,
 *   不拦创建;防线在脚本里 SHOW TBLPROPERTIES 那道守卫)。
 * 🔴 元数据对象的读取走 S3 API 打表桶的内部存储位置;IAM 侧由 TaskRole 的 s3tables 授权背书(清单已登记),现网未实测。
 */
export async function probeS3Tables(
  landing: { region: string; tableBucket: string },
  fqs: string[],
): Promise<TableState[]> {
  if (fqs.length === 0) return [];
  for (const fq of fqs) if (!S3_FQ.test(fq)) throw new Error(`非法 S3 Tables 表名「${fq}」`);
  const s3t = await s3tablesClientFor(landing.region);
  const { tableBuckets = [] } = await s3t.send(new ListTableBucketsCommand({}));
  const bucketArn = tableBuckets.find((b) => b.name === landing.tableBucket)?.arn;
  if (!bucketArn) throw new Error(`表桶 ${landing.tableBucket} 在 ${landing.region} 不存在(平台表桶尚未初始化,或自有表桶名不对)`);
  const s3 = await s3ClientFor(landing.region);
  const out: TableState[] = [];
  for (const fq of fqs) {
    const [, namespace, name] = fq.split(".");
    let metadataLocation: string | undefined;
    try {
      const t = await s3t.send(new GetTableCommand({ tableBucketARN: bucketArn, namespace, name }));
      metadataLocation = t.metadataLocation;
    } catch (e) {
      if ((e as { name?: string })?.name === "NotFoundException") { out.push({ fq, exists: false, platformCreated: false }); continue; }
      throw e;
    }
    // 表在、但还没有元数据(刚建的空壳)⇒ 当「非平台建」处理(让用户确认,比静默替换稳妥)
    if (!metadataLocation) { out.push({ fq, exists: true, platformCreated: false }); continue; }
    const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(metadataLocation);
    if (!m) throw new Error(`metadataLocation 形态不认识:${metadataLocation}`);
    const obj = await s3.send(new GetObjectCommand({ Bucket: m[1], Key: m[2] }));
    const text = await obj.Body?.transformToString();
    const meta = JSON.parse(text || "{}") as { properties?: Record<string, unknown> };
    out.push({ fq, exists: true, platformCreated: String(meta.properties?.[S3_TABLE_MARKER_PROPERTY] ?? "") === PLATFORM_TABLE_MARKER });
  }
  return out;
}

/** 会被整表清空、却**既不是平台建的、也没被确认**的表。 */
export function unconfirmedForeignTables(states: TableState[], confirmed: string[]): string[] {
  const ok = new Set(confirmed);
  return states.filter((s) => s.exists && !s.platformCreated && !ok.has(s.fq)).map((s) => s.fq);
}

/** 给建表语句配一句打标记的 SQL(两个建表入口共用)。`fq` 必须已过校验。 */
export function markPlatformTableSql(fq: string): string {
  if (!FQ.test(fq)) throw new Error(`非法表名「${fq}」`);
  return `COMMENT ON TABLE ${fq} IS '${PLATFORM_TABLE_MARKER}'`;
}

export type OverwritePreflight =
  | { kind: "ok" }
  | { kind: "needs-confirm"; tables: string[] }
  | { kind: "unknown"; reason: string };

/**
 * 建任务 / 改任务时的**提前告知**(规则 ③):这个任务一跑会整表清空哪些「已存在且不是平台建的」表?
 * 落点与运行时同一个解析(`bindingTargets(task)[0]` + `resolveRedshiftBinding` / `resolveGlueBinding`,与 sync/[id]/start 逐字同源)。
 * Redshift 与 S3 Tables 两条路各探各的:任一路探出要确认的表 ⇒ needs-confirm(先把能确定的列给用户);
 * 没探出任何表而某一路探不到 ⇒ `unknown`(不拦创建;真正的防线是脚本里清表前那道守卫)。
 * `opts.ds` = 数据源行(S3 Tables 的 namespace 缺省取它的库名);不传且任务没自带 namespace ⇒ S3 路 unknown。
 */
export async function overwritePreflight(
  task: GuardTaskShape & { channel?: string; projectId?: unknown; targets?: unknown; targetId?: unknown; redshiftConfig?: { schema?: string; workgroupName?: string; database?: string } },
  opts?: { ds?: { database?: unknown } },
): Promise<OverwritePreflight> {
  if (task.syncMode === "realtime" || (task.channel && task.channel !== "glue")) return { kind: "ok" };
  if (!clearsWholeTable(task)) return { kind: "ok" };
  const probeRs = writesRedshift(task);
  const probeS3 = writesS3Tables(task);
  if (!probeRs && !probeS3) return { kind: "ok" };
  const tid = bindingTargets(task as { targets?: unknown; targetId?: unknown })[0];
  if (!tid) return { kind: "unknown", reason: "任务未绑定执行环境" };
  const confirmed = parseConfirmedTables(task.overwriteConfirmedTables);
  const tables: string[] = [];
  const failures: string[] = [];
  if (probeRs) {
    try {
      const fqs = redshiftTargetTables(task);
      if (fqs.length > 0) {
        const rsb = await resolveRedshiftBinding({
          targetId: tid,
          projectId: typeof task.projectId === "string" ? task.projectId : null,
          workgroupOverride: task.redshiftConfig?.workgroupName,
          databaseOverride: task.redshiftConfig?.database,
        });
        tables.push(...unconfirmedForeignTables(await probeTables(rsb, fqs), confirmed));
      }
    } catch (e) {
      failures.push(`redshift: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    }
  }
  if (probeS3) {
    try {
      const fqs = s3TargetTables(task, opts?.ds);
      if (fqs.length > 0) {
        const landing = await resolveGlueBinding({ targetId: tid });
        // B-127 附带:探任务**实际写**的桶(自带桶优先),不是一律探执行环境的平台表桶 —— 否则自有桶任务里「客户已有的表」永远探不到(主控区同样)
        tables.push(...unconfirmedForeignTables(await probeS3Tables({ region: landing.region, tableBucket: effectiveTableBucket(task, landing) }, fqs), confirmed));
      }
    } catch (e) {
      failures.push(`s3-tables: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    }
  }
  if (tables.length) return { kind: "needs-confirm", tables: Array.from(new Set(tables)).sort() };
  if (failures.length) return { kind: "unknown", reason: failures.join("; ").slice(0, 200) };
  return { kind: "ok" };
}

/** 建任务 / 改任务的写模式与确认清单校验(两个入口共用)。返回错误文案或 null;会规整 confirmed 清单。 */
export function validateSyncWriteFields(task: { syncMode?: string; channel?: string; writeMode?: unknown; overwriteConfirmedTables?: unknown }): string | null {
  // 只有**走 Glue 写入**的任务用 writeMode;DMS / Zero-ETL 通道与实时任务不用它(DMS 的删表与否由
  // targetTablePrepMode 决定,缺省 DO_NOTHING,见 dms-service)。口径单一作者 = run-vars.usesGlueWriteMode(合并键校验同一句)。
  const usesWriteMode = usesGlueWriteMode(task);
  if (usesWriteMode && !isSyncWriteMode(task.writeMode)) {
    return `writeMode 必填(overwrite / append / merge),不提供缺省 —— overwrite 会整表清空目标表,必须由你显式选择`;
  }
  try {
    const c = parseConfirmedTables(task.overwriteConfirmedTables);
    if (task.overwriteConfirmedTables !== undefined) task.overwriteConfirmedTables = c;
  } catch (e) {
    return String((e as Error).message);
  }
  return null;
}

// 复用既有词表里的 DECISION_REQUIRED(「需用户显式决策,确认后重试」),不另造第二套 code;detail.kind 区分是哪类决策。
export const OVERWRITE_CONFIRM_CODE = "DECISION_REQUIRED" as const;
export const OVERWRITE_CONFIRM_KIND = "overwrite-foreign-tables";
export function overwriteConfirmMessage(tables: string[]): string {
  return `以下目标表已存在且不是平台建的,本任务每次运行都会把它们整表清空:${tables.join("、")}。` +
    `如确需覆盖,请逐表确认(overwriteConfirmedTables);否则改用追加写入,或换一个目标表名。`;
}
