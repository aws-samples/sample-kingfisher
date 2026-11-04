// 平台 Glue 版本的唯一作者。
//   取用方:同步向导选项与缺省 / 新建与保存校验 / 启动核心 fail-closed、离线计算表单与作业定义、数据源发现作业、
//   参数顾问推荐值、需求代码生成提示词、运行诊断证据、配方文案。
//   🔴 两个「零 @/ alias」的 core 包(param-advisor/core、cookbook)不能 import 本文件 ⇒ 各自内联一份,由单测与本文件 toEqual 比对
//   (core-catalog-drift.test.ts / cookbook glue-version-drift.test.ts),真源变了内联没跟就红。
//
// 【缺陷原形(2026-10-13 客户生产环境)】写 S3 Tables 的同步任务被建成 Glue 5.0:建任务 200、保存 200、启动 200,
//   作业跑到写表那一刻才报「S3 Tables write error: … Invalid S3 URI … arn:aws:s3tables:…」失败。
//   根因:S3 Tables 走 Glue 联邦目录 `s3tablescatalog/<表桶>` + warehouse = 表桶 ARN,这套写法**只在 Glue 5.1 及以上可用**;
//   而 glueConfig.glueVersion 是「有静默合法默认值的参数」—— 向导给 4.0 / 5.0 / 5.1 三个值随便选,后端一律放过。
// 【规则】目标写 S3 Tables(targetType = s3-tables / both,glue 通道)⇒ glueVersion 必须 ≥ 5.1;
//   不带 glueVersion ⇒ 取缺省(与 start-run 的缺省同一个常量);只写 Redshift 的任务不限(4.0 / 5.0 仍合法)。
// 【(用户 2026-10-26 拍板)】缺省 = 清单里的**最高版本**;用户可在同步向导 / 离线计算表单里自己选更低版本;
//   存量任务 / 作业各自存着的版本**不被动改**(升级平台不改任何已有作业的 Glue 版本)。新 Glue 版本发布时只改本文件的
//   GLUE_VERSIONS + GLUE_RUNTIME_FACTS 两处(以及两个 core 内联,单测会逼着改)。
//   AWS 事实(docs.aws.amazon.com/glue/latest/dg/migrating-version-60.html,2026-10-26 读):Glue 6.0 = Spark 4.1.1 / Python 3.13 /
//   Scala 2.13.17 / Iceberg 1.11.0;只带 AWS SDK for Java v2(v1 移除);EMRFS 移除,S3 只有 S3A(s3:// 路径自动走它);
//   Spark ANSI 模式缺省开(整数溢出 / 非法 cast 抛异常而非回 NULL);getResolvedOptions 不再接受参数名前缀缩写;
//   JDBC 驱动 MySQL 8.0.33 / PostgreSQL 42.7.3 / SQL Server 10.2.0 与 5.1 相同;Python 侧 AWS SDK 照常。
//   平台生成的脚本已按这些迁移点核过:用全名读参数、Python SDK 读密钥与数仓(Data API)、s3:// 路径、宽化 cast(Byte/Short → int)无溢出。
//   (本文件只是版本事实,不生成任何别处执行的代码 —— 注释里刻意不出现 prod-only-layers 守卫用来发现代码生成器的特征词。)

/** 可选的 Glue 版本(闭合清单,按版本升序;不在清单里的值一律拒,不猜)。 */
export const GLUE_VERSIONS = ["4.0", "5.0", "5.1", "6.0"] as const;
export type GlueVersion = (typeof GLUE_VERSIONS)[number];
/** 缺省 = 清单里的最高版本(单测钉「缺省 == 最高」)。 */
export const GLUE_VERSION_DEFAULT: GlueVersion = "6.0";
/** 写 S3 Tables 的最低 Glue 版本。 */
export const S3_TABLES_MIN_GLUE_VERSION = "5.1";
/**
 * 🔴 记录里**没有** glueVersion 字段的存量同步任务 / 离线作业,运行时按**它们被写下时的缺省**(5.1)跑,而不是跟着新缺省走。
 *   「缺省取最高」只决定**新建**对象;升级平台不许静默改任何已有作业的 Glue 版本(用户 2026-10-26:
 *   「用户的生产环境不会跟随我们的支持版本升级」)。这个值只在新 Glue 大版本成为缺省时**不**改 —— 它钉的是历史事实。
 */
export const GLUE_VERSION_FOR_UNVERSIONED_RECORDS: GlueVersion = "5.1";

