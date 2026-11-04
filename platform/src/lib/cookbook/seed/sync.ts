// 模块 44 — 数据同步工程配方(通道选型 + 目标矩阵)。
// 平台同步通道见记忆 [[sync-channel-target-matrix]]:各通道支持的目标不同,选错跑不通。

import type { DialectRule, Recipe } from "../types";

// 同步无独立"方言"(通道选型是决策矩阵,放进配方 dialectNotes;不污染引擎方言规则)。
export const SYNC_DIALECT_RULES: DialectRule[] = [];

export const SYNC_RECIPES: Recipe[] = [
  {
    id: "sync.channel-selection",
    engine: "glue", // 同步配方挂在 glue 引擎标签下(同步作业底层多为 Glue);查 lookup_recipe engine=glue 能看到
    capability: "sync-channel",
    title: "同步通道选型(全量/增量/实时 × 目标)",
    whenToUse: "规划'把源库数据同步到数仓/湖'时,选对通道和目标。",
    template: [
      "-- 同步通道选型指引(不是可执行代码,是决策矩阵):",
      "-- 全量/增量批同步 → sync-glue(Glue 批作业),目标可 redshift / s3-tables / both",
      "-- 近实时 CDC       → sync-dms(DMS),目标【仅】redshift",
      "-- 要落 S3 Tables 的实时 → Flink CDC(sinkType=s3table),见 lookup_recipe engine=flink",
      "-- 目标矩阵:DMS/ZeroETL 只到 Redshift;S3 Tables 靠 Glue/Flink。",
    ].join("\n"),
    dialectNotes: [
      "DMS 实时只能到 Redshift;要 S3 Tables 用 Glue 批或 Flink 流。",
      "targetType 合法值:s3-tables / redshift / both。",
    ],
    tags: ["sync", "同步", "dms", "cdc", "全量", "增量", "channel", "通道"],
  },
  {
    // 模块42 P42.1-P42.7:数据源 SPI 四范式的【连接方式】映射(建源填什么、凭证怎么给)。真跑通沉淀。
    id: "datasource.paradigm-connection",
    engine: "glue",
    capability: "datasource-connect",
    title: "数据源四范式连接方式(建源填什么 + 凭证形态)",
    whenToUse: "接一个新数据源、或判断某类源(MySQL/DynamoDB/S3/Kafka)建源该填哪些连接信息、用什么凭证时。",
    template: [
      "-- 数据源 SPI 四范式的连接方式(建源表单 connection 袋 + 凭证形态):",
      "-- ① JDBC 关系型(mysql/postgresql/oracle/sqlserver):",
      "--    连接={host,port,database};凭证=userpass(账密存 Secrets Manager,不入库);",
      "--    VPC 绑定(要子网/SG);建源自动建 Glue Connection。",
      "-- ② 流 stream(kinesis / msk):",
      "--    kinesis 连接={streamName,region};msk 连接={clusterArn 或 bootstrapServers, auth:iam|scram, region};",
      "--    凭证=iam-role(无密钥)或 sasl-scram(账密存 Secret);MSK 是 VPC 绑定,Kinesis 不是。",
      "-- ③ NoSQL(dynamodb):连接={tableName,region};凭证=iam-role(无密钥,用执行角色);非 VPC 绑定。",
      "-- ④ 对象存储(s3):连接={bucket,prefix,region,format:auto|csv|parquet|json,hasHeader};",
      "--    凭证=iam-role(无密钥);非 VPC 绑定。",
    ].join("\n"),
    dialectNotes: [
      "只有 JDBC 走 host/port/database + Glue Connection;stream/nosql/object-store 走各自连接袋、无 Glue Connection。",
      "iam-role 类源(kinesis/dynamodb/s3/msk-iam)不存密钥;账密类(JDBC/msk-scram)存 Secrets Manager,连接袋绝不落明文账密。",
      "🔴 IAM:平台读用户任意 DDB 表/S3 桶用独立 ManagedPolicy DataSourceReadOnly(全只读,region 条件);Glue 同步身份另授 DDB/S3 只读。",
    ],
    tags: ["datasource", "数据源", "连接", "connection", "jdbc", "dynamodb", "s3", "kinesis", "msk", "iam-role", "范式", "paradigm"],
    verifiedAt: "2026-07-29",
  },
  {
    // 模块42:四范式的【抓取/实现方式】(数据怎么从源拉出来 → 入湖仓 / 就地查)。你反复强调要沉淀的核心。
    id: "datasource.paradigm-ingestion",
    engine: "glue",
    capability: "datasource-ingest",
    title: "数据源四范式抓取/实现方式(怎么拉数 → 入仓/直查)",
    whenToUse: "判断某类源的数据怎么抓取入湖仓、或能否实时/只能离线批、或能否就地直查时。",
    template: [
      "-- 数据源四范式的抓取实现(每种源的数据面路径):",
      "-- ① JDBC:Glue 作业 spark.read.format('jdbc')(全量/增量批)或 DMS(CDC 实时到 Redshift)或 Zero-ETL(MySQL→Redshift 近实时)。",
      "-- ② DynamoDB(NoSQL):【只能离线批】Glue DynamoDB 连接器 create_dynamic_frame.from_options(",
      "--    connection_type='dynamodb', {'dynamodb.input.tableName':表, 'dynamodb.throughput.read.percent':'0.5'})",
      "--    → 🔴 dyf.resolveChoice(choice='cast:double') → toDF() → 入 Redshift/S3Tables。",
      "--    无 CDC(supportsCdc=false),整表 Scan。DDB 类型两坑:嵌套 Map/List → Spark struct/array 写 Redshift 兜底 VARCHAR;",
      "--    🔴 标量 Number 弱类型(同属性跨 item 可整可小数)→ Glue 推成 choice<long,double>,不 resolveChoice 直接 toDF 会带成",
      "--    struct<double,long>,写 Redshift 数值列时字符串化成 \"Row(double=..,long=..)\" → invalid input syntax。见 dialectNotes。",
      "-- ③ S3(对象存储):两条路 ——",
      "--    (a) 就地直查:Athena 外部表 CREATE EXTERNAL TABLE ... LOCATION s3://桶/前缀 STORED AS <format>,数据不搬,SELECT 直接读 S3;",
      "--    (b) 入仓:Glue 读 S3 文件批写湖仓。CSV 建表带 skip.header;parquet/json 各自 SerDe。",
      "-- ④ 流(kinesis/msk):【实时流】Flink SQL 作业消费 → S3/S3Tables/Redshift(见 lookup_recipe engine=flink)。",
    ].join("\n"),
    dialectNotes: [
      "🔴 范式决定能否实时:JDBC 有 CDC(DMS/binlog)、流天生实时;DynamoDB/S3【只能离线分批拉】(supportsCdc=false),无流式。",
      "S3 独有'就地直查'(Athena 外部表,数据不入仓);DynamoDB 一期只入仓不直查(federated 二期)。",
      "DynamoDB 走 Glue 强制用 DynamoDB 连接器(非 JDBC),无 secret;读容量用 throughput.read.percent 控制防打满源表。",
      "🔴 iam-role 类源(DDB/S3)无 secret:Glue 脚本【绝不能】生成 Secrets Manager 读取(SecretId='' → ParamValidationError)。S3 用 spark.read.csv/parquet/json 读 s3://bucket/prefix。",
      "🔴 标识符安全化:DDB表名/S3前缀允许连字符(bgp-orders),但 Redshift/S3Table 的表名+Spark临时视图名都是 SQL 标识符,含 - 会崩(syntax error / Invalid view name)。所有把源/目标名当标识符用的位置都要 sanitize(- → _),grep 全量核查。",
      "🔴 每条【源×目标】组合都要真跑:S3→Athena外部表直查通 ≠ S3→Glue入仓通(两条独立路径);小数据只写Redshift可能没触发S3Table路径。",
      "🔴 DDB Number 弱类型必须 resolveChoice(cast:double) 再 toDF()——否则 DDB→Redshift 必崩(S3Tables 侥幸过、Redshift 崩)。" +
        "机理:DynamoDB Number 是弱类型,同一属性跨 item 可存整数也可存小数(如 amount 时整时 73.5),Glue DynamoDB 连接器据此把该列推断成 " +
        "choice<long,double>。直接 dyf.toDF() 会把 choice 原样带成 Spark struct<double,long>——写 S3 Tables(Iceberg 容忍 struct)侥幸成功," +
        "但写 Redshift 数值列时该 struct 被字符串化成 \"Row(double=73.5, long=None)\" 塞进 INTEGER/DECIMAL 列 → COPY/INSERT 报 " +
        "'invalid input syntax for integer'。症状特征:同一次 both 同步,S3Tables 侧行数对、Redshift 侧 FAILED(据此可精确定位在 Redshift 写入路径)。" +
        "正解:toDF() 前 dyf = dyf.resolveChoice(choice='cast:double') 把所有 choice 列统一压平成 double(DDB Number 本就数值语义," +
        "整数在 double 内精确至 2^53,宽化无损);下游 df.schema 只剩标量数值,Redshift DDL/COPY 干净。" +
        "自定义 Glue 脚本写 DDB 源同理必加;平台自动生成的 Glue 脚本已内置(glue-script-generator.ts,commit 388730e)。",
      "真跑坐实(2026-07-29,100万压测):DDB 100万→Glue DDB连接器→S3Table 行数1000000/region各25万;S3 100万→spark.read→S3Table sum逐值对上;S3→Athena外部表直查 east=900/west=260/north=380 对上源CSV。造数脚本 qa-game/scripts/gen_{ddb,s3}_1m.py。",
      "真跑坐实(2026-08-26):DDB→both 同步先崩于 Number choice(Redshift 侧 invalid input syntax),补 resolveChoice(cast:double) 后 S3Tables 800行 + Redshift 800行双落。",
    ],
    tags: ["datasource", "数据源", "抓取", "ingestion", "离线", "批", "glue", "athena", "dynamodb", "s3", "flink", "cdc", "实时", "外部表", "标识符", "sanitize", "大数据", "100万", "resolveChoice", "choice", "number", "类型", "struct", "redshift"],
    verifiedAt: "2026-08-26",
  },
];
