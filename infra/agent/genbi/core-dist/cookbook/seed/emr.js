"use strict";
// EMR Serverless 工程配方 + 配置约束。
// 平台用 EMR Serverless 跑大规模 Spark(见记忆 [[emr-serverless-s3tables-recipe]] [[emr-user-extra-jars-gap]])。
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMR_RECIPES = exports.EMR_DIALECT_RULES = void 0;
const shared_rules_1 = require("./shared-rules");
const warehouse_facts_1 = require("./warehouse-facts");
// S3 Tables 结果表「先 drop 再建」= 非原子覆盖(唯一作者 seed/s3tables-overwrite-facts.ts)
const s3tables_overwrite_facts_1 = require("./s3tables-overwrite-facts");
exports.EMR_DIALECT_RULES = [
    {
        // 🔴🔴 2026-09-22 真环境第九层:IAM 全放行、区域也注入了,作业仍然
        //     Exception: SQL failed: ERROR: permission denied for database dev
        //   因为 `rs.execute_statement(WorkgroupName=..., Database=...)` **不带 `SecretArn`** 时,
        //   Data API 用调用者的 IAM 身份派生一个**临时数据库用户**,而那个用户在库里没有任何授权。
        //   平台自己所有 Redshift 调用的权威口径是 `SecretArn=<该区 admin 凭证>`
        //   (`lib/redshift/admin-secret.ts`:统一执行身份 ⇒ 表属主一致,任意路径建的表别的路径都能读改)。
        // 🔴 平台已把该区的 workgroup / database / secretArn 注入成 `spark.bgp.redshift*` conf
        //   ⇒ 生成代码直接读,不必猜、也不必硬编码某个区的工作组名(硬编码 = 多区执行时全打到一个区)。
        id: "emr.redshift-data-needs-secret-arn",
        engine: "emr",
        title: "redshift-data 调用必须带 SecretArn(否则 permission denied for database dev)",
        rule: "用 boto3 `redshift-data` 读写数仓时**必须**带 `SecretArn` —— 不带它,Data API 会用调用者 IAM 身份"
            + "派生一个临时数据库用户,那个用户在库里**没有授权**,报 `ERROR: permission denied for database dev`"
            + "(IAM 放行了 API ≠ 数据库内有授权,这是两层)。\n"
            + "正解:平台已把该区的连接事实注入 spark conf ⇒\n"
            + "  WG  = spark.conf.get('spark.bgp.redshiftWorkgroup')\n"
            + "  DB  = spark.conf.get('spark.bgp.redshiftDatabase')\n"
            + "  SEC = spark.conf.get('spark.bgp.redshiftSecretArn')\n"
            + "  rs.execute_statement(WorkgroupName=WG, Database=DB, SecretArn=SEC, Sql=sql)\n"
            + "🔴 别硬编码 workgroup/库名(多区执行时会全打到同一个区)。",
        antiPattern: /execute_statement\((?:(?!SecretArn)[\s\S]){0,400}?\)/,
        severity: "warn",
        target: "code",
    },
    {
        // 🔴🔴 2026-09-22 真环境失败(第八层):IAM 全部补齐、日志也推上去之后,用户那个 copilot
        //   生成的 ROI 作业仍然 ExitCode 1 ——
        //     botocore.exceptions.NoRegionError: You must specify a region.
        //   因为脚本写的是 `boto3.client('redshift-data')`(不带 region),而 **EMR Serverless 容器里
        //   没有 `AWS_REGION` / `AWS_DEFAULT_REGION`**。
        // 🔴 双管齐下(本仓纪律):平台侧已经在 spark-submit 里注入 driver/executor 的 AWS_REGION
        //   (`spec.ts` 的 `bgpLandingParameters`,手动提交与定时调度同一个作者)⇒ 新作业不必操心;
        //   本规则管的是**另一半**:用户手写 / planner 生成的代码里显式带上 region 更稳(也便于本地调试),
        //   而且它让「为什么会 NoRegionError」这件知识**留在配方库里**,不必再靠人记。
        // target=code ⇒ 只检测不改写(不误伤语义);severity=warn ⇒ 提示而不阻断
        //   (平台注入已经兜住了,拦下来反而会把好作业挡住 —— 判据不许比事实更严)。
        id: "emr.boto3-client-needs-region",
        engine: "emr",
        title: "EMR Serverless 里 boto3 client 建议显式带 region(容器内没有默认区域)",
        rule: "EMR Serverless 的 driver/executor 容器**没有** AWS_REGION / AWS_DEFAULT_REGION 环境变量,"
            + "`boto3.client('xxx')` 不带 region 会直接抛 `NoRegionError: You must specify a region`。"
            + "平台已在 spark-submit 里注入 `spark.emr-serverless.driverEnv.AWS_REGION` / `spark.executorEnv.AWS_REGION`,"
            + "所以**平台建的作业**已经能跑;但生成代码时仍建议写成 "
            + "`boto3.client('redshift-data', region_name=os.environ.get('AWS_REGION') or spark.conf.get('spark.bgp.region'))`"
            + " —— 落点区是平台注入的事实(`spark.bgp.region`),别写死某个区(写死 = 多区执行时全打到同一个区)。",
        antiPattern: /boto3\.client\(\s*['"][a-z0-9-]+['"]\s*\)/,
        severity: "warn",
        target: "code",
    },
    // 🔴 L1:禁止授权给 PUBLIC(唯一作者 = seed/shared-rules.ts,三引擎共用一份)。
    (0, shared_rules_1.noGrantToPublicRule)("emr"),
    // 数仓工作组写成字面量 ⇒ warn(唯一作者 seed/warehouse-facts.ts)
    (0, warehouse_facts_1.hardcodedWarehouseRule)("emr"),
    // S3 Tables 结果表先 drop 再 createOrReplace / 建表 ⇒ warn(唯一作者 seed/s3tables-overwrite-facts.ts)
    (0, s3tables_overwrite_facts_1.noDropBeforeS3TablesWriteRule)("emr"),
    {
        // 根治·裂缝B(error+antiPattern 纯检测):EMR PySpark【严禁】用 jdbc:redshift 连接串读写 Redshift 数仓。
        // 真实根因(2026-08-24 计划中心真跑坐实):规划大脑把"JDBC 读 MySQL 源库"配方误套到"读 Redshift 数仓",
        // 生成 spark.read.format('jdbc').option('url','jdbc:redshift://<cluster-endpoint>:5439') + <user>/<password>
        // 占位符 → 连接必失败。数仓正解:redshift-data API(boto3);读数据湖:spark.table("s3tablescatalog.ns.tbl")。
        // severity=error → 自动注入 planner 提示词(registry.ts:34,补上此前 glue/emr error 级=0 的硬约束);
        // 带 antiPattern → guard 运行前硬拦(provider.ts:81 if(g.blocked)throw)。target=code 只检测不改写(不误伤语义)。
        id: "emr.no-jdbc-redshift",
        engine: "emr",
        title: "EMR PySpark 严禁用 jdbc:redshift 连数仓(用 redshift-data API;读湖用 spark.table)",
        rule: "EMR Serverless 读写 Redshift 数仓【严禁】用 JDBC 连接串(jdbc:redshift://...):EMR 加不了用户 JDBC 驱动 jar" +
            "(见 emr.no-user-jdbc-jar),且连接串里的占位符必然连不上。" +
            "正解:①读/写 Redshift 数仓 → 用 boto3 redshift-data API(execute_statement)," + warehouse_facts_1.EMR_WAREHOUSE_HOWTO + ";作业角色已有权限;" +
            "②读/写数据湖 S3 Tables → spark.table(\"s3tablescatalog.<ns>.<表>\")(平台自动注入 catalog,SparkSession 无需自己配 warehouse ARN)。" +
            "JDBC 只用于【读 MySQL/PG 等源库】且须走 Glue(见 glue.jdbc-read-source),不用于数仓。",
        antiPattern: /jdbc:redshift:/i,
        severity: "error",
        target: "code",
    },
    {
        // 根治·裂缝B(完整版·占位符类):严禁在生成的代码里留【尖括号占位符】<your-xxx>——planner 拿不到平台
        // 环境字面值时会编 <your-redshift-serverless-workgroup>/<temp-bucket>/<redshift-iam-role-arn> 等,用户不填
        // 运行必报 ValidationException(2026-08-24 glue_dws_rootfix_ret 真跑坐实)。根治=①上面规则给足真实字面值
        // (本区数仓事实取平台注入值,见 seed/warehouse-facts.ts)让 planner 不必编占位符 ②本规则运行前硬拦残留的 <...> 占位符。
        // ⚠ 只匹配【字母起头的尖括号占位符】,天然放过 ${ds} 花括号占位符、SQL <>/<=/比较运算(agent+python实测)。
        id: "emr.no-unfilled-placeholder",
        engine: "emr",
        title: "严禁残留 <尖括号占位符>(用平台注入的本区事实:spark.bgp.redshiftWorkgroup/redshiftDatabase;S3 路径用 spark.bgp.datalakeBucket)",
        rule: "生成的 PySpark/boto3 代码里【严禁】留下形如 <your-redshift-serverless-workgroup>、<temp-bucket>、" +
            "<redshift-iam-role-arn>、<cluster-endpoint> 的尖括号占位符——用户不会填,运行必报错(ValidationException)。" +
            "用平台注入的本区事实:Redshift 工作组 / 库 / 凭证取 spark.bgp.redshiftWorkgroup / redshiftDatabase / redshiftSecretArn;" +
            "S3 临时/输出路径用 spark.bgp.datalakeBucket(不确定就用相对前缀,不要编占位符);S3 Tables 目录直接 " +
            "spark.table(\"s3tablescatalog.<ns>.<表>\")。业务日期从脚本入参读:平台在运行那一刻把 --ds <YYYY-MM-DD>、--ds_nodash、" +
            "--yesterday_ds、--bizdate、--bizmonth 等参数追加到 entryPointArguments 之后(与 Glue 作业同一套参数名)," +
            "脚本按参数名从 sys.argv 取;【不要】写 ${ds} 花括号占位符 —— 平台不替换 EMR 脚本文本,它会原样留在代码里。",
        antiPattern: /<[a-zA-Z][\w./-]*>/,
        severity: "error",
        target: "code",
    },
    {
        id: "emr.network-required-for-egress",
        engine: "emr",
        title: "出网作业必须配 VPC(subnet+SG);连不上按【网络→SG→IAM】分层查",
        rule: "EMR Serverless 访问 S3 Tables API / 源库 / 出网,必须在作业 params 给 subnetIds + securityGroupIds(私有子网+能出网)。" +
            "不配会 Connect timed out。纯 S3 读写(同区)可不配。\n" +
            "🔴 报连接超时/`Connect timed out`/`Unable to bootstrap`时按层隔离(与 flink/glue 的连通性诊断同源):" +
            "① 网络:私有子网要有 NAT 出网(访问 S3 Tables API 等区域端点)+ 目标可达;" +
            "② SG:EMR 的 securityGroupIds 必须【落在目标源 SG 放行的来源里】,源 SG 自引用(如 MSK)时 EMR 要用源同款 SG," +
            "RDS 类要放行对应端口(5432/1433/1521 等,不只 3306);" +
            "③ IAM:EMR 执行 role 要有目标资源权限(S3 Tables 要 s3tables:*;连 MSK IAM 要 kafka-cluster:* 族)。" +
            "先证网络层通(DNS/TCP/TLS)再查 SG/IAM,别把权限/SG 问题误判成网络。",
        severity: "warn",
    },
    {
        id: "emr.no-user-jdbc-jar",
        engine: "emr",
        title: "EMR 加不了用户 JDBC 驱动 jar",
        rule: "EMR Serverless 无法把用户 JDBC 驱动 jar 送到 driver classpath(spark.jars 到不了)→ 读 MySQL 报 ClassNotFound。" +
            "需读关系库时改走 Glue,或让数据先落 S3 Table 再用 EMR 读。",
        severity: "warn",
    },
    {
        // EMR Serverless 读 DynamoDB 的正道选择(真跑坐实前的决策依据,避免再走弯路)。
        id: "emr.dynamodb-read-via-boto3-scan",
        engine: "emr",
        title: "EMR 读 DynamoDB 用 boto3 并行分片 Scan,不用 GlueContext、不赌 emr-dynamodb jar",
        rule: "EMR Serverless 上读 DynamoDB【别用】Glue 的 glueContext.create_dynamic_frame(EMR 无 GlueContext)," +
            "也【别赌】emr-dynamodb-hadoop(DynamoDBInputFormat)jar——它是否随 EMR Serverless 镜像自带无官方明证,自行 stage 又要打 shade jar。" +
            "\n🔴 正道 = PySpark 内 boto3 并行分片 Scan:sc.parallelize(range(N), N).flatMap(scan_segment),每段在 executor 内建 client " +
            "用 Segment/TotalSegments 分页 Scan(不在 driver 单线程拉),boto3.dynamodb.types.TypeDeserializer 反序列化 DDB-JSON。" +
            "boto3 是 EMR 镜像标配,零 jar、零构建。执行角色需 dynamodb:Scan/DescribeTable(只读)。" +
            "\n🔴 类型:DDB N 型经 TypeDeserializer → Decimal,Spark createDataFrame 需原生类型,必须显式 int()/float() 转换,并声明显式 schema" +
            "(DDB 无表级 schema、属性稀疏,声明比推断稳)。写 S3 Tables 沿用平台自动注入的 s3tablescatalog(见 emr.spark-dynamodb-to-s3tables)。",
        severity: "warn",
    },
];
exports.EMR_RECIPES = [
    {
        // 提炼自 EMR Serverless 真跑踩坑:出网/连不上分层排查 + 加不了用户 JDBC jar 的绕行。配套方言 emr.network-required-for-egress / emr.no-user-jdbc-jar。
        id: "emr.connectivity-troubleshoot",
        engine: "emr",
        capability: "connectivity",
        title: "EMR 出网/连源连不上排查(网络→SG→IAM)+ 加不了JDBC驱动的绕行",
        whenToUse: "EMR Serverless 作业连不上 S3 Tables API/源库/超时(`Connect timed out`/`Unable to bootstrap`),或读关系库报 JDBC 驱动 ClassNotFound 时。",
        template: [
            "# 【EMR Serverless 连不上排查】",
            "# ① 网络:访问 S3 Tables API/源库/出网,作业 params 必须给 subnetIds+securityGroupIds(私有子网+NAT出网)。",
            "#    不配 → Connect timed out。纯S3同区读写可不配。私有子网要有 nat-* 到 0.0.0.0/0 才能访问区域端点。",
            "# ② SG:EMR 的 securityGroupIds 必须落在【目标源 SG 放行的来源】里。",
            "#    源SG自引用(MSK)→EMR用源同款SG;RDS类放行对应端口(5432/1433/1521,不只3306)。",
            "# ③ IAM:EMR 执行 role 要有目标权限(S3 Tables 要 s3tables:*;连MSK IAM 要 kafka-cluster:* 族)。",
            "#    先证网络层通(DNS/TCP/TLS)再查 SG/IAM,别把权限/SG误判成网络。",
            "",
            "# 🔴 EMR 加不了用户 JDBC 驱动 jar(spark.jars 到不了 driver classpath)→ 读 MySQL 报 ClassNotFound。",
            "#    绕行:需读关系库改走 Glue(能加驱动);或让数据先落 S3 Table,EMR 只读 S3 Table(不直连关系库)。",
            "",
            "# sparkSubmitParameters 挂 S3 Tables runtime jar 见 emr.spark-s3tables 配方;别用 GlueCatalog。",
        ].join("\n"),
        dialectNotes: [
            "出网作业必配 subnetIds+securityGroupIds(私有子网+NAT);连不上先证网络再查SG/IAM。",
            "EMR加不了用户JDBC jar → 读关系库走Glue,或先落S3Table再EMR读。",
            "连S3 Tables要s3tables:*权限;连MSK IAM要kafka-cluster:*。",
        ],
        tags: ["emr", "serverless", "连不上", "网络", "出网", "vpc", "sg", "权限", "iam", "jdbc", "驱动", "诊断", "排障", "s3tables"],
        verifiedAt: "2026-07-29",
        engineVersion: "emr-serverless",
    },
    {
        id: "emr.spark-s3tables-job",
        engine: "emr",
        capability: "spark-s3tables",
        title: "EMR Serverless Spark 读写 S3 Tables",
        whenToUse: "用 EMR Serverless 跑 Spark 做大规模计算,数据源/目标是 S3 Tables 时。",
        template: [
            "# EMR Serverless entryPoint(PySpark)。S3TablesCatalog 见 lookup_recipe engine=s3tables。",
            "# 提交时 sparkSubmitParameters 需带 s3tables runtime jar + iceberg 扩展;作业须挂 VPC 出网。",
            "from pyspark.sql import SparkSession",
            "spark = (SparkSession.builder",
            "  .config('spark.sql.catalog.s3t','org.apache.iceberg.spark.SparkCatalog')",
            "  .config('spark.sql.catalog.s3t.catalog-impl','org.apache.iceberg.aws.s3tables.S3TablesCatalog')",
            "  .config('spark.sql.catalog.s3t.warehouse','arn:aws:s3tables:<region>:<acct>:bucket/<table-bucket>')",
            "  .config('spark.sql.extensions','org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions')",
            "  .getOrCreate())",
            "spark.sql('SELECT ...').writeTo('s3t.<namespace>.<table>').using('iceberg').createOrReplace()",
        ].join("\n"),
        dialectNotes: [
            "作业 params 必须给 subnetIds + securityGroupIds(出网访问 S3 Tables API)。",
            "sparkSubmitParameters 挂 s3tables runtime jar;别用 GlueCatalog。",
        ],
        tags: ["emr", "serverless", "spark", "s3table", "iceberg", "大规模", "计算"],
    },
    {
        // EMR Serverless 读 DynamoDB(NoSQL 范式)→ 写 S3 Tables。Glue 之外的第二条 DDB 入湖通道。
        // 100万真跑坐实(账号412,2026-07-29):bgp-verify-ddb-1m 100万→S3Table 行数1000000/region各25万精确对账。
        // 配套方言 emr.dynamodb-read-via-boto3-scan(为何用 boto3 Scan 而非 GlueContext/emr-dynamodb jar)。
        id: "emr.spark-dynamodb-to-s3tables",
        engine: "emr",
        capability: "spark-dynamodb-ingest",
        title: "EMR Serverless 读 DynamoDB(boto3 并行分片 Scan)→ 写 S3 Tables",
        whenToUse: "用 EMR Serverless 把 DynamoDB 整表批量拉进 S3 Tables 数据湖(DDB 无 CDC/无 Flink 批 source,只能离线批;Glue 之外的 EMR 通道)。",
        template: [
            "# EMR Serverless entryPoint:DynamoDB 整表 → S3 Tables(Iceberg)。",
            "# S3Tables catalog(s3tablescatalog)由平台自动注入,脚本直接 writeTo;作业须挂带 NAT 私有子网出网。",
            "# 🔴 读 DDB 用 boto3 并行分片 Scan(EMR 无 GlueContext);执行角色需 dynamodb:Scan/DescribeTable。",
            "import boto3",
            "from boto3.dynamodb.types import TypeDeserializer",
            "from pyspark.sql import SparkSession",
            "from pyspark.sql.types import StructType, StructField, StringType, LongType, DoubleType, BooleanType",
            "",
            "DDB_TABLE = 'bgp-orders'          # 源 DDB 表名",
            "DDB_REGION = 'us-east-1'",
            "TOTAL_SEGMENTS = 32               # 并行分片数(= executor 核数量级;越大越并行,受 executor 数×核数约束)",
            "TARGET = 's3tablescatalog.<namespace>.<table>'   # 目标名含连字符要 sanitize(- → _)",
            "",
            "spark = SparkSession.builder.appName('emr-ddb-to-s3tables').getOrCreate()",
            "",
            "# 每个分片在 executor 内独立建 client 分页 Scan(不在 driver 单线程拉全表)。",
            "def scan_segment(seg):",
            "    cli = boto3.client('dynamodb', region_name=DDB_REGION)",
            "    des = TypeDeserializer()",
            "    ek = None",
            "    while True:",
            "        kw = dict(TableName=DDB_TABLE, Segment=seg, TotalSegments=TOTAL_SEGMENTS)",
            "        if ek: kw['ExclusiveStartKey'] = ek",
            "        resp = cli.scan(**kw)",
            "        for it in resp.get('Items', []):",
            "            d = {k: des.deserialize(v) for k, v in it.items()}",
            "            # 🔴 DDB N 型 → Decimal,Spark 需原生类型:显式转换 + 显式 schema(DDB 属性稀疏,声明比推断稳)。",
            "            yield (str(d.get('player_id','')), str(d.get('event_id','')),",
            "                   int(d.get('score') or 0), str(d.get('region','')),",
            "                   str(d.get('device','')), bool(d.get('is_vip', False)),",
            "                   float(d.get('amount') or 0.0))",
            "        ek = resp.get('LastEvaluatedKey')",
            "        if not ek: break",
            "",
            "schema = StructType([",
            "    StructField('player_id', StringType()), StructField('event_id', StringType()),",
            "    StructField('score', LongType()),       StructField('region', StringType()),",
            "    StructField('device', StringType()),     StructField('is_vip', BooleanType()),",
            "    StructField('amount', DoubleType())])",
            "",
            "rdd = spark.sparkContext.parallelize(range(TOTAL_SEGMENTS), TOTAL_SEGMENTS).flatMap(scan_segment)",
            "df = spark.createDataFrame(rdd, schema)",
            "",
            "# 🔴 S3TablesCatalog 的 CREATE TABLE 【不自动建 namespace】(namespace 不存在 → 404 NotFoundException)。",
            "# 建表前必须先建 namespace(Iceberg 标准语法,幂等)。Glue 通道亦同源——只是历史 namespace 已存在没暴露。",
            "spark.sql('CREATE NAMESPACE IF NOT EXISTS s3tablescatalog.<namespace>')",
            "# 🔴 createOrReplace() 本身就是原子的 REPLACE TABLE … AS SELECT(表存在就整表替换、不存在就建),",
            "#    【不要先 drop 表】:drop 到新表提交之间没有这张表,drop 成功而写入失败就把表弄丢(非原子覆盖)。",
            "# 🔴 读到 0 行默认不覆盖(源表被清空 / 扫描权限不足都会读到 0 行,照样覆盖 = 把好数据换成空表)。",
            "src_rows = df.count()",
            "if src_rows == 0:",
            "    raise Exception('REFUSED_EMPTY_SOURCE table=' + DDB_TABLE + ': 读到 0 行,拒绝覆盖目标表(一行未动)')",
            "df.writeTo(TARGET).using('iceberg').createOrReplace()",
            "# 写后对数:目标行数必须等于本次读到的行数,不一致即失败(别只打印)。",
            "tgt_rows = spark.table(TARGET).count()",
            "print('EMR_DDB_RESULT source_rows=' + str(src_rows) + ' target_rows=' + str(tgt_rows))",
            "if tgt_rows != src_rows:",
            "    raise Exception('VERIFY_MISMATCH table=' + TARGET + ': 写入后 ' + str(tgt_rows) + ' 行,本次读到 ' + str(src_rows) + ' 行')",
            "spark.stop()",
        ].join("\n"),
        dialectNotes: [
            "🔴 读 DDB 用 boto3 并行分片 Scan(Segment/TotalSegments),不用 GlueContext(EMR 无)、不赌 emr-dynamodb jar。见方言 emr.dynamodb-read-via-boto3-scan。",
            "🔴 createOrReplace() 本身原子(REPLACE TABLE … AS SELECT),【不要先 drop 表】——drop 之后写入失败就没表了(见方言 emr.no-drop-before-s3tables-write);读到 0 行默认拒绝覆盖;写后 count 对数不一致即失败。",
            "🔴 分片 Scan 在 executor 内做(sc.parallelize(range(N),N).flatMap),不能在 driver 单线程拉全表——否则 100万会 OOM/超时且无并行。",
            "🔴 DDB N 型经 TypeDeserializer → Decimal,createDataFrame 前必须 int()/float() 显式转;声明显式 schema(DDB 无表级 schema、属性稀疏)。",
            "🔴 S3TablesCatalog 的 CREATE TABLE 不自动建 namespace(不存在→404 NotFoundException,作业秒失败)。建表前必须 spark.sql('CREATE NAMESPACE IF NOT EXISTS s3tablescatalog.<ns>')(Iceberg 标准语法,幂等)。Glue 通道同源,只是历史 namespace 已存在没暴露——真跑新 namespace 才现形。",
            "S3Tables catalog 平台自动注入(s3tablescatalog),脚本直接 writeTo;作业须挂带 NAT 私有子网(catalog 运行时连 s3tables 区域 API)。",
            "执行角色需 dynamodb:Scan/DescribeTable(只读)+ s3tables:*;读容量靠 TotalSegments 并行度控制,PAY_PER_REQUEST 表无需担心预置吞吐。",
            "标识符安全:目标 namespace/表名含连字符要 sanitize(- → _),否则 Iceberg/SQL 建表崩(与 Glue 通道同源坑)。",
        ],
        tags: ["emr", "serverless", "spark", "dynamodb", "ddb", "nosql", "s3table", "iceberg", "boto3", "scan", "并行", "分片", "离线", "批", "大规模", "100万"],
        verifiedAt: "2026-07-29",
        engineVersion: "emr-serverless",
    },
    {
        // 根治·裂缝B 沉淀(2026-08-24 真跑坐实):计划中心生成的 EMR 读写 Redshift/数据湖代码反复失败,根因——
        //  ① jdbc:redshift 连接串(EMR 加不了 JDBC 驱动 jar,必失败);
        //  ② boto3 redshift-data 方向对却留 <your-workgroup>/<staging-bucket> 尖括号占位符 → 运行 ValidationException;
        //  ③ SparkSession 自己配 warehouse ARN 时编 <table-bucket-arn> 占位符(其实平台已自动注入 s3tablescatalog,无需配)。
        // 本配方给【正确姿势 + 三个错误反例】,让 AI 一看就懂(用户要求:配方要有例子和错误,全球用户默认自带)。
        id: "emr.redshift-and-lake-access",
        engine: "emr",
        capability: "redshift-access",
        title: "EMR 读写 Redshift 数仓/数据湖的正确姿势(平台真实值+自动注入catalog,严禁JDBC/占位符)",
        whenToUse: "EMR Serverless PySpark 作业需要读/写 Redshift 数仓,或读/写 S3 Tables 数据湖时。",
        template: [
            "# ============ 读/写 S3 Tables 数据湖:平台【自动注入】s3tablescatalog,直接用 ============",
            "from pyspark.sql import SparkSession",
            "spark = SparkSession.builder.appName('job').getOrCreate()   # ✓ 无需自己配 catalog/warehouse ARN",
            "df = spark.table('s3tablescatalog.realtime.orders')          # ✓ 直接读(平台已注入目录)",
            "df.writeTo('s3tablescatalog.dws.result').using('iceberg').createOrReplace()  # ✓ 幂等且原子(REPLACE TABLE AS SELECT),别先 drop 表",
            "",
            "# ============ 写 Redshift 数仓:boto3 redshift-data API + 平台真实值 ============",
            "import boto3, time",
            "import os",
            "# 🔴 落点区来自平台注入的事实(spark.bgp.region);EMR 容器里没有默认区域,不带 region 会 NoRegionError",
            "REGION = os.environ.get('AWS_REGION') or spark.conf.get('spark.bgp.region')",
            "rs = boto3.client('redshift-data', region_name=REGION)",
            "# 🔴 连接事实一律取**平台注入的 conf**(别硬编码:多区执行时硬编码会把所有区打到同一个区)",
            "# 🔴 **不给缺省值**:缺省值就是把主控区写死;取不到就让它当场报错,别静默连到别的区",
            "RS = dict(WorkgroupName=spark.conf.get('spark.bgp.redshiftWorkgroup'),",
            "          Database=spark.conf.get('spark.bgp.redshiftDatabase'),",
            "          SecretArn=spark.conf.get('spark.bgp.redshiftSecretArn'))   # 🔴 不带 SecretArn ⇒ permission denied",
            "def run_sql(sql):",
            "    sid = rs.execute_statement(Sql=sql, **RS)['Id']",
            "    while rs.describe_statement(Id=sid)['Status'] not in ('FINISHED','FAILED','ABORTED'): time.sleep(1)",
            "",
            "# ============ 【错误反例①】jdbc:redshift —— EMR 加不了 JDBC 驱动,必失败 ============",
            "# spark.read.format('jdbc').option('url','jdbc:redshift://<cluster-endpoint>:5439')  ✗ 改用 redshift-data API",
            "# ============ 【错误反例②】redshift-data 留占位符 —— ValidationException ============",
            "# rs.execute_statement(WorkgroupName='<your-redshift-serverless-workgroup>', ...)  ✗ 取 spark.bgp.redshiftWorkgroup",
            "# rs.execute_statement(WorkgroupName='some-workgroup', ...)  ✗ 字面量只对一个区成立,绑到别的区就错",
            "# ============ 【错误反例③】自己配 warehouse ARN 编占位符 —— 多此一举且必失败 ============",
            "# .config('spark.sql.catalog.s3t.warehouse','arn:aws:s3tables:<region>:<acct>:bucket/<table-bucket>')",
            "#   ✗ 平台已自动注入 s3tablescatalog,直接 spark.table('s3tablescatalog.ns.tbl') 即可,别自己配、别编占位符。",
        ].join("\n"),
        dialectNotes: [
            "🔴 读/写数据湖:直接 spark.table('s3tablescatalog.<ns>.<表>')——平台自动注入目录,【严禁】自己配 warehouse ARN 或编 <table-bucket-arn> 占位符。",
            "🔴 写回数据湖结果表:createOrReplace() / INSERT OVERWRITE 本身原子,【不要先 drop 表】(非原子覆盖,见 emr.no-drop-before-s3tables-write);整表 / 按分区覆盖 + 0 行拒绝 + 写后对数的完整范式见 lookup_recipe engine=s3tables(s3tables.atomic-overwrite)。",
            "🔴 读/写 Redshift 数仓:boto3 redshift-data API," + warehouse_facts_1.EMR_WAREHOUSE_HOWTO + "。",
            "🔴 EMR 加不了用户 JDBC 驱动 jar → 【严禁】jdbc:redshift 连接串(见 emr.no-jdbc-redshift)。",
            "🔴 业务日期从入参读(平台运行时追加 --ds / --ds_nodash / --yesterday_ds / --bizdate / --bizmonth 等,与 Glue 同一套;按参数名从 sys.argv 取),不要写 ${ds} 占位符(EMR 脚本文本不被替换);<...> 尖括号占位符全是错误,必须填真实值(见 emr.no-unfilled-placeholder)。",
            "🔴 redshift-data 调用必须带 SecretArn(取 spark.bgp.redshiftSecretArn)——不带它会 `permission denied for database dev`(IAM 放行 API ≠ 库内有授权)。",
            "🔴 boto3 client 建议显式带 region(EMR 容器里没有默认区域;平台已注入 AWS_REGION,但显式写更稳)——见 emr.boto3-client-needs-region。",
        ],
        tags: ["emr", "serverless", "redshift", "数仓", "数据湖", "s3tables", "redshift-data", "workgroup", "占位符", "placeholder", "jdbc", "ValidationException"],
        verifiedAt: "2026-08-24",
        engineVersion: "emr-serverless",
        // 🆕 2026-09-22:这个范式**要哪些权限**(扫描器 `role-advisor/script-scan.ts` 据此自动并入)。
        detect: [/boto3\.client\(\s*['"]redshift-data['"]/, /s3tablescatalog/],
        requiredPermissions: [
            {
                actions: [
                    "redshift-data:ExecuteStatement", "redshift-data:BatchExecuteStatement",
                    "redshift-data:DescribeStatement", "redshift-data:GetStatementResult", "redshift-serverless:GetCredentials",
                ],
                resources: ["*"],
                why: "本范式用 redshift-data API 写数仓;Data API 多为账号级动作,资源面只能是 *",
            },
            {
                actions: ["s3tables:GetTable", "s3tables:GetTableData", "s3tables:PutTableData", "s3tables:GetNamespace", "s3tables:ListTables", "s3tables:GetTableBucket"],
                resources: ["{tableBucket}", "{tableBucket}/*"],
                why: "本范式经 s3tablescatalog 读写 S3 Tables 表桶",
            },
            {
                actions: ["lakeformation:GetDataAccess"],
                resources: ["*"],
                why: "S3 Tables 的数据访问由 Lake Formation 联邦发凭证,少了它 spark.table 会被拒",
            },
        ],
    },
    {
        // ══════════════════════════════════════════════════════════════════════════
        // 🆕 2026-09-22 —— 用户在 copilot 建的 ROI 作业上撞到的那次事故的配方沉淀。
        //
        // 用户原话:「这种能力我认为需要加入到配方库里面,**不能我每次都需要手动处理这种错误**。」
        //          「**他需要知道这种任务需要添加哪些权限**,而不是报错了之后我通过你改源代码重新发布解决问题。」
        //
        // 【真实报错】作业一起步就:
        //   Unable to push logs … AccessDenied: s3:PutObject on
        //   "arn:aws:s3:::bgp-datalake-<账号>/emr-logs/<jobId>/applications/<app>/jobs/<run>/job-metadata.log"
        //   because no identity-based policy allows the s3:PutObject action
        // 【为什么会这样】EMR Serverless **用作业执行角色**把日志写到 `s3://<数据湖桶>/emr-logs/`。
        //   而「角色顾问一键创建」建出来的角色当时**一条 S3 语句都没有**(调用方没填 `s3Buckets`,
        //   顾问只塞了一句提示文字就照样把角色建出来了),CloudWatch 那条还写死指向 Glue 的日志组。
        // 【怎么不再犯】必备权限清单已收成**唯一真值源** `lib/role-advisor/engine-baseline.ts`,
        //   下面 `dialectNotes` 的清单**就是从那里派生的**(不是抄的)——所以它不会过期。
        // ══════════════════════════════════════════════════════════════════════════
        id: "emr.iam-required-permissions",
        engine: "emr",
        capability: "iam-permissions",
        title: "EMR Serverless 作业执行角色的**必备权限**(缺日志落点写权限 ⇒ 作业起步即 AccessDenied)",
        whenToUse: "创建 EMR Serverless 作业、或给它指定自定义执行角色时;作业报 AccessDenied / Unable to push logs 时。",
        template: [
            "# EMR Serverless 作业执行角色:必备权限清单(平台派生,勿手抄)",
            "# 🔴 只要你在作业规格里填了**自定义执行角色**,这几条就必须齐 —— 留空则用平台默认角色(本来就齐)。",
            "#",
            "# ① 日志落点(事故就出在这条):EMR 用**执行角色**写 job-metadata / driver / executor 日志",
            "#    s3:PutObject 等 → arn:aws:s3:::<数据湖桶>/emr-logs/*",
            "# ② 脚本桶只读:EMR 要拉 PySpark 入口脚本与平台注入的 runtime jar",
            "#    s3:GetObject 等 → arn:aws:s3:::<脚本桶>/*",
            "# ③ 数据湖读写:输入/中间/输出",
            "#    s3:GetObject/PutObject/Delete/分片上传三件套 → arn:aws:s3:::<数据湖桶>/*",
            "# ④ CloudWatch 日志组:**EMR 用 /aws/emr-serverless/*,不是 /aws-glue/***",
            "#    logs:CreateLogGroup/CreateLogStream/PutLogEvents",
            "# ⑤ VPC ENI:平台的 application 挂私有子网,少了它作业卡在启动",
            "#    ec2:CreateNetworkInterface / Describe* / DeleteNetworkInterface …",
            "#",
            "# 🔴 分片上传三件套(AbortMultipartUpload / ListBucketMultipartUploads / ListMultipartUploadParts)",
            "#    不能省:Spark 写大文件走 multipart,只给 PutObject 会在写大结果时失败。",
            "#",
            "# 【出路】平台里点「角色顾问 → 推荐执行角色权限 → 一键创建 / 补齐角色」即可:它会按本清单**对账补齐**已有角色",
            "#        (不是「存在就跳过」);也可以把执行角色留空用平台默认角色。",
        ].join("\n"),
        dialectNotes: [
            "🔴 EMR Serverless 的日志是**作业执行角色**写的,不是服务角色 ⇒ 执行角色必须能往 `emr-logs/` 前缀 PutObject。",
            "🔴 各引擎的 CloudWatch 日志组不同:EMR=`/aws/emr-serverless/*`、Glue=`/aws-glue/*`、Flink=`/aws/kinesis-analytics/*`。给错等于没给。",
            "🔴 只给 `s3:PutObject` 不够:Spark 写大文件走分片上传,还要 Abort/List 三件套。",
            "🔴 报错文本里**不会**提示「缺日志落点写权限」——它只说 PutObject 被拒。看到 `Unable to push logs` 先查这一条。",
            "🔴 一键创建会**对账补齐**已存在的同名角色(2026-09-22 起);在那之前它是「存在就跳过」,所以老角色修不好。",
        ],
        tags: ["emr", "serverless", "iam", "权限", "角色", "AccessDenied", "PutObject", "emr-logs", "job-metadata", "Unable to push logs", "执行角色", "日志"],
        verifiedAt: "2026-09-22",
        engineVersion: "emr-serverless",
        // 任何 EMR 脚本都适用 ⇒ 用一个必然命中的信号(PySpark/boto3 二者其一)。
        detect: [/import\s+boto3|from\s+pyspark|SparkSession/],
        requiredPermissions: [
            {
                actions: ["s3:PutObject", "s3:GetObject", "s3:ListBucket", "s3:AbortMultipartUpload", "s3:ListBucketMultipartUploads", "s3:ListMultipartUploadParts"],
                resources: ["arn:aws:s3:::{datalakeBucket}", "arn:aws:s3:::{datalakeBucket}/emr-logs/*"],
                why: "EMR Serverless 用作业执行角色把 job-metadata / driver / executor 日志写到 emr-logs/ 前缀",
            },
            {
                actions: ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket", "s3:GetBucketLocation"],
                resources: ["arn:aws:s3:::{scriptBucket}", "arn:aws:s3:::{scriptBucket}/*"],
                why: "拉 PySpark 入口脚本与平台注入的 runtime jar",
            },
        ],
    },
];