/** 每个版本对应的运行时事实(AWS 文档;给下拉文案 / 提示词 / 配方用,不许在别处再抄一份)。 */
export interface GlueRuntimeFacts {
  spark: string;
  python: string;
  iceberg: string;
  /** 从上一版迁移时要知道的行为变化(没有就省略)。 */
  migrationNotes?: string;
}
export const GLUE_RUNTIME_FACTS: Record<GlueVersion, GlueRuntimeFacts> = {
  "4.0": { spark: "3.3.0", python: "3.10", iceberg: "1.0.0" },
  "5.0": { spark: "3.5.4", python: "3.11", iceberg: "1.7.1" },
  "5.1": { spark: "3.5.6", python: "3.11", iceberg: "1.10.0" },
  "6.0": {
    spark: "4.1.1",
    python: "3.13",
    iceberg: "1.11.0",
    migrationNotes:
      "Spark 4 ANSI 模式缺省开(整数溢出 / 非法 cast 报错而不是回 NULL,需要旧行为可加 --conf spark.sql.ansi.enabled=false);" +
      "只带 AWS SDK for Java v2;S3 只有 S3A(s3:// 路径自动走它);Scala 2.13(自带 jar 要按 2.13 重编);" +
      "getResolvedOptions 不再接受参数名前缀缩写,要写全名",
  },
};

function parts(v: string): [number, number] {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(v).trim());
  if (!m) return [NaN, NaN];
  return [Number(m[1]), Number(m[2] ?? "0")];
}

/** 版本号比较(只认「主.次」两段数字):a < b ⇒ 负,相等 ⇒ 0,a > b ⇒ 正;解析不出来的一律排最前(视为最低)。 */
export function compareGlueVersions(a: string, b: string): number {
  const [a1, a2] = parts(a);
  const [b1, b2] = parts(b);
  const an = Number.isNaN(a1) || Number.isNaN(a2);
  const bn = Number.isNaN(b1) || Number.isNaN(b2);
  if (an || bn) return an && bn ? 0 : an ? -1 : 1;
  return a1 !== b1 ? a1 - b1 : a2 - b2;
}

export function isGlueVersion(v: unknown): v is GlueVersion {
  return typeof v === "string" && (GLUE_VERSIONS as readonly string[]).includes(v);
}

/** 下拉里给用户看的文案:版本 + 它意味着的 Spark / Python(用户按这个决定要不要降版)。 */
export function glueVersionLabel(v: string): string {
  if (!isGlueVersion(v)) return `Glue ${v}`;
  const f = GLUE_RUNTIME_FACTS[v];
  return `Glue ${v}(Spark ${f.spark} / Python ${f.python})`;
}

/** 给提示词 / 配方 / 诊断证据用的一句话运行环境描述(缺省版本不传参)。 */
export function glueRuntimeSummary(v: string = GLUE_VERSION_DEFAULT): string {
  if (!isGlueVersion(v)) return `AWS Glue ${v}`;
  const f = GLUE_RUNTIME_FACTS[v];
  return `AWS Glue ${v}(Spark ${f.spark} / Python ${f.python} / Iceberg ${f.iceberg})`;
}

/**
 * 离线计算作业 / 发现作业定义用的版本断言:不填 ⇒ 缺省;填了不在清单 ⇒ 抛(中文,直接回给用户),绝不替用户猜一个。
 */
export function assertGlueVersion(v: unknown): GlueVersion {
  if (v === undefined || v === null || v === "") return GLUE_VERSION_DEFAULT;
  if (!isGlueVersion(v)) {
    throw new Error(`Glue 版本不合法:${JSON.stringify(v)}(可选:${GLUE_VERSIONS.join(" / ")};缺省 ${GLUE_VERSION_DEFAULT})`);
  }
  return v;
}

/**
 * 存量记录(同步任务 / 离线作业行)里存的版本 ⇒ 这次运行用的版本:没存 ⇒ GLUE_VERSION_FOR_UNVERSIONED_RECORDS(不是新缺省);
 * 存了不在清单 ⇒ 抛(不替用户猜)。新建表单的缺省请用 GLUE_VERSION_DEFAULT,别用这个。
 */
export function glueVersionOfRecord(stored: unknown): GlueVersion {
  if (stored === undefined || stored === null || stored === "") return GLUE_VERSION_FOR_UNVERSIONED_RECORDS;
  return assertGlueVersion(stored);
}

/** Glue 6.0 起底座是 Spark 4(ANSI 缺省开、JDBC 类型映射有变)⇒ 平台生成的同步脚本要带兼容开关。 */
export function glueVersionNeedsSpark4Compat(v: string): boolean {
  return compareGlueVersions(v, "6.0") >= 0;
}

