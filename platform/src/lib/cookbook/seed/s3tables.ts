// S3 Tables(托管 Iceberg)工程配方。用户明确要求沉淀"写 S3 table 的核心代码"。
// 基于平台验证过的范式(见记忆 [[emr-serverless-s3tables-recipe]] [[s3table-query-and-iam]]):
//  · 计算引擎(EMR/Glue Spark)写 S3 Tables 必须用 S3TablesCatalog + runtime jar + 挂 VPC(NAT),
//    【禁】用 GlueCatalog/glue.id 那套(那是普通 Glue 表,不是 S3 Tables 托管 Iceberg)。
//  · Athena 查 S3 Tables 用 s3tablescatalog 的三段式命名。
// 这些是平台踩坑验证过的核心代码,让规划大脑照抄,不再从零猜 Iceberg 配置。

import type { DialectRule, Recipe } from "../types";
// 原子覆盖的规则文本 / 反例判据唯一作者
import { noDropBeforeS3TablesWriteRule, S3TABLES_ATOMIC_OVERWRITE_HOWTO } from "./s3tables-overwrite-facts";

// S3 Tables 的"方言规则"更多是【配置约束】(用错 catalog 直接连不上/写不进)。
export const S3TABLES_DIALECT_RULES: DialectRule[] = [
  // 结果表先 drop 再建 / 写 = 非原子覆盖 ⇒ warn。
  //   挂在 s3tables 引擎下是为了让 codegen 对 Spark 目标额外注入的 s3tables 切片(requirements/codegen.ts)
  //   与 lookup_recipe engine=s3tables 都能看到它;运行前的检测走 emr / glue 两份实例。
  noDropBeforeS3TablesWriteRule("s3tables"),
  {
    id: "s3tables.use-s3tablescatalog",
    engine: "s3tables",
    title: "写 S3 Tables 必须用 S3TablesCatalog,禁 GlueCatalog",
    rule: "Spark 写 S3 Tables(托管 Iceberg)必须配 `org.apache.iceberg.aws.s3tables.S3TablesCatalog` + " +
      "warehouse=table-bucket ARN,并挂 s3tables runtime jar。【禁】用 GlueCatalog/`glue.id`(那是普通 Glue 表,不是 S3 Tables)。",
    severity: "error",
  },
  {
    id: "s3tables.needs-vpc-nat",
    engine: "s3tables",
    title: "EMR/Glue 写 S3 Tables 需挂 VPC + 出网(NAT)",
    rule: "EMR Serverless / Glue 访问 S3 Tables API 需在 VPC 内并能出网(NAT 或 VPC Endpoint)," +
      "否则 Connect timed out。EMR 作业 params 要给 subnetIds + securityGroupIds。",
    severity: "warn",
  },
];

