"use strict";
// 模块 44 — Glue PySpark 工程配方 + 方言/配置约束。
// 平台用 Glue 做批同步 / 离线计算;Glue 版本缺省取清单最高、用户可降版(序 53,用户 2026-10-26 拍板)。
Object.defineProperty(exports, "__esModule", { value: true });
exports.GLUE_RECIPES = exports.GLUE_DIALECT_RULES = exports.COOKBOOK_GLUE_DEFAULT_RUNTIME = exports.COOKBOOK_GLUE_VERSION_DEFAULT = exports.COOKBOOK_GLUE_VERSIONS = void 0;
const shared_rules_1 = require("./shared-rules");
const warehouse_facts_1 = require("./warehouse-facts");
// @kf-batch 37-recipes-atomic-overwrite —— S3 Tables 结果表「先 drop 再建」= 非原子覆盖(唯一作者 seed/s3tables-overwrite-facts.ts)
const s3tables_overwrite_facts_1 = require("./s3tables-overwrite-facts");
// 序 53 —— Glue 版本事实的 cookbook 内联副本。cookbook 是「零 @/ alias」的 core 包(随 genbi 容器 core-dist 分发),
//   不能 import @/lib/sync/glue-version;真源 = platform/src/lib/sync/glue-version.ts,
//   单测 lib/cookbook/__tests__/glue-version-drift.test.ts 钉两处逐字一致(真源加版本这里没跟即红)。
exports.COOKBOOK_GLUE_VERSIONS = ["4.0", "5.0", "5.1", "6.0"];
exports.COOKBOOK_GLUE_VERSION_DEFAULT = "6.0";
exports.COOKBOOK_GLUE_DEFAULT_RUNTIME = { spark: "4.1.1", python: "3.13", iceberg: "1.11.0" };
const GLUE_DEFAULT_LINE = `Glue ${exports.COOKBOOK_GLUE_VERSION_DEFAULT}(Spark ${exports.COOKBOOK_GLUE_DEFAULT_RUNTIME.spark} / Python ${exports.COOKBOOK_GLUE_DEFAULT_RUNTIME.python} / Iceberg ${exports.COOKBOOK_GLUE_DEFAULT_RUNTIME.iceberg})`;
exports.GLUE_DIALECT_RULES = [
    // 🔴 L1(52 P52.1):禁止授权给 PUBLIC(唯一作者 = seed/shared-rules.ts,三引擎共用一份)。
    (0, shared_rules_1.noGrantToPublicRule)("glue"),
    // @kf-batch 50-B27-codegen-place —— 数仓工作组写成字面量 ⇒ warn(唯一作者 seed/warehouse-facts.ts)
    (0, warehouse_facts_1.hardcodedWarehouseRule)("glue"),
    // @kf-batch 37-recipes-atomic-overwrite —— Glue PySpark 写 S3 Tables 结果表先 drop 再建 / 写 ⇒ warn。
    //   🔴 刻意不咬本文件 glue.redshift-warehouse-access 配方里经 redshift-data 发给**数仓**的 `DROP TABLE IF EXISTS public.x; CREATE TABLE public.x AS`
    //   (Redshift 没有 CREATE OR REPLACE TABLE,DROP+CTAS 包进 BEGIN/COMMIT 就是它的正解)—— 判据按表名前缀 / Spark 独有写法区分,见 facts 文件。
    (0, s3tables_overwrite_facts_1.noDropBeforeS3TablesWriteRule)("glue"),
    {
        // 根治·裂缝B(error+antiPattern 纯检测):Glue PySpark【严禁】用 jdbc:redshift 连接串读写 Redshift 数仓。
        // 真实根因(2026-08-24 计划中心真跑坐实):规划大脑把本文件 glue.jdbc-read-source 配方(教"JDBC 读 MySQL 源库",
        // 合理)误套到"读 Redshift 数仓",生成 jdbc:redshift://<cluster-endpoint>:5439 + <user>/<password> 占位符 → 连接必失败。
        // 数仓正解:redshift-data API(boto3)或先 UNLOAD 到 S3;读数据湖:spark.table("s3tablescatalog.ns.tbl")。
        // severity=error → 自动注入 planner 提示词(registry.ts:34,补上此前 glue error 级=0 的硬约束);
        // 带 antiPattern → guard 运行前硬拦(job-service.ts:235 if(g.blocked)throw)。target=code 只检测不改写。
        // 注意:jdbc:mysql/postgresql/oracle/sqlserver 等【源库】JDBC 不受限(那是 glue.jdbc-read-source 的正当用法)。
        id: "glue.no-jdbc-redshift",
        engine: "glue",
        title: "Glue PySpark 严禁用 jdbc:redshift 连数仓(用 redshift-data API;读湖用 spark.table)",
        rule: "Glue PySpark 读写 Redshift 数仓【严禁】用 JDBC 连接串(jdbc:redshift://...):连接串里的占位符必然连不上," +
            "且数仓不该用 Spark JDBC 直连。正解:" +
            "①读/写 Redshift 数仓 → boto3 redshift-data API(execute_statement)," + warehouse_facts_1.GLUE_WAREHOUSE_HOWTO + ";作业角色已有权限;或 UNLOAD/COPY 经 S3;" +
            "②读/写数据湖 S3 Tables → spark.table(\"s3tablescatalog.<ns>.<表>\")(平台自动注入 catalog)。" +
            "JDBC 仅用于【读 MySQL/PG/Oracle 等源库】(见 glue.jdbc-read-source),不用于 Redshift 数仓。",
        antiPattern: /jdbc:redshift:/i,
        severity: "error",
        target: "code",
    },
    {
        // 根治·裂缝B(完整版·占位符类):严禁生成的代码留【尖括号占位符】<your-xxx>——planner 拿不到平台环境字面值时
        // 会编 <your-redshift-serverless-workgroup>/<temp-bucket>/<redshift-iam-role-arn>,用户不填运行必报 ValidationException
        // (2026-08-24 glue_dws_rootfix_ret 真跑坐实)。根治=①上面规则给足真实字面值 ②本规则运行前硬拦残留占位符。
        // ⚠ 只匹配字母起头的尖括号占位符,天然放过 ${ds} 花括号、SQL <>/<=/比较运算(agent+python实测放过 ${ds}/{{key}}/x<5/a<b AND c>d)。
        id: "glue.no-unfilled-placeholder",
        engine: "glue",
        title: "严禁残留 <尖括号占位符>(用平台注入的本区事实:bgp_redshift_workgroup/bgp_redshift_database;S3 路径用 bgp_datalake_bucket)",
        rule: "生成的 PySpark/boto3 代码里【严禁】留下形如 <your-redshift-serverless-workgroup>、<temp-bucket>、" +
            "<redshift-iam-role-arn>、<cluster-endpoint> 的尖括号占位符——用户不会填,运行必报错(ValidationException)。" +
            "用平台注入的本区事实:Redshift 工作组 / 库 / 凭证取作业参数 bgp_redshift_workgroup / bgp_redshift_database / bgp_redshift_secret_arn;" +
            "S3 临时/输出路径用作业参数 bgp_datalake_bucket(不确定就用相对前缀,不要编占位符);S3 Tables 目录直接 " +
            "spark.table(\"s3tablescatalog.<ns>.<表>\")。业务日期从作业参数读:平台在运行那一刻把 --ds <YYYY-MM-DD>、--ds_nodash、" +
            "--yesterday_ds、--bizdate、--bizmonth 等传给 StartJobRun(与 EMR 作业同一套参数名),脚本用 getResolvedOptions(sys.argv, ['ds', …]) 取;" +
            "【不要】写 ${ds} 花括号占位符 —— 平台不替换 Glue 脚本文本,它会原样留在代码里。",
        antiPattern: /<[a-zA-Z][\w./-]*>/,
        severity: "error",
        target: "code",
    },
    {
        id: "glue.job-init-boilerplate",
        engine: "glue",
        title: "Glue Job 必备初始化样板",
        rule: "Glue PySpark 作业必须有 GlueContext + Job.init/commit 样板;读参用 getResolvedOptions。缺 commit 作业不算完成。",
        severity: "warn",
    },
    {
        id: "glue.version-policy",
        engine: "glue",
        title: "Glue 版本:缺省最高、可按需降版",
        rule: `平台缺省用 ${GLUE_DEFAULT_LINE};同步任务 / 离线作业可在表单里选 ${exports.COOKBOOK_GLUE_VERSIONS.join(" / ")} 任一版本降版(写 S3 Tables 至少 5.1)。` +
            "写代码按所选版本的 API,别用已废弃的 Glue 2/3 写法。Glue 6.0 = Spark 4:ANSI 模式缺省开(整数溢出 / 非法 cast 会报错而不是回 NULL,要显式 cast、不要依赖隐式字符串转数字)," +
            "只带 AWS SDK for Java v2,S3 只有 S3A(s3:// 路径照常可用),Scala 2.13;boto3 / pymysql 等 Python 侧不变。" +
            "🔴 建 Glue job 时【必须显式 GlueVersion】——create-job 不指定时 API 默认给 3.0(旧/差异行为),会踩坑。" +
            "本轮实证:pythonshell 默认 3.0 且对 --connections 的 VPC 附着行为与 glueetl 不同,连 VPC 源要用 glueetl + 显式版本。",
        severity: "warn",
    },
    {
        // 【纯说明·连通性/权限诊断,跨引擎共通】Glue job 连 VPC 内源(RDS/MSK/自建库)连不上的四层排查。
        // 🔴 真实来源(2026-07-28/29 真跑逼出):Glue 造数/发数到私有 VPC 内的 RDS、MSK 反复连不上,
        //    最终定案根因分【网络→SG→IAM→客户端库】四层,每层单独证真。与 flink.msk-connectivity-4layers 同源,
        //    此处聚焦 Glue 侧:Glue job 靠挂 NETWORK 类型 Connection 进 VPC,该 Connection 的 SG/子网决定连通性。
        id: "glue.vpc-source-connectivity",
        engine: "glue",
        title: "Glue连VPC源(RDS/MSK)连不上按【NETWORK连接→SG配对→IAM→驱动/库】四层查,SG必须与源同款",
        rule: "Glue job 读/写私有 VPC 内的数据源(RDS 各库 / MSK / 自建库)报连接超时/`Unable to bootstrap`/" +
            "`Communications link failure`时,按四层隔离,别只怀疑脚本:\n" +
            "① NETWORK 连接:Glue job 进 VPC 必须挂一个 ConnectionType=NETWORK 的 Glue Connection" +
            "(create-job `--connections Connections=<名>`);该 Connection 的 PhysicalConnectionRequirements 指定 " +
            "SubnetId+SecurityGroupIdList+AvailabilityZone,决定 Glue 弹出的 ENI 落在哪。子网↔AZ 必须【同一次 " +
            "describe-subnets 取】(否则报 `Availability Zone does not correspond to subnet`)。\n" +
            "② SG 配对(最常踩):Glue Connection 的 SG 必须【落在源 SG 放行的来源里】。若源 SG 是自引用" +
            "(MSK Serverless 常见)→ Glue Connection 必须【用与源完全相同的 SG】才通。🔴 例:MSK 集群 SG=" +
            "sg-045ef0ed27c69cbc5(自引用),给 Glue 连接配 default SG 连不上;改成 MSK 同款 SG 即通。" +
            "RDS 场景:PG/Oracle/SQLServer 建源后平台『浏览表』0 表,是 RDS SG 只放行了 3306,需补 " +
            "`aws ec2 authorize-security-group-ingress --group-id <SG> --protocol tcp --port {5432|1433|1521} --cidr <VPC CIDR>`。\n" +
            "③ IAM:job 的 role(bgp-glue-role)要有目标资源权限。连 MSK IAM 要 `kafka-cluster:Connect/WriteData/" +
            "ReadData/CreateTopic/DescribeTopic/DescribeGroup` + `kafka:GetBootstrapBrokers`。缺权限表象也是连不上/超时。\n" +
            "④ 驱动/客户端库:JDBC 源要对应 driver(MySQL=com.mysql.cj.jdbc.Driver);🔴 连 MSK IAM【必须官方 Java " +
            "aws-msk-iam-auth,不能用 kafka-python(OAUTHBEARER 对 MSK IAM 握手脆弱、实测连不上)】——" +
            "可在 Glue 里下 kafka CLI+jar 跑 Java producer(client.properties: security.protocol=SASL_SSL / " +
            "sasl.mechanism=AWS_MSK_IAM / IAMLoginModule / IAMClientCallbackHandler)。\n" +
            "🔴 隔离手法:先用 socket(DNS 解析→TCP 9098/端口→TLS)在同连接下证网络层是否通;三层全绿=网络无问题," +
            "别再动 SG/子网/NAT,转查 IAM(③)和客户端库(④)。生产与消费连通模型一致,发数通=消费通。",
        severity: "warn",
    },
];
exports.GLUE_RECIPES = [
    {
        // 提炼自 2026-07-29 真跑:Glue 造数/发数到 VPC 内 RDS/MSK 反复连不上,四层排查定案。配套方言 glue.vpc-source-connectivity。
        id: "glue.vpc-connectivity-troubleshoot",
        engine: "glue",
        capability: "vpc-connectivity",
        title: "Glue 连 VPC 源(RDS/MSK)连不上排查(NETWORK连接→SG配对→IAM→驱动/库)",
        whenToUse: "Glue job 读/写私有 VPC 内数据源(RDS各库/MSK/自建库)连不上、报连接超时/`Unable to bootstrap`/`Communications link failure`时,按四层隔离定位。",
        template: [
            "# 【Glue 连 VPC 源连不上四层排查】每层单独证真,别只怀疑脚本:",
            "",
            "# ① NETWORK 连接:Glue job 进 VPC 必须挂 ConnectionType=NETWORK 的 Glue Connection",
            "#    create-job --connections Connections=<名>;该连接的 SubnetId+SecurityGroupIdList+AZ 决定 ENI 落点。",
            "#    🔴 子网↔AZ 必须同一次 describe-subnets 取(否则报 Availability Zone does not correspond to subnet)。",
            `#    🔴 create-job 必须显式 GlueVersion(平台缺省 ${exports.COOKBOOK_GLUE_VERSION_DEFAULT};API 不指定默认给 3.0);用 glueetl(非pythonshell,后者VPC附着行为不同)。`,
            "",
            "# ② SG 配对(最常踩):Glue Connection 的 SG 必须落在【源 SG 放行的来源】里。",
            "#    源 SG 自引用(MSK Serverless 常见)→ Glue Connection 必须用【与源完全相同的 SG】。",
            "#    例:MSK SG=sg-xxx(自引用),Glue连接配 default SG 连不上;改 sg-xxx 即通。",
            "#    RDS:PG/Oracle/SQLServer 浏览表0表 = SG只放行3306,需补:",
            "#      aws ec2 authorize-security-group-ingress --group-id <SG> --protocol tcp --port {5432|1433|1521} --cidr <VPC CIDR>",
            "",
            "# ③ IAM:job role(bgp-glue-role)要有目标权限。连MSK IAM 要 kafka-cluster:Connect/WriteData/ReadData/CreateTopic 等 + kafka:GetBootstrapBrokers。",
            "",
            "# ④ 驱动/客户端库:JDBC源要对应driver(MySQL=com.mysql.cj.jdbc.Driver);",
            "#    🔴 连MSK IAM 必须官方 Java aws-msk-iam-auth,不能 kafka-python(OAUTHBEARER 握手脆弱连不上)。",
            "#    Glue里可下 kafka CLI+jar 跑 Java producer(client.properties: SASL_SSL/AWS_MSK_IAM/IAMLoginModule/IAMClientCallbackHandler)。",
            "",
            "# 🔴 隔离手法:先用 socket(DNS→TCP→TLS)在同连接下证网络层;三层全绿=网络无问题,转查 ③④。生产与消费连通模型一致,发数通=消费通。",
        ].join("\n"),
        dialectNotes: [
            "Glue进VPC靠挂NETWORK连接;连不上先分层(网络socket证→SG源同款→IAM→驱动/库),别一上来猜网络。",
            "MSK Serverless SG自引用→Glue连接必须用MSK同款SG;RDS非MySQL源要放行对应端口(5432/1433/1521)。",
            `GlueVersion显式指定(平台缺省${exports.COOKBOOK_GLUE_VERSION_DEFAULT})+glueetl;连MSK IAM用Java aws-msk-iam-auth不用kafka-python。`,
        ],
        tags: ["glue", "vpc", "连不上", "网络", "安全组", "sg", "rds", "msk", "权限", "iam", "connection", "诊断", "排障"],
        verifiedAt: "2026-07-29",
        engineVersion: "glue>=5.0",
    },
    {
        id: "glue.pyspark-etl-skeleton",
        engine: "glue",
        capability: "etl-skeleton",
        title: "Glue PySpark ETL 作业骨架(读→转→写)",
        whenToUse: "用 Glue PySpark 做批量 ETL/聚合(读源→转换→写目标)时的标准骨架。",
        template: [
            "import sys",
            "from awsglue.transforms import *",
            "from awsglue.utils import getResolvedOptions",
            "from pyspark.context import SparkContext",
            "from awsglue.context import GlueContext",
            "from awsglue.job import Job",
            "",
            "args = getResolvedOptions(sys.argv, ['JOB_NAME'])",
            "sc = SparkContext()",
            "glueContext = GlueContext(sc)",
            "spark = glueContext.spark_session",
            "job = Job(glueContext); job.init(args['JOB_NAME'], args)",
            "",
            "# 读(按需换 from_catalog / from_options / spark.read)",
            "df = spark.read.format('jdbc').option('url', '<jdbc>').option('dbtable', '<table>').load()",
            "# 转换(你的聚合/JOIN 逻辑)",
            "result = df  # ...",
            "# 写(目标:S3/Redshift/S3Tables —— S3Tables 见 lookup_recipe engine=s3tables)",
            "result.write.mode('overwrite').format('parquet').save('<s3-path>')",
            "",
            "job.commit()  # 必须 commit,否则作业不算完成",
        ].join("\n"),
        dialectNotes: [
            "必须 job.init + job.commit 样板。",
            "写 S3 Tables 不能用普通 parquet write,要用 S3TablesCatalog(查 lookup_recipe engine=s3tables)。",
        ],
        tags: ["glue", "pyspark", "etl", "batch", "聚合", "skeleton"],
    },
    // ── 以下 3 条为模块45 P45.2 高频配方,提炼自平台【生产同步作业真跑验证过】的黄金脚本
    //    (lib/sync/glue-script-generator.ts,含真实踩坑根治),非凭大模型记忆。──
    {
        id: "glue.jdbc-read-source",
        engine: "glue",
        capability: "jdbc-read",
        title: "JDBC 读源库 → 写 S3/数仓(含窄整型规避 Spectrum Scan Error)",
        whenToUse: "用 Glue PySpark 从 MySQL/PostgreSQL 等 JDBC 源库读表,清洗后写 S3 parquet 或 Redshift 数仓时。",
        template: [
            "# JDBC 读源(MySQL 示例;驱动 com.mysql.cj.jdbc.Driver)",
            "df = spark.read.format('jdbc').options(",
            "    url='jdbc:mysql://<host>:<port>/<db>', dbtable='<table>',",
            "    user=db_user, password=db_pass, driver='com.mysql.cj.jdbc.Driver',",
            ").load()",
            "",
            "# 【关键踩坑根治】窄整型规避 Redshift COPY 的 Spectrum Scan Error 15007:",
            "# MySQL TINYINT/SMALLINT → Spark ByteType/ShortType → Parquet 带 INT(8/16) 逻辑标注,",
            "# Redshift COPY FORMAT AS PARQUET 会拒绝该标注。写前统一 cast 成 int(无损加宽)。",
            "from pyspark.sql.types import ByteType, ShortType",
            "from pyspark.sql import functions as F",
            "for f in df.schema.fields:",
            "    if isinstance(f.dataType, (ByteType, ShortType)):",
            "        df = df.withColumn(f.name, F.col(f.name).cast('int'))",
            "",
            "# 写 S3 parquet(或转 S3 Tables 见 lookup_recipe engine=s3tables;写 Redshift 用 redshift-data API)",
            "df.write.mode('overwrite').format('parquet').save('<s3-path>')",
        ].join("\n"),
        dialectNotes: [
            "MySQL 驱动 com.mysql.cj.jdbc.Driver(Glue 5.1 / 6.0 都自带 MySQL Connector/J 8.0.33,见 [[emr-user-extra-jars-gap]] EMR 的对照坑)。",
            "写 Redshift 前把 ByteType/ShortType cast('int'),否则 COPY 报 Spectrum Scan Error 15007 退化慢 INSERT。",
            "EMR 无法加用户 JDBC 驱动 jar;读关系库走 Glue 而非 EMR。",
        ],
        tags: ["glue", "jdbc", "mysql", "读源", "source", "spectrum", "tinyint", "parquet"],
        verifiedAt: "2026-07-18",
        engineVersion: "glue>=5.0",
    },
    {
        id: "glue.incremental-watermark",
        engine: "glue",
        capability: "incremental",
        title: "增量抽取(时间戳/自增ID 水位)",
        whenToUse: "只抽源表新增/变更行(按时间戳或自增主键水位),避免每次全表扫描时。",
        template: [
            "# 增量:只读 水位列 > 上次水位 的行(下推到 JDBC 子查询,不全表拉回再过滤)",
            "INC_COL = '<inc_col>'   # 如 updated_at 或自增 id",
            "last_wm = args.get('last_watermark')  # 平台注入的上次水位;首次为空=全量",
            "read_table = '<table>'",
            "if last_wm:",
            "    read_table = f'(SELECT * FROM <table> WHERE {INC_COL} > {last_wm!r}) AS incq'",
            "df = spark.read.format('jdbc').options(url=jdbc_url, dbtable=read_table, user=db_user, password=db_pass, driver='com.mysql.cj.jdbc.Driver').load()",
            "",
            "# 【必做】输出本批最大水位,供平台回写,下次只读更新行(否则每次重读同区间→append 重复)",
            "from pyspark.sql import functions as F",
            "if df.count() > 0:",
            "    mx = df.agg(F.max(INC_COL)).collect()[0][0]",
            "    print(f'INC_WATERMARK col={INC_COL} max={mx}')  # 平台解析此行回写水位",
            "",
            "# 增量写用 append(非 overwrite);幂等去重见 lookup_recipe redshift upsert / s3tables merge",
            "df.write.mode('append').format('parquet').save('<s3-path>')",
        ].join("\n"),
        dialectNotes: [
            "水位谓词下推到 JDBC 子查询(在源库过滤),不是拉全量到 Spark 再 filter。",
            "必须输出本批最大水位供回写,否则重复 append(增量同步重复的根因,见 [[sync-incremental-idempotent]])。",
            "增量用 append 模式;需幂等则配去重/UPSERT(先删后写)。",
        ],
        tags: ["glue", "incremental", "增量", "水位", "watermark", "bookmark", "cdc", "append"],
        verifiedAt: "2026-07-18",
        engineVersion: "glue>=5.0",
    },
    {
        id: "glue.data-quality-check",
        engine: "glue",
        capability: "data-quality",
        title: "数据质量校验(空值/重复/阈值 + 脏数据隔离)",
        whenToUse: "入仓前对数据做质量校验(空值率、主键重复、值域),不合格隔离或告警时。",
        template: [
            "from pyspark.sql import functions as F",
            "total = df.count()",
            "",
            "# 1) 主键空值 / 重复检查",
            "null_pk = df.filter(F.col('<pk>').isNull()).count()",
            "dup_pk  = df.groupBy('<pk>').count().filter(F.col('count') > 1).count()",
            "",
            "# 2) 值域 / 阈值检查(如金额非负)",
            "bad_range = df.filter(F.col('<amount>') < 0).count()",
            "",
            "print(f'DQ total={total} null_pk={null_pk} dup_pk={dup_pk} bad_range={bad_range}')",
            "",
            "# 3) 脏数据隔离:合格写目标,不合格写隔离区(不静默丢弃)",
            "good = df.filter(F.col('<pk>').isNotNull() & (F.col('<amount>') >= 0))",
            "bad  = df.subtract(good)",
            "good.write.mode('overwrite').format('parquet').save('<target-path>')",
            "if bad.count() > 0:",
            "    bad.write.mode('overwrite').format('parquet').save('<quarantine-path>')",
            "",
            "# 4) 硬阈值可选:严重不合格则 raise 让作业失败(平台标记 failed,不带病入仓)",
            "if total > 0 and (null_pk + dup_pk) * 1.0 / total > 0.05:",
            "    raise Exception(f'DQ failed: bad ratio {(null_pk+dup_pk)/total:.2%} > 5%')",
        ].join("\n"),
        dialectNotes: [
            "脏数据隔离到 quarantine 区,不静默 drop(可追溯)。",
            "严重不合格用 raise 让作业 failed,避免脏数据静默入仓。",
            "比率计算 * 1.0 转浮点。",
        ],
        tags: ["glue", "data-quality", "质量", "校验", "空值", "重复", "隔离", "dq"],
        verifiedAt: "2026-07-18",
        engineVersion: "glue>=5.0",
    },
    {
        // 根治·裂缝B 沉淀(2026-08-24 真跑坐实):计划中心生成的 Glue 写回 Redshift 数仓代码反复失败,两类根因——
        //  ① 用 jdbc:redshift 连接串(EMR/Glue 都连不上,配方 glue.no-jdbc-redshift 已禁);
        //  ② 用 boto3 redshift-data(方向对!)却留 <your-workgroup>/<temp-bucket> 尖括号占位符,运行报 ValidationException。
        // 本配方给【正确姿势 + 两个错误反例】,让 AI 一看就懂对错(用户要求:配方要有例子和错误)。
        // 放数组末尾:避免 0 分并列稳定排序时挤占既有配方(如 jdbc-read-source)的检索位次。
        id: "glue.redshift-warehouse-access",
        engine: "glue",
        capability: "redshift-access",
        title: "Glue 写回 Redshift 数仓的正确姿势(redshift-data API + 平台真实值,严禁 JDBC/占位符)",
        whenToUse: "Glue PySpark 作业要把计算结果写回 Redshift 数仓表(execute_statement 建表/UPSERT)时(非读 MySQL 源)。",
        template: [
            "# ============ 【正确】用 boto3 redshift-data API + 平台注入的本区事实 ============",
            "import sys, boto3, time",
            "from awsglue.utils import getResolvedOptions",
            "# 🔴 本区实名由平台注入(多区执行时每个区不同);严禁写死工作组名、严禁编 <your-workgroup> 占位符",
            "args = getResolvedOptions(sys.argv, ['JOB_NAME', 'ds', 'bgp_region', 'bgp_redshift_workgroup', 'bgp_redshift_database', 'bgp_redshift_secret_arn'])",
            "rs = boto3.client('redshift-data', region_name=args['bgp_region'])",
            "RS = dict(WorkgroupName=args['bgp_redshift_workgroup'], Database=args['bgp_redshift_database'], SecretArn=args['bgp_redshift_secret_arn'])",
            "",
            "def run_sql(sql):",
            "    sid = rs.execute_statement(Sql=sql, **RS)['Id']",
            "    while True:                       # 轮询到终态(execute_statement 是异步的)",
            "        d = rs.describe_statement(Id=sid)",
            "        if d['Status'] in ('FINISHED','FAILED','ABORTED'):",
            "            if d['Status'] != 'FINISHED': raise Exception('Redshift SQL 失败: ' + d.get('Error',''))",
            "            return sid",
            "        time.sleep(1)",
            "",
            "ds = args['ds']   # 业务日期用 ${ds}(平台注入 --ds;这是【唯一】允许的占位符形态)",
            "# 幂等重建结果表:DROP+CTAS 包进事务(见 lookup_recipe engine=redshift ctas-oid-concurrency)",
            "run_sql(f'''BEGIN;",
            "DROP TABLE IF EXISTS public.dws_channel_roi;",
            "CREATE TABLE public.dws_channel_roi AS SELECT ... WHERE dt = '{ds}';",
            "COMMIT;''')",
            "# 🔴 建完表【不要】再授权:平台各读写路径用同一个数仓身份执行,查询页/GenBI 本来就看得到。",
            "",
            "# ============ 【错误反例①】JDBC 连接串 —— 必失败 ============",
            "# df = spark.read.format('jdbc').option('url','jdbc:redshift://<cluster-endpoint>:5439/dev')...",
            "#   ✗ EMR/Glue 未配 Redshift JDBC 驱动;<cluster-endpoint> 是占位符 → 连不上。改用上面 redshift-data API。",
            "",
            "# ============ 【错误反例②】redshift-data 方向对但留占位符 —— 必失败 ============",
            "# rs.execute_statement(WorkgroupName='<your-redshift-serverless-workgroup>', Database='<db>', ...)",
            "#   ✗ <your-redshift-serverless-workgroup> 用户不会填 → 运行报 ValidationException(workgroupName 不满足正则)。",
            "#   ✓ 正解:取平台注入的 args['bgp_redshift_workgroup'] / args['bgp_redshift_database'](见本配方顶部)。",
            "# ============ 【错误反例②b】把工作组写成字面量 —— 多区执行时打到别的区 ============",
            "# rs.execute_statement(WorkgroupName='some-workgroup', ...)",
            "#   ✗ 字面量只对一个区成立;作业绑到别的区跑,要么该区没有这个工作组,要么查的是错的库(B-27)。",
            "",
            "# ============ 【错误反例③】建完表再把它授权给 PUBLIC —— 会被平台硬拦 ============",
            "#   ✗ 建表后追加一条把该表授权给 PUBLIC 的语句(老配方曾这么教,已撤):",
            "#     那会让库内所有身份都能读写这张表 → 击穿项目空间隔离(模块 52),",
            "#     且规则 glue.no-grant-to-public 命中即 blocked,作业**跑不起来**。",
            "#   ✓ 正解:什么都不加。平台建表/写入/查询页/GenBI 用同一个数仓身份,建完表本来就看得到。",
        ].join("\n"),
        dialectNotes: [
            "🔴 写回 Redshift 数仓用 boto3 redshift-data API(execute_statement + 轮询 describe_statement),不用 Spark JDBC。",
            "🔴 " + warehouse_facts_1.GLUE_WAREHOUSE_HOWTO + "(用户不填占位符→ValidationException;写死→多区打到同一个区)。",
            "🔴 业务日期从作业参数读(平台运行时传 --ds / --ds_nodash / --yesterday_ds / --bizdate / --bizmonth 等,与 EMR 同一套;getResolvedOptions(sys.argv, ['ds', …])),不要写 ${ds} 占位符(Glue 脚本文本不被替换);其它一切 <...> 尖括号占位符都是错误,必须填真实值。",
            "🔴 建完结果表【不要】再授权给 PUBLIC(老配方教过,2026-09-03 L1 已撤):平台各路径统一身份,建完就看得到;授权给 PUBLIC 会让库内所有身份读写该表,击穿项目隔离,且被 glue.no-grant-to-public 硬拦。",
            "DROP+CTAS 幂等重建包进 BEGIN;...COMMIT; 事务(避免并发 OID 冲突,见 redshift.ctas-oid-concurrency)。",
        ],
        tags: ["redshift", "数仓", "redshift-data", "workgroup", "占位符", "placeholder", "ValidationException", "写回数仓", "多区", "bgp_redshift_workgroup"],
        verifiedAt: "2026-08-24",
        engineVersion: "glue>=5.0",
    },
];