/**
 * 🔴 平台**自己生成**的同步作业在 Glue ≥ 6.0 上要钉的 Spark 配置(--conf),目的 = 读源库时的类型与 5.1 时期**逐字相同**、
 *   脚本里「解析失败回 NULL 再由平台判空报错」的既有语义不变。源库版本不随平台升级(用户 2026-10-26),所以**同一张源表**
 *   在 5.1 与 6.0 下读出来的 Spark 类型必须一致,否则增量追加会撞已建好的目标表类型。事实来源 Spark 4.1.1 SQL 迁移指南
 *   (spark.apache.org/docs/4.1.1/sql-migration-guide.html,2026-10-26 读):
 *   · ANSI 缺省开 ⇒ 非法 cast / 溢出抛异常而非回 NULL ⇒ 关掉,平台脚本的派生列判空(SYNC_DERIVED_NULL)等判据才成立;
 *   · MySQL BIT(n>1) 从 LongType 变 BinaryType ⇒ 开 legacy 开关保持 LongType;
 *   · MySQL TIMESTAMP(preferTimestampNTZ)/ PostgreSQL TIMESTAMP WITH TIME ZONE / Oracle TimestampType 写回 / SQL Server TINYINT 与
 *     DATETIMEOFFSET 的映射都有 legacy 开关 ⇒ 全部开(平台只读源不写源,写侧开关无害但同样钉住);
 *   · 没有开关的三处(MySQL SMALLINT → ShortType、MEDIUMINT UNSIGNED → IntegerType、FLOAT → FloatType):
 *     ShortType 平台本来就宽化成 int(与 5.1 的 IntegerType 相同);FLOAT 由生成器在 MySQL 源 + Glue ≥ 6.0 时 cast 回 double;
 *     MEDIUMINT UNSIGNED 从 bigint 变 int 无损、只影响新建表的列类型,存量任务不换版本就不会碰到。
 *   只给**同步**作业注入(平台生成的脚本);用户自写的离线作业不动 —— 版本是用户选的,ANSI 语义由配方 / 提示词说明。
 */
export const GLUE_SYNC_SPARK4_COMPAT_CONF: readonly string[] = [
  "spark.sql.ansi.enabled=false",
  "spark.sql.legacy.mysql.bitArrayMapping.enabled=true",
  "spark.sql.legacy.mysql.timestampNTZMapping.enabled=true",
  "spark.sql.legacy.postgres.datetimeMapping.enabled=true",
  "spark.sql.legacy.oracle.timestampMapping.enabled=true",
  "spark.sql.legacy.mssqlserver.numericMapping.enabled=true",
  "spark.sql.legacy.mssqlserver.datetimeoffsetMapping.enabled=true",
];
/** 该版本的同步作业要追加的 --conf 项(< 6.0 为空数组,作业定义逐字节不变)。 */
export function syncCompatSparkConf(v: string): readonly string[] {
  return glueVersionNeedsSpark4Compat(v) ? GLUE_SYNC_SPARK4_COMPAT_CONF : [];
}

/** 该版本能否写 S3 Tables(≥ 最低版本;解析不出来 ⇒ 视为不支持)。 */
export function glueVersionSupportsS3Tables(v: string): boolean {
  const [a, b] = parts(v);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return compareGlueVersions(v, S3_TABLES_MIN_GLUE_VERSION) >= 0;
}

/** 用户看得懂的拒绝原因(页面原样展示)。 */
export function syncGlueVersionRejection(v: string): string {
  return (
    `Glue 版本 ${v} 不能写 S3 Tables:写湖表走的 Glue 联邦目录(s3tablescatalog)只在 Glue ${S3_TABLES_MIN_GLUE_VERSION} 及以上可用,` +
    `5.0 及更早版本会在运行时报「Invalid S3 URI … arn:aws:s3tables」失败。请把 Glue 版本改成 ${S3_TABLES_MIN_GLUE_VERSION} 或更高(缺省 ${GLUE_VERSION_DEFAULT})`
  );
}

/** 该任务是否会由 Glue 作业写 S3 Tables(实时 / DMS / Zero-ETL 通道不是 Glue 作业,不在此校验)。 */
export function syncWritesS3TablesViaGlue(task: { targetType?: unknown; channel?: unknown; syncMode?: unknown }): boolean {
  if (task.syncMode === "realtime" || task.channel === "dms" || task.channel === "zero-etl") return false;
  return task.targetType === "s3-tables" || task.targetType === "both";
}

/**
 * 同步任务新建 / 保存的校验:返回第一条不合法的说明(中文,直接回给用户),全合法返回 null。
 * 不带 glueConfig.glueVersion 的任务恒返回 null(缺省版本本身合法且支持 S3 Tables)。
 */
export function validateSyncGlueVersion(task: { targetType?: unknown; channel?: unknown; syncMode?: unknown; glueConfig?: unknown }): string | null {
  const g = (task.glueConfig && typeof task.glueConfig === "object" ? task.glueConfig : {}) as { glueVersion?: unknown };
  if (g.glueVersion === undefined || g.glueVersion === null || g.glueVersion === "") return null;
  if (!isGlueVersion(g.glueVersion)) {
    return `Glue 版本不合法:${JSON.stringify(g.glueVersion)}(可选:${GLUE_VERSIONS.join(" / ")})`;
  }
  if (syncWritesS3TablesViaGlue(task) && !glueVersionSupportsS3Tables(g.glueVersion)) {
    return syncGlueVersionRejection(g.glueVersion);
  }
  return null;
}