export const S3TABLES_RECIPES: Recipe[] = [
  {
    id: "s3tables.spark-write",
    engine: "s3tables",
    capability: "s3table-write",
    title: "Spark 写 S3 Tables(EMR/Glue,S3TablesCatalog)",
    whenToUse: "用 EMR Serverless 或 Glue PySpark 把计算结果写入 S3 Tables(托管 Iceberg)时。",
    template: [
      "# PySpark 写 S3 Tables 核心代码(S3TablesCatalog,平台验证过的范式)",
      "from pyspark.sql import SparkSession",
      "",
      "TABLE_BUCKET_ARN = 'arn:aws:s3tables:<region>:<account>:bucket/<table-bucket-name>'",
      "spark = (SparkSession.builder",
      "  .config('spark.sql.catalog.s3t', 'org.apache.iceberg.spark.SparkCatalog')",
      "  .config('spark.sql.catalog.s3t.catalog-impl', 'org.apache.iceberg.aws.s3tables.S3TablesCatalog')",
      "  .config('spark.sql.catalog.s3t.warehouse', TABLE_BUCKET_ARN)",
      "  .config('spark.sql.extensions', 'org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions')",
      "  .getOrCreate())",
      "",
      "# 写入(namespace 即 S3 Tables 的 namespace;表不存在自动建)",
      "df = spark.sql('SELECT ... FROM ...')  # 你的计算逻辑",
      "# createOrReplace() = 原子的 REPLACE TABLE … AS SELECT:存在就整表替换、不存在就建;【不要先 drop 表】",
      "df.writeTo('s3t.<namespace>.<table>').using('iceberg').createOrReplace()",
    ].join("\n"),
    dialectNotes: [
      "catalog-impl 必须是 S3TablesCatalog;warehouse 是 table-bucket ARN,不是 s3:// 路径。",
      "EMR 作业须挂 s3tables runtime jar + VPC 出网(见方言规则)。",
      "namespace 不要硬编码 ecommerce/游戏,按实际业务命名。",
      "🔴 createOrReplace() 本身原子,不要先 drop 表(非原子覆盖,见 s3tables.no-drop-before-s3tables-write);要「0 行拒绝覆盖 / 写后对数 / 按分区覆盖」看 s3tables.atomic-overwrite。",
    ],
    tags: ["s3table", "iceberg", "数据湖", "lake", "spark", "emr", "glue", "write"],
  },
  {
    // 提炼自平台生产同步作业真跑验证过的 Iceberg 写入(lib/sync/glue-script-generator.ts),非凭记忆。
    id: "s3tables.iceberg-upsert-partition",
    engine: "s3tables",
    capability: "s3table-merge",
    title: "S3 Tables Iceberg 幂等写入(建表/分区/增量 DELETE+INSERT)",
    whenToUse: "往 S3 Tables(Iceberg)幂等写入:首次建表带分区,增量重跑不产生重复行时。",
    template: [
      "# 已配好 s3tablescatalog(见 s3table-write 配方);目标三段式 s3tablescatalog.<ns>.<table>",
      "s3t_table = f's3tablescatalog.{NS}.{TARGET}'",
      "df.createOrReplaceTempView('src_view')",
      "",
      "if spark.catalog.tableExists(s3t_table):",
      "    # 增量幂等(Iceberg format-version 2 支持行级 DELETE):先删本批区间再插,重跑不重复",
      "    if inc_where:  # 有水位:只删该区间",
      "        spark.sql(f'DELETE FROM {s3t_table} WHERE {inc_where}')",
      "    spark.sql(f'INSERT INTO {s3t_table} SELECT * FROM src_view')",
      "else:",
      "    # 首次建表:分区用 Iceberg 变换 days()/months();format-version=2 支持行级更新",
      "    spark.sql(f\"\"\"CREATE TABLE {s3t_table} USING iceberg",
      "        PARTITIONED BY (days(<time_col>))",
      "        TBLPROPERTIES ('format-version'='2', 'write.parquet.compression-codec'='zstd')",
      "        AS SELECT * FROM src_view\"\"\")",
    ].join("\n"),
    dialectNotes: [
      "分区用 Iceberg 变换:days(col)/months(col),不是 Hive 静态分区。",
      "必须 TBLPROPERTIES('format-version'='2') 才支持行级 DELETE(幂等增量的前提)。",
      "幂等增量 = 先 DELETE 本批区间再 INSERT(有水位删区间)。🔴 **全量覆盖不要用「DELETE 整表 + INSERT」**(两次提交,中途失败留下空表)—— 用 s3tables.atomic-overwrite 的 INSERT OVERWRITE(一次提交)。",
    ],
    tags: ["s3table", "iceberg", "merge", "upsert", "partition", "分区", "增量", "幂等", "format-version"],
    verifiedAt: "2026-07-18",
    engineVersion: "glue>=5.0",
  },
  {
    // 提炼自平台同步脚本生成器/ ⑤ 的真跑范式(lib/sync/glue-script-generator.ts:整表 = 静态 INSERT OVERWRITE 一次提交;
    // 按分区 = 动态分区覆盖一次提交;读到 0 行默认拒绝清空;写后 COUNT 对数不一致即失败),非凭记忆。
    // ⚠️ 逐句与生成器同源,但本模板**作为独立脚本**尚未在真环境单独跑过 ⇒ 刻意不标 verifiedAt(入库纪律:标了就得真跑过)。
    // 老配方(emr.spark-dynamodb-to-s3tables 2026-07-29 版)教「先 drop 表再 createOrReplace」—— 那是非原子覆盖,已撤;
    // 本配方是 AI 生成「全量 / 按分区覆盖 S3 Tables 结果表」时唯一该照抄的写法。
    id: "s3tables.atomic-overwrite",
    engine: "s3tables",
    capability: "s3table-overwrite",
    title: "S3 Tables(Iceberg)原子覆盖:整表 INSERT OVERWRITE / 按分区覆盖 + 0 行拒绝 + 写后对数 + 按列名对齐",
    whenToUse: "要把计算结果**整表覆盖**或**只替换本批涉及的分区**写进 S3 Tables(Iceberg)结果表,且重跑 / 补数必须幂等、失败不能留下空表或丢表时。",
    template: [
      "# 已配好 s3tablescatalog(平台自动注入);目标三段式 s3tablescatalog.<ns>.<table>",
      "from pyspark.sql import functions as F",
      "TARGET = 's3tablescatalog.<ns>.<table>'",
      "ALLOW_EMPTY_OVERWRITE = False      # 读到 0 行默认不覆盖:源被清空 / 权限不足都会读到 0 行,照样覆盖 = 把好数据换成空表",
      "PARTITION_KEYS = []                # 只替换本批分区时填分区列名,如 ['dt'];整表覆盖留空",
      "",
      "src_rows = df.count()",
      "if src_rows == 0 and not ALLOW_EMPTY_OVERWRITE:",
      "    raise Exception('REFUSED_EMPTY_SOURCE: 读到 0 行,拒绝覆盖目标表(一行未动);确认要清空再显式允许')",
      "",
      "if not spark.catalog.tableExists(TARGET):",
      "    # 首次:CREATE TABLE … USING iceberg … AS SELECT 一次提交(分区用 Iceberg 变换 days()/months(),format-version=2)",
      "    df.createOrReplaceTempView('src_view')",
      "    spark.sql(f\"\"\"CREATE TABLE {TARGET} USING iceberg",
      "        TBLPROPERTIES ('format-version'='2', 'write.parquet.compression-codec'='zstd')",
      "        AS SELECT * FROM src_view\"\"\")",
      "else:",
      "    # 写进已有表:按【目标表的列名】对齐(缺列当场报错),不要按位置 SELECT *",
      "    cols = spark.table(TARGET).columns",
      "    aligned = df.select(*[F.col(c) for c in cols])",
      "    aligned.createOrReplaceTempView('src_view')",
      "    if PARTITION_KEYS:",
      "        # 按分区覆盖 = 动态分区覆盖,一次提交只替换本批数据涉及的分区(目标表分区规格必须恰好是这些列)",
      "        spark.conf.set('spark.sql.sources.partitionOverwriteMode', 'dynamic')",
      "        try:",
      "            spark.sql(f'INSERT OVERWRITE {TARGET} SELECT ' + ', '.join(cols) + ' FROM src_view')",
      "        finally:",
      "            spark.conf.set('spark.sql.sources.partitionOverwriteMode', 'static')",
      "        # 等价写法:aligned.writeTo(TARGET).overwritePartitions()",
      "    else:",
      "        # 整表覆盖 = 静态模式 INSERT OVERWRITE(不带 PARTITION 子句 ⇒ 替换整张表),一次提交;",
      "        # 等价写法:aligned.writeTo(TARGET).overwrite(F.lit(True))。【不要先 drop 表再建】—— 那是非原子覆盖。",
      "        spark.conf.set('spark.sql.sources.partitionOverwriteMode', 'static')",
      "        spark.sql(f'INSERT OVERWRITE {TARGET} SELECT ' + ', '.join(cols) + ' FROM src_view')",
      "",
      "# 写后对数:目标(整表 / 本批涉及的分区)行数必须等于本次读到的行数,不一致即失败(别只打印)",
      "if PARTITION_KEYS:",
      "    on = ' AND '.join(f't.{k} <=> b.{k}' for k in PARTITION_KEYS)",
      "    keys = ', '.join(PARTITION_KEYS)",
      "    tgt_rows = spark.sql(f'SELECT COUNT(*) FROM {TARGET} t LEFT SEMI JOIN (SELECT DISTINCT {keys} FROM src_view) b ON {on}').collect()[0][0]",
      "else:",
      "    tgt_rows = spark.table(TARGET).count()",
      "print(f'VERIFY target={TARGET} source_rows={src_rows} target_rows={tgt_rows}')",
      "if tgt_rows != src_rows:",
      "    raise Exception(f'VERIFY_MISMATCH target={TARGET}: 写入后 {tgt_rows} 行,本次读到 {src_rows} 行')",
    ].join("\n"),
    dialectNotes: [
      "🔴 " + S3TABLES_ATOMIC_OVERWRITE_HOWTO,
      "🔴 「DELETE 整表 + INSERT」「先 drop 表 + createOrReplace / CTAS」都是两次提交的非原子覆盖:中途失败留下空表或没表,下游全红。",
      "按分区覆盖的前提:目标表的分区规格恰好是这些分区列(按原值);无分区表会被整表替换、规格更细会留下旧行。",
      "`writeTo(...).overwrite(F.lit(True))` / `.overwritePartitions()` 与 INSERT OVERWRITE 静态 / 动态模式等价,都是一次提交。",
    ],
    tags: ["s3table", "iceberg", "overwrite", "覆盖", "全量覆盖", "按分区覆盖", "insert overwrite", "overwritePartitions", "原子", "幂等", "对数", "补数", "重跑"],
    engineVersion: "glue>=5.0",
  },
  {
    id: "s3tables.athena-query",
    engine: "s3tables",
    capability: "athena-query",
    title: "Athena 查 S3 Tables(三段式命名)",
    whenToUse: "用 Athena 查询 S3 Tables 里的数据时。",
    template: [
      "-- Athena 查 S3 Tables:catalog.namespace.table 三段式",
      "-- 需先在 Athena 关联 s3tablescatalog(数据源联邦),之后:",
      "SELECT * FROM \"s3tablescatalog/<table-bucket>\".\"<namespace>\".\"<table>\" LIMIT 100;",
    ].join("\n"),
    dialectNotes: ["Athena 需配 s3tablescatalog 联邦数据源;命名三段式,含引号。"],
    tags: ["s3table", "athena", "query", "iceberg", "查询"],
  },
];
