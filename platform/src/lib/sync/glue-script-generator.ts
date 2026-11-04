import type { DataSource } from "@/types/datasource";
// PlaceWire 生产者 + Python 读取函数(单一作者)
import { buildPlaceWire } from "@/lib/place/wire";
import { PLACE_WIRE_PY } from "@/lib/place/wire-py";
import { buildTargetNameMap } from "@/lib/sync/target-naming";
import { sanitizeS3TablesIdentifier } from "@/lib/sync/s3tables-identifier";
import { PLATFORM_TABLE_MARKER, S3_TABLE_MARKER_PROPERTY, clearsWholeTable, isSyncWriteMode, parseConfirmedTables, targetSchemaOf } from "@/lib/sync/target-table-guard";
import { effectiveTableBucket } from "@/lib/sync/table-bucket";
import { getProvider, isDataSourceType } from "@/lib/datasource-spi/registry";
import { toSourceRef } from "@/lib/datasource-spi/normalize";
// 新能力的合法形态 + 日期变量(TS / Python 两个作者同源)
import { validateSyncCapabilityFields, whereOf, syncTaskUsesRunDate, overwriteScopeOf, sourceColumnsOf, mergeKeysOf } from "@/lib/sync/run-vars";
import { SYNC_RUN_VARS_PY } from "@/lib/sync/run-vars-py";
// 这次运行的 Glue 版本(记录没存 ⇒ 5.1)决定要不要带 Spark 4 的类型兼容段
import { glueVersionOfRecord, glueVersionNeedsSpark4Compat } from "@/lib/sync/glue-version";

// 🔴 生成脚本里的**每一个区位值**(region / 桶 / workgroup / 库 / 凭证 ARN)从此都是**注入的数据**,
// 本文件不再从 `process.env` / home 命名去猜任何一个 —— 猜错的后果不是报错,是
// 「脚本看起来正常地把该区的数据写回了主控区」(驻留承诺当场破)。
//
// 形状与 `resolveGlueBinding` / `resolveRedshiftBinding`(lib/exec-env/data-plane-target.ts,
// 落点唯一作者)的产物结构化对齐:调用方把 binding 原样传进来即可。**刻意不在这里 import 那两个
// 解析器**:生成器保持纯函数(单测零 AWS 依赖),且「谁解析落点」只有路由一个作者。
// 🔴 第三参**必填、无缺省**:「有静默合法默认值的参数」是一整类缺陷的温床(本仓一天犯过六次)——
// 缺省 home 就是把「非 home 静默打回主控区」重新引进来。
export interface GlueScriptLanding {
  /** 作业落点的 target(PlaceWire 的身份;调用方传的是 TargetSparkLanding,本来就有) */
  targetId: string;
  /** 作业执行区(Secrets Manager 源密钥客户端 / DDB 源缺省区也用它 —— 原则 2 已保证源 ∈ 任务章) */
  region: string;
  /** COPY 的 staging 前缀落在这个桶(home = `bgp-datalake-<acct>`,与旧脚本按账号拼的值逐字相等) */
  datalakeBucket: string;
  /** S3 Tables 表桶(任务没自带 tableBucket 时的落点值;原字面量 `bgp-table-bucket` 是 home 的) */
  tableBucket: string;
}
export interface GlueScriptWarehouse {
  region: string;
  workgroup: string;
  database: string;
  /** 执行凭证 ARN,生成期由 binding 解析好注入;`undefined/null`(无密钥裸环境)= 回退 IAM 身份(旧语义) */
  secretArn?: string | null;
}
export interface GlueScriptBindings {
  landing: GlueScriptLanding;
  /** 写 Redshift 的任务必须带;不写 Redshift 传 null(用不上的字段不进脚本) */
  rsb: GlueScriptWarehouse | null;
}

// JDBC URL + driver 由数据源 SPI 的 buildConnection 产出(取代此前写死的 JDBC_URL 表 +
// 写死 driver="com.mysql.cj.jdbc.Driver")。MySQL 产物逐字不变(mysql provider 收编同一模板);
// PostgreSQL/Oracle/SQLServer 现在也拿到正确的 URL + driver class(根治「非 MySQL 走 Glue 用错
// 驱动」的 #9)。driverClass 供脚本里 spark.read.format("jdbc").option("driver", ...) 使用。
function jdbcConnFor(ds: DataSource): { jdbcUrl: string; driverClass: string } {
  if (!isDataSourceType(ds.type)) return { jdbcUrl: "", driverClass: "" };
  const cm = getProvider(ds.type).buildConnection(toSourceRef(ds as any));
  return { jdbcUrl: cm.jdbcUrl || "", driverClass: cm.driverClass || "" };
}

// 数据源范式(决定读源方式)。JDBC=spark.read.format("jdbc");
//   nosql(DynamoDB)=Glue DynamoDB 连接器 create_dynamic_frame。由 provider.capabilities 派生,不硬编码。
function paradigmOf(ds: DataSource): string {
  if (!isDataSourceType(ds.type)) return "jdbc"; // 未知类型按 JDBC 保底(与建源分流一致)
  return getProvider(ds.type).capabilities.paradigm;
}

// SYNC-FIX(sortkey): 规范化 redshiftConfig 的 sortKeys(兼容字符串"col1,col2"/数组两种历史存法,去空)。
export function normalizeSortKeys(sortRaw?: string | string[]): string[] {
  return Array.isArray(sortRaw)
    ? sortRaw.map((s) => String(s).trim()).filter(Boolean)
    : String(sortRaw || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// SYNC-FIX(sortkey): 生成 Redshift CREATE TABLE 的 DISTKEY/DISTSTYLE/SORTKEY 尾缀子句。
// 为什么:此前 Glue 执行脚本建表只有裸列定义 `CREATE TABLE (...)`,用户在向导填的排序键/分布键
// 【预览 DDL(generateDDL)里拼了、实际执行建表却丢了】——预览承诺≠执行。这里对齐 generateDDL
// (sync-service.ts:263-271)的规则,让执行侧真正带上。
// 兼容性:redshiftConfig.sortKeys 前端存的是【字符串】"col1,col2"(sync-task.ts 标 string[] 是历史
// 误标),这里同时接受 字符串/数组,按逗号规范化去空;distStyle=key+有distKey→DISTKEY,其它非auto→
// DISTSTYLE;空配置返回空串(不改变原有裸建表行为=零回归)。抽成纯函数便于单测钉住不变式。
//
// 🔴 Bug#3(列名不校验):SORTKEY/DISTKEY 引用【不在同步列里】的列 → CREATE TABLE 报 "column xxx
//    does not exist"(用户向导里填了源没有的列、或改了列映射后键名过期)。传入 availableColumns 后,
//    剔除不存在的键(大小写不敏感匹配,因 Redshift 不带引号标识符折叠小写);全部不存在则该子句整体不拼。
//    不传 availableColumns=保持原行为(向后兼容,如无列信息的调用方)。剔除项经 onDrop 回调上报。
export function buildRedshiftTableClause(
  rcfg: { sortKeys?: string | string[]; distKey?: string; distStyle?: string },
  availableColumns?: string[],
  onDrop?: (kind: "sortkey" | "distkey", col: string) => void,
): string {
  const lowerSet = availableColumns ? new Set(availableColumns.map((c) => c.toLowerCase())) : null;
  const exists = (col: string) => !lowerSet || lowerSet.has(col.toLowerCase());

  let sortCols = normalizeSortKeys(rcfg.sortKeys);
  if (lowerSet) {
    sortCols = sortCols.filter((c) => {
      if (exists(c)) return true;
      onDrop?.("sortkey", c);
      return false;
    });
  }
  const distKeyRaw = String(rcfg.distKey || "").trim();
  const distKey = distKeyRaw && exists(distKeyRaw) ? distKeyRaw : "";
  if (distKeyRaw && !distKey) onDrop?.("distkey", distKeyRaw);
  const distStyle = String(rcfg.distStyle || "").trim().toLowerCase();

  let clause = "";
  if (distStyle === "key") {
    // KEY 分布必须带 DISTKEY 列;有列才拼 DISTKEY,没列则整体不拼(Redshift 无裸 "DISTSTYLE KEY" 语法,
    // 拼了会建表语法错)。此前 generateDDL 的 else 分支对 key-无列会误输出 DISTSTYLE KEY,这里根治。
    if (distKey) clause += ` DISTKEY(${distKey})`;
  } else if (distStyle && distStyle !== "auto") {
    clause += ` DISTSTYLE ${distStyle.toUpperCase()}`;
  }
  if (sortCols.length > 0) {
    clause += ` SORTKEY(${sortCols.join(", ")})`;
  }
  return clause;
}

// 覆盖写进已有 S3 Tables 表之前的「按列名对齐」Python 段(两个覆盖分支共用;单一作者)。
//   🔴 嵌在模板串里:禁写反引号。
const S3_ALIGN_PY = `            # 写进**已有**表之前按**列名**对齐。原来是 INSERT ... SELECT * 按位置写:列序不同就把值写进别的列、
            #   只有列数不同才报错(客户现有表的列序是客户自己配的,切换时必中)。与客户库 ensure_compatible_schema 同口径:
            #   目标表缺 df 的列 / df 缺目标表的列 / 同名列类型不同 ⇒ 在任何写入之前失败,一行不动。
            _tgt_fields = spark.table(s3t_table).schema.fields
            _tgt_by_lower = {f.name.lower(): f for f in _tgt_fields}
            _src_by_lower = {f.name.lower(): f for f in df.schema.fields}
            _missing = sorted(set(_tgt_by_lower) - set(_src_by_lower))
            _extra = sorted(set(_src_by_lower) - set(_tgt_by_lower))
            if _missing or _extra:
                raise Exception(f"SYNC_SCHEMA_MISMATCH table={s3t_table} missing_in_source={_missing} not_in_target={_extra}: 本次读到的列与目标表的列不一致,拒绝写入(一行未动)。请用 sourceColumns 指定要读的列,或让目标表与源表的列一致")
            _typediff = [(n, _src_by_lower[n].dataType.simpleString(), _tgt_by_lower[n].dataType.simpleString()) for n in sorted(_tgt_by_lower) if _tgt_by_lower[n].dataType.simpleString() != _src_by_lower[n].dataType.simpleString()]
            if _typediff:
                raise Exception(f"SYNC_SCHEMA_MISMATCH table={s3t_table} type_diff={_typediff}: 同名列类型不同(列, 源, 目标),拒绝写入(一行未动)")
            df = df.select(*[_NF.col(_src_by_lower[f.name.lower()].name).alias(f.name) for f in _tgt_fields])
            df.createOrReplaceTempView(temp_view)
            print(f"SYNC_ALIGNED table={s3t_table} columns={[f.name for f in _tgt_fields]}")
`;

export function generateGlueScript(task: any, ds: DataSource, bindings: GlueScriptBindings): string {
  const { landing, rsb } = bindings;
  const { jdbcUrl, driverClass } = jdbcConnFor(ds);
  const sourceParadigm = paradigmOf(ds);
  const isDynamoSource = sourceParadigm === "nosql"; // DynamoDB 走 Glue DDB 连接器读(非 JDBC)
  const isS3Source = sourceParadigm === "object-store"; // S3 走 spark.read.format(csv/parquet/json) 读文件
  // 🔴 iam-role 类源(DynamoDB/S3)无 secret,不能生成 Secrets Manager 读取(否则 SecretId="" → ParamValidationError)。
  //    这是"跳过 secret"的正确条件(非仅 DDB);S3 源也无 secret。真 bug:S3→Glue 入仓首次现形(line 22 SecretId=0)。
  const noSecretSource = isDynamoSource || isS3Source;
  // DynamoDB 源连接袋:表名 + 区域(iam-role,无 secret)。tables 列表对 DDB = [tableName]。
  const ddbConn = (ds as any).connection || {};
  const ddbTableName = (ddbConn.tableName || "").toString();
  // DDB 源缺省区 = 作业落点区(原则 2 已在路由层保证源 ∈ 任务章;home 与旧 env 回落逐字相等)。
  const ddbRegion = (ddbConn.region || landing.region).toString();
  // S3 源连接袋:桶/前缀/格式。读 s3://bucket/prefix 下文件(csv/parquet/json)。
  const s3Bucket = (ddbConn.bucket || "").toString();
  const s3Prefix = (ddbConn.prefix || "").toString().replace(/^\/+/, "");
  const s3Format = (ddbConn.format || "auto").toString();
  const s3HasHeader = ddbConn.hasHeader === undefined ? true : !!ddbConn.hasHeader;
  const s3Uri = s3Bucket ? `s3://${s3Bucket}/${s3Prefix}` : "";
  const tables = task.sourceTables || [];
  // SYNC-07: map each source table to its (possibly customized) target table name.
  const targetNameMap = buildTargetNameMap(tables, task);
  const writeS3 = task.targetType === "s3-tables" || task.targetType === "both";
  const writeRedshift = task.targetType === "redshift" || task.targetType === "both";
  // 🔴 写 Redshift 却没给数仓落点 ⇒ 当场拒,绝不回落 env / home 命名去猜(下方模板里的
  //    `rsb!` 全部由这条守卫背书;写不进正确的区还不如不写)。
  if (writeRedshift && !rsb) {
    throw new Error(
      "生成同步脚本:targetType 含 redshift 的任务必须带数仓落点 rsb(resolveRedshiftBinding 的产物)。" +
        "拒绝在脚本里猜 workgroup/区/凭证 —— 猜错不报错,只是看起来正常地写进别的区"
    );
  }
  // 数仓四样(区 / 工作组 / 库 / 凭证)以 PlaceWire 进脚本(原来是四个裸字面量);
  //   生成期自校验一遍(buildPlaceWire),坏值在平台这侧就报错。数仓落点的区必须与作业落点同区(写别的区 = 跨区写数)。
  if (writeRedshift && rsb && rsb.region !== landing.region) {
    throw new Error(`生成同步脚本:数仓落点在 ${rsb.region},而作业落点在 ${landing.region} —— 拒绝跨区写数`);
  }
  const rsWire = writeRedshift && rsb
    ? buildPlaceWire({ targetId: landing.targetId, region: rsb.region, redshift: { workgroup: rsb.workgroup, database: rsb.database, secretArn: rsb.secretArn ?? null } })
    : null;
  const partitionFields = task.s3Config?.partitionFields || [];
  // 🔴 生产上线批次 A:不再缺省成 overwrite(那是「整表清空」)。写模式由建任务入口校验为必填;
  //    到这里还缺 = 坏数据,拒绝生成,绝不替用户选一个会删数据的默认值。
  if (!isSyncWriteMode(task.writeMode)) {
    throw new Error(`生成同步脚本:writeMode 缺失或非法(${JSON.stringify(task.writeMode)});合法值 overwrite / append / merge,不提供缺省`);
  }
  const writeMode = task.writeMode;
  // 目标 schema 进脚本之前先过标识符校验(原来是原样拼进 Python 字符串)。
  const rsSchemaSafe = writeRedshift ? targetSchemaOf(task) : "public";
  // 整表清空**非平台建**的表需要逐表确认(lib/sync/target-table-guard.ts 规则 ②)。
  const overwriteConfirmed = parseConfirmedTables(task.overwriteConfirmedTables);
  // SYNC-05: incremental sync. When syncMode === "incremental" and an incremental column is
  // configured, only rows with incColumn > watermark are read from the source, and targets
  // are APPENDED to (no drop / no truncate) instead of fully reloaded.
  const incremental = task.syncMode === "incremental";
  const incCol = (task.incrementalColumn || "").toString();
  const incVal =
    task.incrementalValue !== undefined && task.incrementalValue !== null
      ? String(task.incrementalValue)
      : "";
  // merge 不再退化成 append。增量 + merge = 读水位之后的行、按键合并(幂等,不需要 append 那套按水位预删);
  //   增量 + append / overwrite 行为逐字不变(增量恒按 append 走)。
  const effectiveMode = incremental ? (writeMode === "merge" ? "merge" : "append") : writeMode;

  // 新能力。🔴 每一段新 Python 只在任务**真用到**时才进脚本
  //   不带新字段的存量任务,除「覆盖」写入外,脚本与改动前逐字节相同(golden-script.test.ts 钉住)。
  const capReject = validateSyncCapabilityFields(task, sourceParadigm);
  if (capReject) throw new Error(`生成同步脚本:${capReject}`);
  // 合并键(校验已在上一行过;这里再守一道 —— 没键的 merge 任务宁可运行时现形,也不许静默退化成 append)
  const isMerge = effectiveMode === "merge";
  const mergeKeys = isMerge ? mergeKeysOf(task) : [];
  if (isMerge && mergeKeys.length === 0) {
    throw new Error("生成同步脚本:合并写入(merge)必须指定合并键 mergeKeys(至少一列),不提供缺省 —— 没有键无法判定「同一行」,拒绝按追加写入");
  }
  const sourceWhere = whereOf(task); // 源端过滤条件(空 = 没有)
  const usesRunDate = syncTaskUsesRunDate(task); // ④⑥:过滤条件 / 源表名里有日期变量 ⇒ 运行时解析业务日期
  const runTz = typeof task.businessTimezone === "string" && task.businessTimezone.trim() ? task.businessTimezone.trim() : "UTC";
  const templatedSource = tables.some((t: unknown) => typeof t === "string" && t.includes("${"));
  const derivedColumns: Array<{ name: string; sourceColumn: string; format: string }> = Array.isArray(task.derivedColumns) ? task.derivedColumns : [];
  // 只读指定源列(JDBC 投影下推);没指定 = 全列(现状)
  const sourceColumns = sourceColumnsOf(task);
  const hasSourceColumns = Object.keys(sourceColumns).length > 0;
  // 「覆盖」= 全量 + overwrite(增量恒按 append 走,见上)。覆盖范围 table / partitions(⑤)。
  const isOverwrite = effectiveMode === "overwrite";
  const byPartitions = isOverwrite && overwriteScopeOf(task) === "partitions";
  const partitionKeys: string[] = byPartitions ? (task.partitionKeys as string[]) : [];
  const allowEmptyOverwrite = task.allowEmptyOverwrite === true;
  // 读一次、写的就是读到的那份:覆盖 / 合并要写后对数,派生列要查空值 ⇒ 读到的数据先落缓存,
  // 否则每个动作都会重新去源库读一遍(源表在变时,对数会拿两次不同的读数比)。
  const persistRead = isOverwrite || isMerge || derivedColumns.length > 0;
  // Glue ≥ 6.0 = Spark 4,MySQL JDBC 把 FLOAT 读成 FloatType(5.1 是 DoubleType,Spark 4.0 迁移指南,没有 legacy 开关)⇒
  //   只在 MySQL 源 + Glue ≥ 6.0 时把 FloatType 规整回 double,让目标表类型与 5.1 时期逐字相同(存量任务不换版本 ⇒ 这段不进脚本,逐字节不变)。
  //   其余有开关的差异由作业定义里的 --conf 兼容开关钉住(lib/sync/glue-version.ts GLUE_SYNC_SPARK4_COMPAT_CONF)。
  const spark4MysqlFloatCompat = ds.type === "mysql" && glueVersionNeedsSpark4Compat(glueVersionOfRecord(task.glueConfig?.glueVersion));
  // Redshift 覆盖 / 合并先装进暂存表,再在一个事务里「清目标(或删键命中的行)+ 从暂存表插入」⇒ 装载阶段的目标表名是变量。
  const rsLoadTable = isOverwrite || isMerge ? "rs_load_table" : "rs_table";
  // S3 Tables 路的「整表清空非平台建的表需确认」守卫。只在这次运行**会**整表清空时才进脚本
  //   (overwrite 任何 scope;增量且水位为空)—— 条件与 Redshift 路 `_will_clear` 的运行时判定等价:INC_COL / INC_VAL
  //   都是生成期烘进脚本的常量,所以 `(INCREMENTAL and not inc_where)` 在生成期就已确定;单一作者 = clearsWholeTable。
  const s3ClearGuard = writeS3 && clearsWholeTable(task);

  // SYNC-FIX(sortkey): Redshift 建表的 DISTKEY/DISTSTYLE/SORTKEY —— 执行侧【列校验只能在 Python 运行时
  // 做】(TS 生成脚本时拿不到真实列,列来自 df.columns)。故把规范化后的 keys 作为【数据】注入,由
  // Python 侧用 df.columns 校验后组装 clause(Bug#3:剔除不存在的列,避免 CREATE TABLE column-not-exist)。
  const _rcfg = (task.redshiftConfig || {}) as { sortKeys?: string | string[]; distKey?: string; distStyle?: string };
  const _rsSortKeys = normalizeSortKeys(_rcfg.sortKeys);
  const _rsDistKey = String(_rcfg.distKey || "").trim();
  const _rsDistStyle = String(_rcfg.distStyle || "").trim().toLowerCase();

  // S3 Tables config —— 兜底改为落点的表桶(原字面量 `bgp-table-bucket` 是 home 的名字,
  // home 的 landing.tableBucket 与它逐字相等;非 home 用它就是把该区的表建进主控区的桶)。
  // 与 start-run / 目标表守卫同一个作者算「写哪个桶」(此前三处各写一遍 `||`)
  const tableBucketName = effectiveTableBucket(task, landing);
  // Bug#1:namespace 过 S3Tables 标识符 SSOT(与 start/route.ts、om-push.ts 同一函数同一表达式)。
  // 幂等:start/route 已 patch 过 sanitize 值到 task.s3Config.namespace,这里再过一次仍是同值(防御性)。
  const namespace = sanitizeS3TablesIdentifier(task.s3Config?.namespace || ds.database || "default");
  const icebergConfig = task.s3Config?.icebergConfig || {};
  const snapshotRetention = icebergConfig.snapshotRetentionDays || 7;
  const maxSnapshots = icebergConfig.maxSnapshots || 100;

  // S3 Tables 路的守卫段(表已存在分支的第一件事;只在这次运行会整表清空时生成,见 s3ClearGuard)。
  //   标记键 / 标记值 / 确认清单都由 TS 注入(Python 里不写第二份字面量)。🔴 嵌在模板串里:禁写反引号。
  const s3GuardPy = s3ClearGuard ? `            # **不许静默清空客户已有的 S3 Tables 表**(规则唯一作者 lib/sync/target-table-guard.ts,与 Redshift 路逐字对齐)。
            #   平台自己建的表在表属性里带标记;要整表清空(覆盖 / 增量空水位整表重载)一张「已存在且无标记」的表,
            #   必须在任务的确认清单里(三段名 s3tablescatalog.<namespace>.<table>),否则本次运行**在任何写 / 删之前**失败。
            _bgp_props = {str(_r[0]): str(_r[1]) for _r in spark.sql(f"SHOW TBLPROPERTIES {s3t_table}").collect()}
            if _bgp_props.get(${JSON.stringify(S3_TABLE_MARKER_PROPERTY)}) != ${JSON.stringify(PLATFORM_TABLE_MARKER)} and s3t_table not in set(${JSON.stringify(overwriteConfirmed)}):
                raise Exception(
                    f"SYNC_REFUSED_CLEAR_FOREIGN_TABLE table={s3t_table}: 目标表已存在且不是平台建的,"
                    f"本次同步会整表清空它 —— 未经确认,拒绝执行(一行未删)。"
                    f"如确需覆盖,请在同步任务里确认覆盖该表;否则改用追加写入或换一个目标表名。")
` : "";

  return `import sys
import re
import json
import boto3
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from awsglue.context import GlueContext
from awsglue.job import Job

args = getResolvedOptions(sys.argv, ["JOB_NAME"])
sc = SparkContext()
glueContext = GlueContext(sc)
spark = glueContext.spark_session
job = Job(glueContext)
job.init(args["JOB_NAME"], args)
${usesRunDate ? `${SYNC_RUN_VARS_PY}
# 业务日期:运行参数 --ds 优先(手动指定 / 补数),没有就取业务时区的今天(调度 / 工作流节点重跑同一作业时不带参数)。
BGP_RUN_TZ = ${JSON.stringify(runTz)}
BGP_RUN_DATE = bgp_sync_run_date(BGP_RUN_TZ)
BGP_RUN_VARS = bgp_sync_run_vars(BGP_RUN_DATE)
print("SYNC_RUN_DATE ds=" + BGP_RUN_VARS["ds"] + " tz=" + BGP_RUN_TZ)
` : ""}${noSecretSource ? `
# iam-role 类源(DynamoDB/S3)用 IAM 角色访问(无密钥),不读 Secrets Manager。
${isDynamoSource ? `DDB_TABLE = "${ddbTableName}"
DDB_REGION = "${ddbRegion}"` : `S3_URI = "${s3Uri}"
S3_FORMAT = "${s3Format}"
S3_HAS_HEADER = ${s3HasHeader ? "True" : "False"}`}` : `
# Get credentials from Secrets Manager(源密钥在源自己的区;原则 2 保证源区 = 作业落点区)
sm = boto3.client("secretsmanager", region_name="${landing.region}")
secret = json.loads(sm.get_secret_value(SecretId="${ds.secretArn || ""}")["SecretString"])
db_user = secret["username"]
db_pass = secret["password"]

jdbc_url = "${jdbcUrl}"`}
tables = ${JSON.stringify(tables)}
# 🔴 零表就**响亮失败**(不许空转成功)。
# 真环境实测:表清单为空时本脚本一路跑到 "SYNC RESULTS: {}" 然后 SUCCEEDED,
# 于是平台把任务标成 succeeded 而数仓里连表都没建 —— 看板全绿、什么都没发生。
if not tables:
    raise Exception("同步任务没有可同步的表(sourceTables 为空):拒绝空转成功。请在任务里勾选要同步的表。")
target_names = ${JSON.stringify(targetNameMap)}
results = ${"{}"}
INC_COL = "${incCol}"
INC_VAL = "${incVal}"
INCREMENTAL = ${incremental ? "True" : "False"}
${sourceWhere ? `# 源端过滤条件(下推到源库执行,用源库方言;可带日期变量)
SOURCE_WHERE = ${JSON.stringify(sourceWhere)}
` : ""}${hasSourceColumns ? `# 只读指定的源列(投影下推到源库;没列出的表读全列)
SOURCE_COLUMNS = ${JSON.stringify(sourceColumns)}
` : ""}${derivedColumns.length > 0 ? `# 派生列(写入前按来源列加到数据上)
DERIVED_COLUMNS = ${JSON.stringify(derivedColumns.map((d) => ({ name: d.name, source: d.sourceColumn, fmt: d.format })))}
` : ""}${isOverwrite ? `# 覆盖写入读到 0 行默认失败(显式允许才清空);写后对数,不一致即失败
ALLOW_EMPTY_OVERWRITE = ${allowEmptyOverwrite ? "True" : "False"}
OVERWRITE_SCOPE = ${JSON.stringify(byPartitions ? "partitions" : "table")}
PARTITION_KEYS = ${JSON.stringify(partitionKeys)}
` : ""}${isMerge ? `# 按键合并(upsert)。键命中的行更新、其余插入;源内键重复 / 键为空 / 键不在列里 ⇒ 任何写入之前失败
MERGE_KEYS = ${JSON.stringify(mergeKeys)}
` : ""}
# S3 Tables catalog path (backtick bucket name with hyphens)
S3T_CATALOG = "s3tablescatalog"
S3T_BUCKET_RAW = "${tableBucketName}"
BT = chr(96)
S3T_BUCKET = BT + S3T_BUCKET_RAW + BT
S3T_NAMESPACE = "${namespace}"
${rsWire ? `${PLACE_WIRE_PY}
# 数仓落点 = PlaceWire v1(平台生成期产出并自校验;本脚本用同源读取函数再读一遍,
#   缺 / 不合法 / 没有数仓腿 ⇒ 当场抛,不会落到任何缺省区或工作组)。
_BGP_PLACE = bgp_read_place(${JSON.stringify(JSON.stringify(rsWire))})
_BGP_RS = bgp_place_leg(_BGP_PLACE, "redshift")
` : ""}
for table_name in tables:
    print(f"\\n{'='*60}")
    print(f"Syncing table: {table_name}")
    print(f"{'='*60}")
    # SYNC-07: resolve the target table name (defaults to the source name).
    target_name = target_names.get(table_name, table_name)
    # 目标表名【标识符安全化】。DynamoDB/S3 源的"表名"来自 AWS 资源名,允许连字符/点
    # (如 bgp-orders / my.table),但 Redshift/S3Tables 的 SQL 标识符不允许裸连字符 → 建表 DDL 语法错
    # (真 bug: "syntax error at or near '-' in context 'public.bgp-'")。JDBC 源表名本是 SQL 标识符不受影响。
    # 统一把非法字符(非字母/数字/下划线)→ 下划线,数字开头补 _。覆盖 Redshift + S3Tables 两个目标。
    # 🔴 Bug#2 修复:必须先【转小写】再替非法字符 —— S3Tables/Iceberg 表标识符要求小写,Oracle 源默认
    #   全大写(ORA_EVENTS)不转小写 → S3Tables "Invalid table identifier" 建表崩(Redshift 大小写不敏感
    #   不受影响,但 both 目标下 S3Tables 侧必崩)。规则与 TS 侧 SSOT sanitizeS3TablesIdentifier 逐字对齐
    #   (lib/sync/s3tables-identifier.ts:小写 + re.sub[^a-z0-9_]→_ + 数字开头补_);改一处两处同改。
    _san = re.sub(r'[^a-z0-9_]', '_', target_name.lower())
    if _san and _san[0].isdigit():
        _san = '_' + _san
    if _san != target_name:
        print(f"Sanitized target table name for SQL identifier: {target_name} -> {_san}")
    target_name = _san
    if target_name != table_name:
        print(f"Target table name: {target_name}")

    # Read from source (SYNC-05: incremental predicate when configured)
    # SYNC-FIX(dup): 增量"读取谓词"与"幂等清理谓词"共用同一 WHERE(incCol > 水位)。落库前按同一谓词
    # 先删既有行再写,使重跑不产生重复追加。根因:append 模式下若水位未前进(此前依赖日志解析
    # INC_WATERMARK 这一尽力而为步骤,日志抓取失败即不前进),同一区间会被反复叠加(838070=419035×2)。
    inc_where = ""
    if INC_COL and INC_VAL != "":
        # 增量谓词:数字水位不加引号,非数字(时间戳/字符串)加引号并转义,避免 SQL 语法错。
        _pv = INC_VAL if INC_VAL.replace(".", "", 1).lstrip("-").isdigit() else "'" + INC_VAL.replace("'", "''") + "'"
        inc_where = f"{INC_COL} > {_pv}"
${isDynamoSource ? `    # DynamoDB 源经 Glue DynamoDB 连接器批读(ETL connector),整表 Scan → DataFrame。
    # 无 SQL 下推(DDB 无 WHERE 谓词能力),一期全量读;dynamodb.throughput.read.percent 控制读容量占用防打满。
    # DDB item 属性异构 → Glue 推断出并集 schema;嵌套 Map/List 列在下游写 Redshift 时由类型映射兜底为 VARCHAR。
    _ddb_dyf = glueContext.create_dynamic_frame.from_options(
        connection_type="dynamodb",
        connection_options={
            "dynamodb.input.tableName": DDB_TABLE,
            "dynamodb.throughput.read.percent": "0.5",
            "dynamodb.splits": "8",
        },
    )
    # SYNC-FIX(ddb-number-choice): DynamoDB 的 Number 是弱类型——同一属性跨 item 可整可小数,Glue
    # DynamoDB 连接器据此把这类列推断成 choice(<long, double>)。此前直接 .toDF() 会把 choice 原样
    # 带成 Spark struct<double,long>,写 S3 Tables(Iceberg 容忍 struct)侥幸成功,但写 Redshift 时
    # 该 struct 被字符串化成 "Row(double=73.5, long=None)" 塞进数值列 → COPY/INSERT 报
    # "invalid input syntax for integer"。根治:在转 DataFrame 前用 resolveChoice 把所有 choice 列
    # 统一 cast 成 double(DDB Number 本就是数值语义;整数在 double 内精确至 2^53,宽化无损),
    # 使下游 df.schema 只出现标量数值类型,Redshift DDL/COPY 干净。与 :252 的"写前窄整型规整"同源思路。
    _ddb_dyf = _ddb_dyf.resolveChoice(choice="cast:double")
    df = _ddb_dyf.toDF()
    print(f"Read DynamoDB table {DDB_TABLE} @ {DDB_REGION} via Glue connector (choice->double resolved)")` : isS3Source ? `    # S3(对象存储)源用 spark.read 批读 s3://bucket/prefix 下文件(csv/parquet/json)。
    # 一期整前缀全量读(无增量);format=auto 时按 CSV 处理(与 introspect 一致)。CSV 首行表头 → header=True 推断列名。
    _fmt = S3_FORMAT if S3_FORMAT in ("csv", "parquet", "json") else "csv"
    if _fmt == "parquet":
        df = spark.read.parquet(S3_URI)
    elif _fmt == "json":
        df = spark.read.json(S3_URI)
    else:
        df = spark.read.option("header", S3_HAS_HEADER).option("inferSchema", "true").csv(S3_URI)
    print(f"Read S3 {S3_URI} (format={_fmt}) via spark.read → {len(df.columns)} cols")` : `${sourceWhere || templatedSource || hasSourceColumns ? `    # 源表名模板按业务日期解析(④);过滤条件下推到源库,与增量谓词用 AND 合并;指定了源列就只投影这些列。
    src_table = ${templatedSource ? "bgp_render(table_name, BGP_RUN_VARS)" : "table_name"}
    if src_table != table_name:
        print(f"SYNC_SOURCE_TABLE template={table_name} resolved={src_table}")
    src_where = ${sourceWhere ? (sourceWhere.includes("${") ? "bgp_render(SOURCE_WHERE, BGP_RUN_VARS)" : "SOURCE_WHERE") : JSON.stringify("")}
    _preds = []
    if src_where:
        _preds.append("(" + src_where + ")")
    if inc_where:
        _preds.append(inc_where)
    _cols = ${hasSourceColumns ? "SOURCE_COLUMNS.get(table_name)" : "None"}
    _select = ", ".join(_cols) if _cols else "*"
    read_table = src_table
    if _preds or _cols:
        _pred = " AND ".join(_preds)
        read_table = f"(SELECT {_select} FROM {src_table}" + (f" WHERE {_pred}" if _pred else "") + ") AS bgpq"
        if _pred:
            print(f"SYNC_SOURCE_PREDICATE table={src_table} where={_pred}")
        if _cols:
            print(f"SYNC_SOURCE_COLUMNS table={src_table} columns={_cols}")` : `    read_table = table_name
    if inc_where:
        read_table = f"(SELECT * FROM {table_name} WHERE {inc_where}) AS incq"
        print(f"Incremental read predicate: {inc_where}")`}
    df = spark.read.format("jdbc").options(
        url=jdbc_url,
        dbtable=read_table,
        user=db_user,
        password=db_pass,
        driver="${driverClass}",
    ).load()`}

    # SYNC-FIX(parquet-copy): normalize NARROW integer columns (Spark ByteType from MySQL
    # TINYINT, ShortType from SMALLINT) to IntegerType BEFORE any write. ROOT CAUSE of the
    # persistent "Spectrum Scan Error 15007 — incompatible Parquet schema" on COPY: Spark writes
    # ByteType/ShortType to Parquet as physical INT32 carrying an INT(8,*)/INT(16,*) logical
    # annotation; Redshift COPY FORMAT AS PARQUET rejects that annotation even against a SMALLINT
    # column (the physical/logical pair does not match). Casting to IntegerType emits a plain
    # INT32 with no narrowing annotation, which COPYs cleanly into an INTEGER column. This makes
    # the staging Parquet, the S3 Tables write, and the Redshift DDL all agree on INTEGER — so
    # the fast COPY path works for EVERY table with boolean/flag columns instead of silently
    # degrading to the slow row-by-row INSERT fallback. Widening TINYINT/SMALLINT->INTEGER is
    # lossless. Types are matched widest-first below because Spark repr strings are substrings.
    from pyspark.sql.types import ByteType as _ByteT, ShortType as _ShortT
    from pyspark.sql import functions as _NF
    for _f in df.schema.fields:
        if isinstance(_f.dataType, (_ByteT, _ShortT)):
            df = df.withColumn(_f.name, _NF.col(_f.name).cast("int"))
${spark4MysqlFloatCompat ? `    # Glue 6.0(Spark 4)起 MySQL FLOAT 读成 FloatType(5.1 是 DoubleType)⇒ 规整回 double,目标表列类型与 5.1 时期逐字相同
    from pyspark.sql.types import FloatType as _FloatT
    for _f in df.schema.fields:
        if isinstance(_f.dataType, _FloatT):
            df = df.withColumn(_f.name, _NF.col(_f.name).cast("double"))
` : ""}${derivedColumns.length > 0 ? `
    # 派生列 —— 来源列按大小写不敏感匹配;新列名与已有列重名就失败(不静默覆盖源列)。
    for _dc in DERIVED_COLUMNS:
        _src = next((c for c in df.columns if c.lower() == _dc["source"].lower()), None)
        if _src is None:
            raise Exception(f"SYNC_DERIVED_SOURCE_MISSING table={table_name} column={_dc['source']}: 派生列 {_dc['name']} 的来源列不在源表里")
        if any(c.lower() == _dc["name"] for c in df.columns):
            raise Exception(f"SYNC_DERIVED_NAME_CONFLICT table={table_name} column={_dc['name']}: 派生列名与源表已有列重名")
        df = df.withColumn(_dc["name"], _NF.date_format(_NF.col(_src).cast("timestamp"), _dc["fmt"]))
` : ""}${persistRead ? `
    # 读到的数据先落缓存 —— 计数、写入、写后对数用的是同一份读数(不让每个动作各自重读源库)。
    from pyspark import StorageLevel as _BGP_SL
    df = df.persist(_BGP_SL.MEMORY_AND_DISK)
` : ""}
    row_count = df.count()
    col_count = len(df.columns)
    print(f"Read {row_count} rows, {col_count} columns from {table_name}")
    print(f"Schema: {df.dtypes}")
${derivedColumns.length > 0 ? `    for _dc in DERIVED_COLUMNS:
        _nulls = df.filter(_NF.col(_dc["name"]).isNull()).count()
        if _nulls > 0:
            raise Exception(f"SYNC_DERIVED_NULL table={table_name} column={_dc['name']} rows={_nulls}: 来源列 {_dc['source']} 有 {_nulls} 行为空或无法解析成时间,派生列取不到值")
` : ""}${isOverwrite ? `    if row_count == 0 and not ALLOW_EMPTY_OVERWRITE:
        raise Exception(f"SYNC_REFUSED_EMPTY_SOURCE table={table_name}: 覆盖写入读到 0 行 —— 拒绝清空目标(一行未删)。如源端确实为空且要清空目标,请在任务里允许空结果覆盖")
` : ""}${byPartitions ? `    for _pk in PARTITION_KEYS:
        if _pk not in df.columns:
            raise Exception(f"SYNC_PARTITION_KEY_MISSING table={table_name} column={_pk}: 分区列不在数据里")
        _pk_nulls = df.filter(_NF.col(_pk).isNull()).count()
        if _pk_nulls > 0:
            raise Exception(f"SYNC_PARTITION_KEY_NULL table={table_name} column={_pk} rows={_pk_nulls}: 分区列为空的行无法判定属于哪个分区")
` : ""}${isMerge ? `    # 按键合并的三道前检 —— 两个目标共用,只做一次,放在任何写入之前;任何一道不过就一行不动。
    #   合并键按大小写不敏感匹配到本次读到的列(_bgp_mk 用的是数据里的真实写法)。
    _bgp_mk = []
    for _k in MERGE_KEYS:
        _c = next((c for c in df.columns if c.lower() == _k.lower()), None)
        if _c is None:
            raise Exception(f"SYNC_MERGE_KEY_MISSING table={table_name} column={_k}: 合并键不在本次读到的列里(列:{df.columns}),拒绝写入(一行未动)")
        _bgp_mk.append(_c)
    for _k in _bgp_mk:
        _nulls = df.filter(_NF.col(_k).isNull()).count()
        if _nulls > 0:
            raise Exception(f"SYNC_MERGE_KEY_NULL table={table_name} column={_k} rows={_nulls}: 合并键为空的行无法判定与目标里哪一行是同一行,拒绝写入(一行未动)")
    _bgp_distinct = df.select(*[_NF.col(_k) for _k in _bgp_mk]).distinct().count()
    if _bgp_distinct != row_count:
        raise Exception(f"SYNC_MERGE_DUP_SOURCE_KEYS table={table_name} keys={_bgp_mk} rows={row_count} distinct={_bgp_distinct}: 源数据里合并键有重复(同一键多行,无法判定以哪一行为准),拒绝写入(一行未动)")
    print(f"SYNC_MERGE_KEYS table={table_name} keys={_bgp_mk} rows={row_count}")
` : ""}    # SYNC: 增量真前进 —— 输出本次读到的最大水位,供 poller 回写 task.incrementalValue,
    # 使下次只读 incCol > 新水位 的行(否则每次重读同一区间、append 重复)。
    if INC_COL and (INC_COL in df.columns) and row_count > 0:
        try:
            from pyspark.sql import functions as _F
            _mx = df.agg(_F.max(INC_COL)).collect()[0][0]
            if _mx is not None:
                print(f"INC_WATERMARK col={INC_COL} max={_mx}")
        except Exception as _e:
            print(f"INC_WATERMARK skip: {str(_e)[:120]}")
${writeS3 ? `
    # Write to S3 Tables (managed Iceberg)
    # Spark 临时视图名也需标识符安全(源表名 table_name 可能含连字符/点,如 DynamoDB 表
    # bgp-verify-ddb-1m → temp_bgp-verify-ddb-1m 是非法视图名 "Invalid view name")。用已 sanitize 的
    # target_name(上方 re.sub 处理过)构造,保证视图名合法。真 bug:100万 DDB→S3Table 首次现形。
    temp_view = f"temp_{target_name}"
    df.createOrReplaceTempView(temp_view)
    s3t_table = f"s3tablescatalog.{S3T_NAMESPACE}.{target_name}"
${isMerge ? `    # 合并键在目标表里的写法(表已存在时按列名对齐后改成目标表的写法;新建表 = 源的写法)
    _bgp_mk_t = list(_bgp_mk)
` : ""}
    try:
        # Step 1: Check if table exists by trying to read it
        table_exists = False
        try:
            spark.sql(f"SELECT 1 FROM {s3t_table} LIMIT 1")
            table_exists = True
            print(f"Table {s3t_table} exists")
        except:
            print(f"Table {s3t_table} does not exist, will create")

        # Step 2: Write data
        if table_exists:
${effectiveMode === "overwrite" ? (byPartitions ? `${s3GuardPy}${S3_ALIGN_PY}            # 按分区覆盖 = Iceberg 动态分区覆盖,**一次提交**只替换本批数据涉及的分区。
            # 🔴 动态覆盖按表的分区规格替换:规格必须恰好是分区列(按原值),否则「只覆盖本批分区」不成立
            #    (无分区表会被整表替换、规格更细会留下旧行)⇒ 不一致就在任何写入之前失败。
            _bgp_pschema = spark.table(f"{s3t_table}.partitions").schema
            _bgp_spec = [f.name.lower() for f in _bgp_pschema["partition"].dataType.fields] if "partition" in _bgp_pschema.fieldNames() else []
            if sorted(_bgp_spec) != sorted(k.lower() for k in PARTITION_KEYS):
                raise Exception(f"SYNC_REFUSED_PARTITION_SPEC table={s3t_table} spec={_bgp_spec} keys={PARTITION_KEYS}: 目标表的分区规格与分区列不一致,拒绝按分区覆盖(一行未动)")
            spark.conf.set("spark.sql.sources.partitionOverwriteMode", "dynamic")
            try:
                spark.sql(f"INSERT OVERWRITE {s3t_table} SELECT * FROM {temp_view}")
            finally:
                spark.conf.set("spark.sql.sources.partitionOverwriteMode", "static")
            print(f"OVERWRITE PARTITIONS {s3t_table}: replaced partitions of {PARTITION_KEYS} with {row_count} rows")` : `${s3GuardPy}${S3_ALIGN_PY}            # 整表覆盖 = 静态模式的 INSERT OVERWRITE(不带 PARTITION 子句 ⇒ 替换整张表),**一次提交**。
            #   原来是「先 DELETE 再 INSERT」两次提交:中途失败会留下一张空表。
            spark.conf.set("spark.sql.sources.partitionOverwriteMode", "static")
            spark.sql(f"INSERT OVERWRITE {s3t_table} SELECT * FROM {temp_view}")
            print(f"OVERWRITE {s3t_table}: atomically replaced with {row_count} rows")`) : isMerge ? `${S3_ALIGN_PY}            # 按键合并 = Iceberg MERGE INTO,**一次提交**。UPDATE SET * / INSERT * 按**列名**展开
            #   (上面已把 df 对齐成目标表的列集合与写法)。键命中 ⇒ 整行更新;未命中 ⇒ 插入;不清表、不预删(与 append / overwrite 都不同)。
            _bgp_mk_t = [next(c for c in df.columns if c.lower() == _k.lower()) for _k in _bgp_mk]
            _bgp_on = " AND ".join(f"t.{_k} = s.{_k}" for _k in _bgp_mk_t)
            spark.sql(f"MERGE INTO {s3t_table} t USING {temp_view} s ON {_bgp_on} WHEN MATCHED THEN UPDATE SET * WHEN NOT MATCHED THEN INSERT *")
            print(f"MERGE {s3t_table}: upserted {row_count} rows on keys {_bgp_mk_t}")` : `${s3GuardPy}            # SYNC-FIX(dup): 增量 append 幂等 —— 与 Redshift 路径一致(Iceberg format-version 2 支持行级
            # DELETE):有水位删该区间;增量但水位为空删整表(全量回填);非增量纯 append 不删。
            if inc_where:
                spark.sql(f"DELETE FROM {s3t_table} WHERE {inc_where}")
                print(f"Idempotent pre-delete on {s3t_table} WHERE {inc_where}")
            elif INCREMENTAL:
                spark.sql(f"DELETE FROM {s3t_table}")
                print(f"Idempotent full reload on {s3t_table} (incremental, empty watermark)")
            # Append
            spark.sql(f"INSERT INTO {s3t_table} SELECT * FROM {temp_view}")
            print(f"APPEND {s3t_table}: inserted {row_count} rows")`}
        else:
            # Create new table with data
${partitionFields.length > 0 ? `            partition_clause = "PARTITIONED BY (${partitionFields.map((p: any) => {
    if (p.type === "date") return `days(${p.field})`;
    if (p.type === "year-month") return `months(${p.field})`;
    return p.field;
  }).join(", ")})"` : `            partition_clause = ""`}
            create_sql = f"CREATE TABLE {s3t_table} USING iceberg {partition_clause} TBLPROPERTIES ('format-version'='2', 'write.parquet.compression-codec'='zstd', '${S3_TABLE_MARKER_PROPERTY}'='${PLATFORM_TABLE_MARKER}') AS SELECT * FROM {temp_view}"
            spark.sql(create_sql)
            print(f"CREATED {s3t_table} with {row_count} rows")
${isOverwrite ? `
        # 写后对数 —— 目标(整表 / 本批涉及的分区)行数必须等于本次读到的行数。
        ${byPartitions ? `_bgp_on = " AND ".join(f"t.{k} <=> b.{k}" for k in PARTITION_KEYS)
        _bgp_keys = ", ".join(PARTITION_KEYS)
        _bgp_target_rows = spark.sql(f"SELECT COUNT(*) FROM {s3t_table} t LEFT SEMI JOIN (SELECT DISTINCT {_bgp_keys} FROM {temp_view}) b ON {_bgp_on}").collect()[0][0]` : `_bgp_target_rows = spark.sql(f"SELECT COUNT(*) FROM {s3t_table}").collect()[0][0]`}
        print(f"SYNC_VERIFY target=s3tables table={s3t_table} scope={OVERWRITE_SCOPE} source_rows={row_count} target_rows={_bgp_target_rows}")
        if _bgp_target_rows != row_count:
            raise Exception(f"SYNC_VERIFY_MISMATCH target=s3tables table={s3t_table}: 写入后目标 {_bgp_target_rows} 行,本次读到 {row_count} 行")
` : ""}${isMerge ? `
        # 写后对数 —— 目标里键命中本批的行数必须等于本次读到的行数(源内键唯一 ⇒ 一行对一行;多了 = 重复,少了 = 丢行)。
        _bgp_on = " AND ".join(f"t.{_k} <=> b.{_k}" for _k in _bgp_mk_t)
        _bgp_keys = ", ".join(_bgp_mk_t)
        _bgp_target_rows = spark.sql(f"SELECT COUNT(*) FROM {s3t_table} t LEFT SEMI JOIN (SELECT DISTINCT {_bgp_keys} FROM {temp_view}) b ON {_bgp_on}").collect()[0][0]
        print(f"SYNC_VERIFY target=s3tables table={s3t_table} scope=merge source_rows={row_count} target_rows={_bgp_target_rows}")
        if _bgp_target_rows != row_count:
            raise Exception(f"SYNC_VERIFY_MISMATCH target=s3tables table={s3t_table}: 写入后目标里键命中本批的 {_bgp_target_rows} 行,本次读到 {row_count} 行")
` : ""}
        print(f"Written to S3 Tables: {s3t_table}")
        print(f"Table Bucket: {S3T_BUCKET_RAW}, Namespace: {S3T_NAMESPACE}")
${partitionFields.length > 0 ? `        print(f"Partitioned by: ${partitionFields.map((p: any) => `${p.field}(${p.type})`).join(", ")}")` : ""}

    except Exception as e:
        error_msg = str(e)
        print(f"S3 Tables write error: {error_msg[:300]}")
        raise e
` : ""}${writeRedshift ? `
    # Write to Redshift via Data API.
    # BUG-G2 根因修复:此前用 Glue 的 IAM 身份(IAMR:bgp-glue-role)执行 Data API,该身份对 dev 库
    # 无 CREATE 权限 → CREATE SCHEMA "permission denied for database dev" → 建表报 schema 不存在。
    # 改用 **Redshift 托管 admin secret**(与 DMS 路径 execAdminSql 一致,有全权),所有 Data API 语句
    # 都带 SecretArn=admin 执行,从而能建 schema/表/授权。admin secret 名固定 redshift!bgp-namespace-admin。
    import time
    # 数仓四样(区/workgroup/库/凭证)全部来自注入的 binding。
    rs_client = boto3.client("redshift-data", region_name=_BGP_PLACE["region"])
    rs_workgroup = _BGP_RS["workgroup"]
    rs_database = _BGP_RS["database"]
    rs_schema = "${rsSchemaSafe}"
    rs_table = f"{rs_schema}.{target_name}"
    # Bug#3:SORTKEY/DISTKEY 作为【数据】注入,建表前用真实 df.columns 校验(TS 生成期拿不到列)。
    RS_SORT_KEYS = ${JSON.stringify(_rsSortKeys)}
    RS_DIST_KEY = ${JSON.stringify(_rsDistKey)}
    RS_DIST_STYLE = ${JSON.stringify(_rsDistStyle)}
    # 🔴 执行凭证 ARN 由平台生成期从 binding 解析后**注入**(home = 既有 admin secret,
    # 与旧运行期探名拿到的是同一把;非 home = 该 target 自己的凭证)。原先 Python 侧按 home 命名
    # 运行期探名的写法已退役 —— 那个名字是主控区的,非 home 区按它探,探到 = 连错身份,
    # 探不到 = 静默回 IAM,两头都是错。值为 None(无密钥裸环境)= 回退 IAM 身份(旧语义不变)。
    RS_ADMIN_SECRET_ARN = _BGP_RS.get("secretArn")
    print(f"Writing to Redshift: {rs_table} via Data API (admin secret: {'yes' if RS_ADMIN_SECRET_ARN else 'no/fallback-IAM'})")

    try:
        cols = df.columns
        col_types = []
        for f in df.schema.fields:
            t = str(f.dataType)
            # SYNC-FIX(typemap): map EVERY Spark numeric type Redshift-compatibly, matching WIDER
            # types FIRST (Spark repr strings are substrings — "Integer" contains "Int"; "LongType"
            # /"Bigint" and "ShortType"/"ByteType" do NOT contain "Int"). Narrow ints (Byte/Short)
            # are already cast to IntegerType above so the staging Parquet's physical type matches
            # Redshift and COPY(Parquet) succeeds — the Byte/Short branch here maps to INTEGER to
            # stay consistent with that cast (belt-and-suspenders; without the cast, a ByteType would
            # otherwise fall through to VARCHAR and break COPY with Spectrum Scan Error 15007).
            if "Boolean" in t: col_types.append("BOOLEAN")
            elif "Byte" in t or "Short" in t: col_types.append("INTEGER")
            elif "Long" in t or "Bigint" in t: col_types.append("BIGINT")
            elif "Integer" in t or "Int" in t: col_types.append("INTEGER")
            elif "Double" in t or "Float" in t: col_types.append("DOUBLE PRECISION")
            elif "Decimal" in t:
                p = getattr(f.dataType, 'precision', 18)
                s = getattr(f.dataType, 'scale', 2)
                col_types.append(f"DECIMAL({p},{s})")
            elif "Date" in t and "Timestamp" not in t: col_types.append("DATE")
            elif "Timestamp" in t: col_types.append("TIMESTAMP")
            else:
                # 防线②:未知/未覆盖类型不再"静默塞 VARCHAR"。VARCHAR 是安全兜底(不丢数),但若该
                # 列在 Parquet 里是非字符串物理类型,COPY(Parquet) 会像 TINYINT 那次一样报 Spectrum
                # Scan Error 再退化成慢 INSERT。发一个 machine-parseable 告警标记,让新类型盲区在下一
                # 次运行就暴露(而不是潜伏),同时 str-cast 该列使 Parquet 物理类型=string 与 VARCHAR 一致
                # (COPY 也能成)。这样"覆盖不到的类型"既不丢数、又不隐性退化、还会被看见。
                print(f"SYNC_UNMAPPED_TYPE col={f.name} spark_type={t} -> VARCHAR(65535) (cast to string for COPY-safety)")
                df = df.withColumn(f.name, _NF.col(f.name).cast("string"))
                col_types.append("VARCHAR(65535)")

        col_defs = ", ".join(f"{c} {ct}" for c, ct in zip(cols, col_types))

        # Bug#3:用【真实列 cols】校验 SORTKEY/DISTKEY,剔除不存在的列(大小写不敏感,因 Redshift
        # 不带引号标识符折叠小写)→ 避免 CREATE TABLE 报 "column xxx does not exist"。规则与 TS 侧
        # buildRedshiftTableClause(availableColumns) 逐字对齐(同一 SSOT,只是执行侧列到 Python 才有)。
        _cols_lower = {c.lower() for c in cols}
        _sort_valid = [k for k in RS_SORT_KEYS if k.lower() in _cols_lower]
        for _k in RS_SORT_KEYS:
            if _k.lower() not in _cols_lower:
                print(f"SYNC_KEY_DROPPED kind=sortkey col={_k} table={target_name} reason=not_in_synced_columns")
        _dist_valid = RS_DIST_KEY if (RS_DIST_KEY and RS_DIST_KEY.lower() in _cols_lower) else ""
        if RS_DIST_KEY and not _dist_valid:
            print(f"SYNC_KEY_DROPPED kind=distkey col={RS_DIST_KEY} table={target_name} reason=not_in_synced_columns")
        _rs_clause = ""
        if RS_DIST_STYLE == "key":
            if _dist_valid:
                _rs_clause += f" DISTKEY({_dist_valid})"
        elif RS_DIST_STYLE and RS_DIST_STYLE != "auto":
            _rs_clause += f" DISTSTYLE {RS_DIST_STYLE.upper()}"
        if _sort_valid:
            _rs_clause += f" SORTKEY({', '.join(_sort_valid)})"

        # SYNC-FIX: run a Data API statement and FAIL FAST. A statement that does not
        # reach FINISHED raises immediately — never silently continue (root-caused two
        # bugs: a failed INSERT was swallowed so the job "succeeded" with 0 rows, and a
        # permission-denied INSERT was retried for every batch, burning minutes of compute).
        # (2026-10-26 测试账号真环境):Redshift Data API 对单条语句偶发回「An I/O error occurred while sending to the backend」
        #   这类**连接层瞬态错**;原来一次失败即抛 ⇒ CREATE 已成、COMMENT(平台标记)失败 ⇒ 留下一张**无标记的空表**,
        #   之后每次运行都被 SYNC_REFUSED_CLEAR_FOREIGN_TABLE 拒绝(守卫按设计,可那张表是平台自己建的,用户无路可走)。
        #   修两处:① run_stmt / run_batch / 探测只对连接层瞬态签名**有界重试**(3 次,2 / 4 秒;权限 / 语法 / 对象不存在等照旧
        #   立刻抛,不回到「每批都重试」的老病);② 建表与打标记放进**同一个事务**(batch_execute_statement),要么都成要么都不成 ——
        #   「平台建的表一定带标记」从此是不变量。Data API 的 FAILED 表示该语句未提交,重试同一条语句是安全的。
        _last_err = {"msg": ""}
        _TRANSIENT_BACKEND_SIGNATURES = ("i/o error", "connection reset", "connection refused", "could not connect",
                                         "server closed the connection", "terminating connection", "ssl syscall error",
                                         "connection timed out", "connection has been closed", "broken pipe")

        def _is_transient_backend_error(err):
            e = (err or "").lower()
            return any(sig in e for sig in _TRANSIENT_BACKEND_SIGNATURES)

        def _wait_statement(sid):
            while True:
                desc = rs_client.describe_statement(Id=sid)
                if desc["Status"] in ("FINISHED", "FAILED", "ABORTED"):
                    return desc
                time.sleep(1)

        def _data_api_kwargs():
            # 带 admin SecretArn 执行(有全权);无则回退 IAM 身份(兼容旧行为)。
            _kw = {"WorkgroupName": rs_workgroup, "Database": rs_database}
            if RS_ADMIN_SECRET_ARN:
                _kw["SecretArn"] = RS_ADMIN_SECRET_ARN
            return _kw

        def _submit_with_retry(submit, label, attempts=3):
            # submit() 发一条 / 一批语句并等到终态;只在连接层瞬态签名上重试,其余错误原样交回调用方(不吞、不改语义)。
            desc = None
            for _i in range(attempts):
                desc = submit()
                if desc["Status"] == "FINISHED":
                    _last_err["msg"] = ""
                    return desc
                _last_err["msg"] = str(desc.get("Error", "") or "")
                if _i + 1 < attempts and _is_transient_backend_error(_last_err["msg"]):
                    print(f"SYNC_RS_TRANSIENT_RETRY label={label} attempt={_i + 1} err={_last_err['msg'][:160]}")
                    time.sleep(2 * (_i + 1))
                    continue
                return desc
            return desc

        def run_stmt(sql, label, fatal=True):
            desc = _submit_with_retry(lambda: _wait_statement(rs_client.execute_statement(Sql=sql, **_data_api_kwargs())["Id"]), label)
            if desc["Status"] != "FINISHED":
                msg = f"{label} failed: {desc.get('Error','')}"
                if fatal:
                    raise Exception(msg)
                print(msg)
                return False
            return True

        def run_batch(sqls, label):
            # Data API 的 batch_execute_statement 把多条语句作为**一个事务**执行(全成或全不成)。
            desc = _submit_with_retry(lambda: _wait_statement(rs_client.batch_execute_statement(Sqls=sqls, **_data_api_kwargs())["Id"]), label)
            if desc["Status"] != "FINISHED":
                raise Exception(f"{label} failed: {desc.get('Error','')}")
            return True

        def _is_concurrent_schema_create(err):
            # 与 Node 侧 lib/redshift/concurrent-schema.ts 同一套签名(两个运行时各一份,判据钉住同源)。
            e = (err or "").lower()
            if "pg_namespace_nspname_index" in e:
                return True
            dup = ("duplicate key" in e) or ("already exists" in e)
            return dup and (("schema" in e) or ("namespace" in e))

        def ensure_schema(sql, label="CREATE SCHEMA", attempts=4):
            # 🔴 CREATE SCHEMA IF NOT EXISTS 在 Redshift **不是原子的**:N 个同步任务并发跑时,
            #   几个会同时看到「schema 不存在」并都去往 pg_namespace 插一行,后提交的撞唯一索引:
            #   duplicate key violates unique constraint "pg_namespace_nspname_index"
            #   (possibly caused by concurrent transaction conflict)
            #   2026-09-19 真环境:第二个 region 6 个同步任务并发 ⇒ 3 个当场失败,而依赖它们的
            #   ETL / 编排 / 治理跟着红 —— 一个根因六条红。主控区没现形只因为那边并发度是 1。
            #   重试就能好:并发者提交之后再跑一次就是真正的 no-op 成功 ⇒ 成功本身即证明 schema 在。
            #   🔴 判别力:只在这个签名上重试;权限不足等一切别的错误照旧**立刻**抛(那条教训在下面)。
            for _i in range(attempts):
                if run_stmt(sql, label, fatal=False):
                    return True
                if not _is_concurrent_schema_create(_last_err["msg"]):
                    raise Exception(f"{label} failed: {_last_err['msg']}")
                print(f"SYNC_SCHEMA_CONCURRENT attempt={_i + 1} err={_last_err['msg'][:160]}")
                time.sleep(2 + 2 * _i)
            raise Exception(f"{label} failed after {attempts} attempts: {_last_err['msg']}")

        # BUG-G2 修复:建表前先建 schema。现在用 admin secret 执行(有 CREATE ON DATABASE 权限),
        # CREATE SCHEMA 真失败要暴露(不再吞掉导致后续建表报 schema 不存在);而**并发创建者赢了**
        # 这一种不是失败,由 ensure_schema 重试到 no-op 成功。
        ensure_schema(f"CREATE SCHEMA IF NOT EXISTS {rs_schema}", "CREATE SCHEMA")
        # Create table if missing. 用 DELETE 而不是 TRUNCATE:①TRUNCATE 是 owner-only;
        # ②增量幂等路径要按 WHERE 精确删区间(见下方 inc_where),TRUNCATE 做不到。
        # 🔴 L1后**不再需要**"向导预建的表 owner 不同"这层担心:sync/execute-ddl
        #    已改用同一个 admin secret ⇒ 两侧同 owner,不靠任何补授权。
        #    (本注释在 TS 模板串里,禁写反引号——它会当场截断模板字符串。)
        # SYNC-FIX(sortkey): 建表带上 DISTKEY/DISTSTYLE/SORTKEY(与预览 DDL 一致;此前执行脚本裸建表丢了它们)。
        #   Bug#3:_rs_clause 是上面用真实 cols 校验后组装的(不存在的键已剔除),不再是 TS 静态拼死。
        # 🔴 生产上线批次 A:**不许静默清空客户已有的表**(规则唯一作者 lib/sync/target-table-guard.ts)。
        #   平台自己建的表带标记;要整表清空一张「已存在且无标记」的表,必须在任务的确认清单里,
        #   否则本次运行**在任何 DELETE 之前**失败。这里是所有入口(向导 / 调度 / API / Copilot)唯一必经点。
        PLATFORM_TABLE_MARKER = ${JSON.stringify(PLATFORM_TABLE_MARKER)}
        OVERWRITE_CONFIRMED = set(${JSON.stringify(overwriteConfirmed)})
        def _query_rows(sql, label):
            _sid_box = {}
            def _submit_probe():
                _sid_box["sid"] = rs_client.execute_statement(Sql=sql, **_data_api_kwargs())["Id"]
                return _wait_statement(_sid_box["sid"])
            desc = _submit_with_retry(_submit_probe, label)
            if desc["Status"] != "FINISHED":
                raise Exception(f"{label} failed: {desc.get('Error','')}")
            if not desc.get("HasResultSet"):
                return []
            return rs_client.get_statement_result(Id=_sid_box["sid"]).get("Records", [])
        _rs_fq = f"{rs_schema.lower()}.{target_name}"
        _rows = _query_rows(
            "SELECT COALESCE(d.description, '') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
            "LEFT JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0 "
            f"WHERE c.relkind = 'r' AND n.nspname = '{rs_schema.lower()}' AND c.relname = '{target_name}'",
            "PROBE(target table)")
        _existed = len(_rows) > 0
        _marked = _existed and str((_rows[0][0] or {}).get("stringValue", "")) == PLATFORM_TABLE_MARKER
        _will_clear = ${effectiveMode === "overwrite" ? "True" : isMerge ? "False" : "(INCREMENTAL and not inc_where)"}
        if _will_clear and _existed and not _marked and _rs_fq not in OVERWRITE_CONFIRMED:
            raise Exception(
                f"SYNC_REFUSED_CLEAR_FOREIGN_TABLE table={_rs_fq}: 目标表已存在且不是平台建的,"
                f"本次同步会整表清空它 —— 未经确认,拒绝执行(一行未删)。"
                f"如确需覆盖,请在同步任务里确认覆盖该表;否则改用追加写入或换一个目标表名。")
        create_sql = f"CREATE TABLE IF NOT EXISTS {rs_table} ({col_defs}){_rs_clause}"
        print(f"DDL: {create_sql}")
        if _existed:
            # 已存在(带标记,或用户已确认覆盖)⇒ 建表语句照旧单条跑(IF NOT EXISTS 下是 no-op),不碰标记。
            run_stmt(create_sql, "DDL")
        else:
            # 建表 + 打平台标记在**同一个事务**里 —— 标记打不上就连表也不留(否则下次运行会被守卫当成客户的表拒掉)。
            run_batch([create_sql, f"COMMENT ON TABLE {rs_table} IS '{PLATFORM_TABLE_MARKER}'"], "DDL+COMMENT(platform marker)")
            print(f"SYNC_TABLE_MARKED table={_rs_fq}")

        # 🔴 **原来这里有一条"把目标表授权给 PUBLIC"的语句,已删(L1 第 ② 处,52 SPEC §3.5)。**
        # 它把每次同步的目标表对**库内所有身份**放开 = 直接击穿项目隔离,而它的唯一理由
        # ("平台查询页/再跑时可能不是 owner")已经不存在:本脚本与 sync/execute-ddl、
        # 平台 16 处读路径现在都用同一个 admin secret ⇒ 同 owner,天然可读可写。
        # 🔴 别加回来(生成侧提示词/配方已同步撤掉该建议,并有扫描门禁钉死)。

${isOverwrite || isMerge ? `${isMerge ? `        # 按键合并复用覆盖路的暂存表机制:先装进暂存表(结构同目标表),装好后在**一个事务**里
        # 「删掉目标里键命中的行 + 从暂存表插入」,再按键对数;任何一步失败,目标表保持原样。暂存表用完即删。` : `        #:覆盖写入**不再先清目标表**。原来是 DELETE 与 COPY 两条独立语句:COPY 失败就留下一张空表。
        #   现在:先装进暂存表(结构同目标表),装好后在**一个事务**里「清目标(整表 / 本批涉及的分区)+ 从暂存表插入」,
        #   再对数;任何一步失败,目标表保持原样。暂存表用完即删。`}
        rs_stage = f"{rs_schema}.{target_name[:110]}__bgp_stage"
        # run_batch(一个事务)的唯一定义在上面 run_stmt 旁边(建表 + 打标记也用它)。

        run_stmt(f"DROP TABLE IF EXISTS {rs_stage}", "DROP(stage)")
        run_stmt(f"CREATE TABLE {rs_stage} (LIKE {rs_table})", "CREATE(stage)")
        rs_load_table = rs_stage
        print(f"${isMerge ? "Merge" : "Overwrite"}: loading into stage {rs_stage}; target {rs_table} untouched until the swap")` : `        # SYNC-FIX(dup): 增量 append 幂等 —— 落库前删掉本次将要重载的区间,再写入。即使水位未前进
        # (日志解析失败等)而重跑,也不会重复追加。表此前若不存在,CREATE IF NOT EXISTS 已建空表,
        # DELETE 命中 0 行(安全幂等)。三种情形:
        #  · 有水位:按与读取完全相同的谓词 incCol>水位 精确删该区间;
        #  · 增量但水位为空(全量回填):读的是整表,故整表清空后重载(等价该表 overwrite);
        #  · 非增量的纯 append:保持原样追加(不删)。
        if inc_where:
            run_stmt(f"DELETE FROM {rs_table} WHERE {inc_where}", "DELETE(incremental idempotent reload)")
            print(f"Idempotent pre-delete on {rs_table} WHERE {inc_where}")
        elif INCREMENTAL:
            run_stmt(f"DELETE FROM {rs_table}", "DELETE(incremental full reload — empty watermark)")
            print(f"Idempotent full reload on {rs_table} (incremental, empty watermark)")`}

        # SYNC-FIX(B9): bulk-load via Redshift COPY (S3 staging Parquet) instead of row-by-row
        # Data API INSERTs. A 420k-row table was ~1h of serial 100-row INSERTs; COPY loads in
        # parallel from S3 in seconds-to-minutes. COPY needs an IAM role that is (a) ASSOCIATED
        # to the Redshift namespace and (b) able to read the staging bucket. We DISCOVER that role
        # at runtime (account/stack churn-proof, never hardcoded); if none is usable we FALL BACK
        # to the legacy batched INSERT so the path never regresses.
        def discover_copy_role():
            # Derive namespace from the workgroup at runtime (no hardcoded namespace name),
            # then read its associated IAM roles. COPY's IAM_ROLE must be one associated to the
            # namespace AND able to read the staging bucket.
            try:
                rss = boto3.client("redshift-serverless", region_name=_BGP_PLACE["region"])
                ns_name = rss.get_workgroup(workgroupName=rs_workgroup)["workgroup"]["namespaceName"]
                ns = rss.get_namespace(namespaceName=ns_name)["namespace"]
                roles = []
                for r in (ns.get("iamRoles") or []):
                    m = re.search(r"arn:aws:iam::[^,)\\"\\s]+", r)
                    if m: roles.append(m.group(0))
                # Prefer a role whose name hints broad S3 read (immersion/admin/spectrum), else first associated.
                for r in roles:
                    if any(k in r for k in ["Immersion", "Admin", "Redshift", "Spectrum", "Copy"]):
                        return r
                return roles[0] if roles else None
            except Exception as e:
                print(f"COPY role discovery failed: {str(e)[:200]}")
                return None

        # Staging 桶来自注入的落点 binding(单一作者 resolveGlueBinding;home 与旧「按运行期账号拼
        # bgp-datalake-<acct>」逐字相等)。原来在脚本里按账号拼,非 home 的湖桶名带 slug 后缀 ⇒ 必错,
        # 而且错法是把该区数据 stage 进一个不存在/别人的桶名。
        staging = f"s3://${landing.datalakeBucket}/sync-staging/{args['JOB_NAME']}/{target_name}/"
        inserted = 0
        loaded_via = None
        # SYNC-FIX(dup): 增量稳态可能读到 0 行(谓词命中无新增)。此时 pre-delete 已幂等执行,
        # 直接跳过写入 —— 净效果 +0 行,且避免空 staging 的 COPY 歧义。
        copy_role = discover_copy_role() if row_count > 0 else None
        if row_count == 0:
            print(f"No new rows above watermark on {rs_table} — skip load (idempotent +0 rows).")
            loaded_via = "SKIP"
        if copy_role:
            try:
                # Write staging Parquet (overwrite this job's own prefix each run — idempotent).
                df.write.mode("overwrite").parquet(staging)
                # Explicit column list so COPY maps by name (robust if the table was pre-created by
                # the wizard with a different column order); Parquet is written from the same df.
                copy_sql = (
                    f"COPY {${rsLoadTable}} ({','.join(cols)}) FROM '{staging}' IAM_ROLE '{copy_role}' "
                    f"FORMAT AS PARQUET SERIALIZETOJSON"
                )
                print(f"COPY: {rs_table} FROM {staging} (role={copy_role})")
                run_stmt(copy_sql, "COPY(Parquet)")
                inserted = row_count
                loaded_via = "COPY"
            except Exception as e:
                # 防线①:COPY 回退 INSERT 不再静默。发一个 machine-parseable 告警标记(poller
                # 解析后把 run 标 degraded=copy_fallback),否则"COPY 失败→慢 INSERT 兜底"会像
                # TINYINT 那次一样潜伏很久无人察觉(数据不丢、任务仍 SUCCEEDED、只是慢十倍)。
                # 全球用户任何未覆盖的类型/权限盲区导致的性能退化,从此下一次运行就能被看见。
                print(f"COPY failed, will fall back to batched INSERT: {str(e)[:300]}")
                print(f"SYNC_DEGRADED reason=copy_fallback table={rs_table} detail={str(e)[:200].replace(chr(10),' ')}")
                loaded_via = None

        if loaded_via not in ("COPY", "SKIP"):
            # Fallback: batched INSERT via Data API (FAIL FAST: first failing batch raises).
            rows = df.collect()
            batch_size = 100
            inserted = 0
            for i in range(0, len(rows), batch_size):
                batch = rows[i:i+batch_size]
                values_list = []
                for row in batch:
                    vals = []
                    for v in row:
                        if v is None: vals.append("NULL")
                        elif isinstance(v, (int, float)): vals.append(str(v))
                        else: vals.append("'" + str(v).replace("'", "''") + "'")
                    values_list.append("(" + ",".join(vals) + ")")
                insert_sql = f"INSERT INTO {${rsLoadTable}} ({','.join(cols)}) VALUES {','.join(values_list)}"
                run_stmt(insert_sql, f"Insert batch @row{i}")
                inserted += len(batch)
            loaded_via = "INSERT"

${isOverwrite ? `        # 一个事务里换入 + 对数(对数在暂存表删除之前做,按分区覆盖要用它圈定分区)。
        _cols_csv = ",".join(cols)
        if OVERWRITE_SCOPE == "partitions":
            _pk = PARTITION_KEYS[0]
            _clear = f"DELETE FROM {rs_table} WHERE {_pk} IN (SELECT DISTINCT {_pk} FROM {rs_stage})"
            _count_sql = f"SELECT COUNT(*) FROM {rs_table} WHERE {_pk} IN (SELECT DISTINCT {_pk} FROM {rs_stage})"
        else:
            _clear = f"DELETE FROM {rs_table}"
            _count_sql = f"SELECT COUNT(*) FROM {rs_table}"
        run_batch([_clear, f"INSERT INTO {rs_table} ({_cols_csv}) SELECT {_cols_csv} FROM {rs_stage}"], "SWAP(overwrite)")
        _bgp_cnt = _query_rows(_count_sql, "VERIFY(count)")
        _bgp_target_rows = int((_bgp_cnt[0][0] or {}).get("longValue", -1)) if _bgp_cnt else -1
        run_stmt(f"DROP TABLE IF EXISTS {rs_stage}", "DROP(stage)", fatal=False)
        print(f"SYNC_VERIFY target=redshift table={rs_table} scope={OVERWRITE_SCOPE} source_rows={row_count} target_rows={_bgp_target_rows}")
        if _bgp_target_rows != row_count:
            raise Exception(f"SYNC_VERIFY_MISMATCH target=redshift table={rs_table}: 写入后目标 {_bgp_target_rows} 行,本次读到 {row_count} 行")
` : ""}${isMerge ? `        # 一个事务里「删掉目标里键命中的行 + 从暂存表插入」= upsert;按键对数(暂存表删除之前做)。
        #   Redshift 标识符不区分大小写,键按本次读到的列名写即可。
        _cols_csv = ",".join(cols)
        _bgp_on = " AND ".join(f"{rs_table}.{_k} = {rs_stage}.{_k}" for _k in _bgp_mk)
        _bgp_on_ts = " AND ".join(f"t.{_k} = s.{_k}" for _k in _bgp_mk)
        run_batch([f"DELETE FROM {rs_table} USING {rs_stage} WHERE {_bgp_on}", f"INSERT INTO {rs_table} ({_cols_csv}) SELECT {_cols_csv} FROM {rs_stage}"], "MERGE(upsert)")
        _bgp_cnt = _query_rows(f"SELECT COUNT(*) FROM {rs_table} t WHERE EXISTS (SELECT 1 FROM {rs_stage} s WHERE {_bgp_on_ts})", "VERIFY(count)")
        _bgp_target_rows = int((_bgp_cnt[0][0] or {}).get("longValue", -1)) if _bgp_cnt else -1
        run_stmt(f"DROP TABLE IF EXISTS {rs_stage}", "DROP(stage)", fatal=False)
        print(f"SYNC_VERIFY target=redshift table={rs_table} scope=merge source_rows={row_count} target_rows={_bgp_target_rows}")
        if _bgp_target_rows != row_count:
            raise Exception(f"SYNC_VERIFY_MISMATCH target=redshift table={rs_table}: 写入后目标里键命中本批的 {_bgp_target_rows} 行,本次读到 {row_count} 行")
` : ""}        print(f"Written {inserted} rows to Redshift: {rs_table} via {loaded_via}")
        # SYNC-FIX(B1): machine-parseable marker so the poller can backfill real metrics.
        print(f"REDSHIFT_ROWS_WRITTEN table={rs_table} rows={inserted}")
    except Exception as e:
        print(f"Redshift write error: {e}")
${isOverwrite || isMerge ? `        # 失败也不留暂存表(目标表在换入事务之前没被动过)
        try:
            run_stmt(f"DROP TABLE IF EXISTS {rs_stage}", "DROP(stage)", fatal=False)
        except Exception:
            pass
` : ""}        raise e
` : ""}
    results[table_name] = {"rows": row_count, "columns": col_count}
    # SYNC-FIX(B1): emit per-table rows-read marker for metric backfill (covers S3-only targets too).
    print(f"ROWS_READ table={table_name} rows={row_count}")
    print(f"Table {table_name} sync completed: {row_count} rows")

print(f"\\n{'='*60}")
print(f"SYNC RESULTS: {json.dumps(results)}")
# 目标标识按实际写入路径打印(不能无条件说"Target: S3 Tables",否则 writeS3=False 时会造成
# "看着写了 S3Table 实则没写"的假象=假成功误导;根因见 api/sync targetType 校验注释)。
print(f"Target(s): ${[writeS3 ? `S3 Tables (${tableBucketName}/${namespace})` : null, writeRedshift ? `Redshift` : null].filter(Boolean).join(" + ") || "NONE (targetType 未产出任何写入路径!)"}")
print(f"{'='*60}")

job.commit()
`;
}
