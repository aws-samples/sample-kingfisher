"use strict";
// 模块 45(P45.4)— Flink SQL 工程配方 + 方言规则。平台用 MSAF Flink 1.20 做实时/近实时流计算
// (见记忆 [[flink-cdc-mysql-s3table]] [[flink-sink-type-s3-vs-s3tables]] [[flink-sql-runner-comment-split-bug]])。
//
// 方言规则基于平台【真跑验证过的】样板(lib/realtime/flink-service.ts 的 defaultFlinkSql/mysqlSinkSql/s3TableSinkSql)
// 提炼,并在临时环境真提交 MSAF 作业验证过启动成败。Flink 1.20 关键方言:
//  · 窗口用 TVF: FROM TABLE(TUMBLE(TABLE src, DESCRIPTOR(ts), INTERVAL '1' MINUTE))(非老式 TUMBLE(ts,...))
//  · 窗口聚合必须 GROUP BY window_start, window_end
//  · 事件时间列必须 WATERMARK FOR ts AS ...
//  · 【注意】Flink SQL 反引号 `col` 是【合法】标识符引用(与 Redshift 相反),故【绝不加反引号规则】。
//
// 抽象:guard 对 flink 生效靠 error 级 + antiPattern 规则(flink 是 SQL 引擎,可正则 fix)。
Object.defineProperty(exports, "__esModule", { value: true });
exports.FLINK_RECIPES = exports.FLINK_DIALECT_RULES = void 0;
exports.FLINK_DIALECT_RULES = [
    // ── ① 启动硬约束:必须恰好一条 INSERT INTO ──
    {
        id: "flink.insert-required-to-run",
        engine: "flink",
        title: "启动需有 INSERT INTO(否则不跑数据)",
        rule: "Flink SQL 作业必须含 INSERT INTO(把 source 写进 sink);只有 CREATE TABLE 定义不会真正跑数据,启动校验不过。",
        // 整段 SQL 里完全没有 INSERT INTO → 命中(无 fix,阻断:不能替用户造 INSERT)。
        antiPattern: /^(?:(?!\bINSERT\s+INTO\b)[\s\S])*$/i,
        severity: "error",
    },
    {
        id: "flink.single-insert-into",
        engine: "flink",
        title: "只能有一条 INSERT INTO",
        rule: "MSAF Flink 作业(append-only sink 场景)每次只应有【一条】INSERT INTO;多条会导致 StatementSet 未预期行为或启动失败。" +
            "多目标请拆成多个作业。",
        // 出现 ≥2 个 INSERT INTO → 命中(无 fix,阻断:不能替用户决定删哪条)。
        antiPattern: /\bINSERT\s+INTO\b[\s\S]*?\bINSERT\s+INTO\b/i,
        severity: "error",
    },
    {
        id: "flink.keep-placeholders",
        engine: "flink",
        title: "占位符必须原样保留(勿写死真实值)",
        rule: "源/sink 的敏感值(stream.arn / url / password / 路径)必须用占位符 ${SOURCE_STREAM_ARN}/${REGION}/${OUTPUT_PATH}/${MYSQL_URL} 等," +
            "启动时由平台安全注入(不入库、不硬编码)。别把真实 ARN/连接串/密码写进 SQL。" +
            // @kf-batch 50-B26-lake-place —— B-26:S3 Tables sink 的表桶原来恒填主控区 ⇒ 别的区的作业把结果写进主控区表桶
            "🔴 S3 Tables sink 的 'warehouse' 必须保留 ${TABLE_BUCKET_ARN}(库名 ${S3TABLE_DB}):平台按**作业所在区**填该区表桶;" +
            "写死某个 arn:aws:s3tables:... = 不管作业建在哪个区,结果都写进那一个区的表桶。",
        // 纯引导文案(生成前注入):真实值都在单引号字符串里,guard 的 mask 词法保护会遮蔽字符串内容(防误伤),
        // 故【不用 antiPattern 检测】——靠 retrieve 生成前引导模型用占位符,而非生成后正则(避免与 mask 保护冲突)。
        severity: "warn",
    },
    // ── ② 窗口聚合方言 ──
    {
        id: "flink.window-group-by",
        engine: "flink",
        title: "窗口聚合必须 GROUP BY window_start, window_end",
        rule: "用窗口 TVF(TUMBLE/HOP/CUMULATE)聚合时,GROUP BY 必须含 window_start 与 window_end(否则 append-only sink 拒绝/结果错)。" +
            "SELECT 里引用 window_start 作为窗口时间。",
        // 用了窗口 TVF(TABLE(TUMBLE/HOP/CUMULATE...)) 但 GROUP BY 未同时含 window_start 和 window_end → 命中(无 fix,阻断)。
        antiPattern: /TABLE\s*\(\s*(?:TUMBLE|HOP|CUMULATE)\b(?![\s\S]*GROUP\s+BY[\s\S]*window_start[\s\S]*window_end)(?![\s\S]*GROUP\s+BY[\s\S]*window_end[\s\S]*window_start)/i,
        severity: "error",
    },
    {
        id: "flink.window-tvf-syntax",
        engine: "flink",
        title: "窗口用 TVF 新语法(Flink 1.20)",
        rule: "Flink 1.20 窗口用表值函数 TVF:FROM TABLE(TUMBLE(TABLE src, DESCRIPTOR(ts), INTERVAL '1' MINUTE));" +
            "【避免】老式分组窗口函数 TUMBLE(ts, INTERVAL...)(1.20 推荐 TVF,老式在部分场景已废弃)。",
        // 老式 TUMBLE(列, INTERVAL...)(TUMBLE 后直接跟非 TABLE 参数)→ 命中提示。TVF 形态 TABLE(TUMBLE(TABLE... 不命中。
        antiPattern: /\b(?:TUMBLE|HOP|CUMULATE)\s*\(\s*(?!TABLE\b)[A-Za-z_]/i,
        severity: "warn",
    },
    // ── ③ 时间/WATERMARK 方言 ──
    {
        id: "flink.watermark-for-eventtime",
        engine: "flink",
        title: "事件时间窗口需 WATERMARK 声明",
        rule: "用事件时间做窗口聚合时,源表 DDL 必须声明 WATERMARK FOR <ts列> AS <ts列> - INTERVAL 'N' SECOND(否则窗口不触发、无输出)。" +
            "ts 列类型用 TIMESTAMP(3)。用处理时间则声明 <col> AS PROCTIME()。",
        // 用了窗口 TVF 但整段 SQL 没有任何 WATERMARK 声明 → 命中提示(无 fix:不知道哪列是事件时间)。
        antiPattern: /TABLE\s*\(\s*(?:TUMBLE|HOP|CUMULATE)\b(?![\s\S]*\bWATERMARK\s+FOR\b)/i,
        severity: "warn",
    },
    // ── ④ connector/WITH 属性方言 ──
    {
        id: "flink.sink-type-explicit",
        engine: "flink",
        title: "sink 类型要明确(默认 s3 裸文件 ≠ S3 Tables)",
        rule: "Flink 作业 sink 默认是 s3 裸文件(connector=filesystem),【不是】S3 Tables。要写 S3 Tables 须用 iceberg catalog(见配方)。" +
            "别把作业详情页的结果卡当数据落地——验数据要去 Athena/Redshift 独立查。",
        severity: "warn",
    },
    {
        // 【安全·凭证守卫】MSK/Kafka 源(P42.6b)的连接+认证必须走占位符注入,别把 SASL 明文密码/bootstrap 写进 SQL。
        // 真实成因(2026-07-27 P42.6b 落地):MSK 源模板用裸占位符 ${KAFKA_AUTH_PROPS}(启动时 resolveMskSource
        // 展开 bootstrap+IAM/SCRAM 认证,SCRAM 账密从 Secrets Manager 取,不入库);${KAFKA_TOPIC} 由页面主 topic 注入。
        // 若用户手写 sasl.jaas.config 里塞明文 password="xxx" → 泄密 + 入库,违反密钥红线(与 keep-placeholders 同源)。
        id: "flink.msk-auth-placeholder",
        engine: "flink",
        title: "MSK/Kafka 源认证用 ${KAFKA_AUTH_PROPS} 占位符(勿写死 SASL 明文密码)",
        rule: "MSK/Kafka 源(connector=kafka)的连接与认证由平台注入:源表 WITH 里用裸占位符 ${KAFKA_AUTH_PROPS}" +
            "(启动时展开 properties.bootstrap.servers + security.protocol=SASL_SSL + IAM/SCRAM 认证块),topic 用 ${KAFKA_TOPIC}。" +
            "IAM 认证无密钥;SCRAM 账密从所选 MSK 数据源的 Secrets Manager 注入(不入库)。" +
            "🔴 绝不在 SQL 的 sasl.jaas.config 里写明文 password=\"...\"(泄密 + 入库)——那属于数据源级配置,由建源时存 secret。" +
            "network(VPC 子网/SG)在作业级选(broker 在私有 VPC 9098/9096)。",
        // 检测:sasl.jaas.config 里出现明文 password="..."(非占位符)→ 命中提示(无 fix:不替用户改认证结构)。
        //   占位符 ${KAFKA_AUTH_PROPS}/${...} 内不含裸 password= 字面量,故不误伤注入路径。
        antiPattern: /sasl\.jaas\.config[^\n]*password\s*=\s*["'][^"'$]/i,
        severity: "warn",
    },
    // ── ⑤ 运维诊断类(纯说明规则,无 antiPattern:非 SQL 写法问题,是运行期日志/时序解读)──
    {
        // 【纯说明·防误诊】MSAF 启动时 HadoopFSDelegationTokenProvider 恒打这条 INFO,是架构性噪音非故障。
        // 真实来源:2026-07-25 R3 验证,S3 Tables 实时作业启动日志出现此行,一度被误判为作业失败根因。
        id: "flink.hadoop-fs-info-noise",
        engine: "flink",
        title: "「Hadoop FS is not available」是无害 INFO 噪音(非故障,别据此判失败)",
        rule: "MSAF 上 Flink 启动恒打 INFO:`Hadoop FS is not available (not packaged with this application): " +
            "NoClassDefFoundError org/apache/hadoop/conf/Configuration`。这是 Flink 安全令牌模块" +
            "(HadoopFSDelegationTokenProvider)探测系统类路径无 Hadoop 后跳过发 token 的【正常 INFO】," +
            "与 S3 Tables 写入无关(S3 Tables catalog 在用户代码用 user-jar 里的 Hadoop);" +
            "MSK/Kafka→S3 裸文件也恒打此 INFO,S3 写入走 Flink 自带 S3 plugin(flink-s3-fs),不需裸 hadoop(P42.6b 实证)。" +
            "判断作业真失败要看:作业状态是否 FAILED/RESTARTING、fullRestarts 是否上涨、checkpoint 是否失败(如 412)," +
            "不要把这条 INFO 当故障根因。诊断时应忽略它。",
        severity: "warn",
    },
    {
        // 【纯说明·连通性诊断】MSK/Kafka 源(以及任何 VPC 内数据源:RDS/MSK/自建库)连不上的四层排查法。
        // 🔴 真实来源(2026-07-28/29 P42.6b 新账号 412 真跑逼出,反复踩坑后定案):往私有 VPC 内 MSK
        //    Serverless(9098/IAM)发/收数,报 `KafkaTimeoutError: Unable to bootstrap from [...:9098]`。
        //    我一度误判为网络问题反复折腾 EC2/Glue/SG,最后 socket 层探测(DNS/TCP/TLS 全通)才隔离出:
        //    网络根本没问题,真因是【客户端库】——kafka-python 的 OAUTHBEARER 对 MSK IAM 握手脆弱连不上,
        //    换官方 Java aws-msk-iam-auth 一次通(sent=6 consumed=6)。教训:连不上先【分层隔离】,别猜。
        id: "flink.msk-connectivity-4layers",
        engine: "flink",
        title: "MSK/VPC源连不上(Unable to bootstrap/Timeout)按【网络→SG→IAM→客户端库】四层隔离,别瞎猜网络",
        rule: "MSK/Kafka 或任何 VPC 内源(connector=kafka;同理 RDS/自建库)报连接超时/`Unable to bootstrap from [broker:9098]`/" +
            "`KafkaTimeoutError`时,按【四层从下往上隔离】,每层单独证真,不跳步不臆测:\n" +
            "① 网络层(DNS/TCP/TLS):从【与源同 VPC、能到源的客户端】(VPC 内 EC2 / 挂了 NETWORK 连接的 Glue job)做 socket 探测——" +
            "`socket.gethostbyname_ex(broker)` 解析出 VPC 内网 IP(如 10.0.x.x,MSK Serverless 走 VPC endpoint)→ " +
            "`socket.create_connection((broker,9098),15)` TCP 通 → `ssl.wrap_socket` TLS 握手通。三者全绿=网络无问题," +
            "别再动 SG/子网/NAT。例:本轮 netcheck 证 DNS→vpce IP、TCP OK、TLS OK(AES256/TLSv1.2),网络层排除。\n" +
            "② 安全组(SG)配对:客户端的 ENI 必须【落在源 SG 放行的来源里】。MSK Serverless 的 SG 常是【自引用全端口】" +
            "(只放行『同 SG 成员』),故客户端(EC2/Glue 连接)必须【用与 MSK 完全相同的 SG】才通——用别的 SG(哪怕同 VPC)不通。" +
            "🔴 例:MSK 集群 SG=sg-045ef0ed27c69cbc5(自引用),我起初给 Glue 连接配了 default SG→连不上;改成 MSK 同款 " +
            "sg-045ef0ed27c69cbc5 后通。RDS 同理:非 MySQL 源(PG/Oracle/SQLServer)建源后『浏览表』0 表,是 RDS SG " +
            "只放行了 3306,需补 `authorize-security-group-ingress --port {5432|1433|1521} --cidr <VPC CIDR>`。\n" +
            "③ IAM 权限:MSK IAM 认证要客户端 role 有 `kafka-cluster:Connect/DescribeCluster/WriteData/ReadData/" +
            "DescribeTopic/CreateTopic/DescribeGroup/AlterGroup`(Resource 到 `arn:aws:kafka:REGION:ACCT:*/<集群名>/*`)" +
            "+ `kafka:GetBootstrapBrokers`。缺权限也报连不上/超时(表象与网络不通几乎一样,故要靠①先排除网络)。\n" +
            "④ 客户端库(最隐蔽、最常背锅给网络):🔴【MSK IAM(SASL/AWS_MSK_IAM,端口9098)必须用官方 Java " +
            "`aws-msk-iam-auth`(2.2.0=Java8 兼容 MSAF Java11);kafka-python 的 OAUTHBEARER 即便配 " +
            "aws-msk-iam-sasl-signer-python 也握手脆弱、实测连不上】。Java client.properties 认证块:" +
            "`security.protocol=SASL_SSL` / `sasl.mechanism=AWS_MSK_IAM` / " +
            "`sasl.jaas.config=software.amazon.msk.auth.iam.IAMLoginModule required;` / " +
            "`sasl.client.callback.handler.class=software.amazon.msk.auth.iam.IAMClientCallbackHandler`。" +
            "平台消费端(Flink flink-sql-connector-kafka + aws-msk-iam-auth)天然走对;发测试数据也必须 Java kafka CLI。\n" +
            "🔴 关键洞察:【生产与消费的连通模型完全一致】(同端口9098/同SG配对/同IAM权限/同Java库),发数能通=消费必能通;" +
            "反之消费不通先按这四层查,别只怀疑消费端代码。诊断口诀:先 socket 分层证网络(别猜),SG 用源同款,IAM 补 kafka-cluster,库用 Java。",
        severity: "warn",
    },
    {
        // 【纯说明·根治指引】S3 Tables sink 首帧 checkpoint 报 S3 412 的成因与根治。
        // 🔴 真实根因(2026-07-25 CloudTrail 真机实证,修正早期误判):不是"Iceberg 命名缺熵"这个外部
        // 不可控事实,而是平台侧【冷启动】——TaskRole 缺 kinesisanalytics:ListApplicationSnapshots 致
        // AccessDenied 被静默吞 → 误判"无快照" → 恒发 SKIP_RESTORE → checkpointId 归 1 → 撞残留。
        // 早期误判"attemptNumber 递增会自愈/需给 manifest 用唯一子目录"均已被实测推翻,勿据此诊断。
        id: "flink.s3tables-checkpoint-412",
        engine: "flink",
        title: "S3 Tables sink 首帧 checkpoint 报 412 = 冷启动致 checkpointId 归 1 撞残留 manifest",
        rule: "报错 `S3Exception ... 412 Precondition Failed`(堆栈 IcebergFilesCommitter.snapshotState → " +
            "FlinkManifestUtil.writeCompletedFiles → S3OutputStream.completeUploads → putObject)。" +
            "机理:Flink delta manifest 文件名完全确定性(无 UUID:jobId-opUID-subTask-attempt-checkpointId-fileCount)," +
            "而 MSAF 对同一应用恒复用同一 JobID、opUID/subTask 也恒定,故【唯一变量是 checkpointId】;" +
            "一旦作业以 SKIP_RESTORE 冷启动,checkpointId 归 1,与上一轮运行残留的 checkpoint-1 manifest 逐字节同名," +
            "S3 Tables 服务端 write-once 拒绝覆盖 → 412。表首次创建时为空无残留,故【第二次及以后】启动才报。" +
            "🔴 排查第一步(别跳过):查 CloudTrail 看 StartApplication 实际发的 ApplicationRestoreType " +
            "是否为 RESTORE_FROM_LATEST_SNAPSHOT;若是 SKIP_RESTORE,再查同一时刻 ListApplicationSnapshots " +
            "是否 AccessDenied(平台 TaskRole 缺该权限会让快照探测静默失败、误判为无快照)。" +
            "根治:①TaskRole 补齐 kinesisanalytics 快照族权限(List/Describe/Create/DeleteApplicationSnapshot);" +
            "②有状态作业默认开快照(snapshotsEnabled=true);③启动恢复决策三态化——确认无快照才 SKIP," +
            "【探测失败(unknown)必须仍走 RESTORE】,绝不因探测失败退化成冷启动。" +
            "注意:失败会逐轮恶化(1→2→3 次)而非「抖一次自愈」——IcebergFilesCommitter 的 dataFilesPerCheckpoint " +
            "会遍历所有未提交 checkpointId 重写 manifest,失败集合只增不减。" +
            "残留 manifest 由 AWS S3 Tables 自动 unreferenced file removal(3 天)清理,平台不主动删(托管对象删除不可逆)。" +
            "commit.retry 不适用(只认 CommitFailedException、只包 SnapshotProducer.commit,够不着 snapshotState 的 S3 412)。",
        severity: "warn",
    },
    {
        // 【纯说明·部署诊断】MSK/Kafka 源作业启动即 error、lastError=`The specified key does not exist` 的根因。
        // 🔴 真实根因(2026-07-29 P42.6b 新账号 412 真机逼出,深挖两小时定案):MSK/Kafka 源【强制走模块化拼装】
        //    (assembleModularUberJar:两个胖包 flink-sql-runner{,-s3t}.jar 均未打 kafka connector,故 kafka 作业
        //    只能从 S3 `flink/modules/` 读 base + kafka + msk-iam-auth(+files/json)模块合并成 uber jar)。
        //    若 `flink/modules/` 为空(部署漏传模块 jar)→ s3GetBuffer 抛 NoSuchKey → CreateApplication 前就失败。
        //    此前被多重表象误导:①快照探测打 `Application does not exist`(设计内容错噪音,非根因);②CLI 手动建
        //    应用用默认 jar 能成功(误以为 code 没问题)——真相是 MSK 走的是【拼装 jar】不是默认 jar。
        id: "flink.msk-modular-jar-missing",
        engine: "flink",
        title: "MSK/Kafka 源作业启动即 error(key does not exist)= S3 flink/modules/ 缺模块 jar",
        rule: "MSK/Kafka 源(connector=kafka)Flink 作业【一点启动就 status=error】、lastError 含 " +
            "`The specified key does not exist`(或 NoSuchKey),且 AWS 侧根本没建出 MSAF 应用时:" +
            "🔴 根因是 S3 制品桶(FLINK_CODE_BUCKET,约定 bgp-glue-scripts-<account>)的 `flink/modules/` 前缀" +
            "【缺模块 jar】。机理:MSK/Kafka 源【强制模块化拼装】(不看全局开关)——两个胖包均未打 kafka connector," +
            "启动时 assembleModularUberJar 要从 flink/modules/ 读 `flink-module-base.jar` + 按 SQL 解析的模块" +
            "(kafka / msk-iam-auth / files / json;Kafka→S3Tables 还要 iceberg-s3tables)合并成 uber jar。" +
            "任一 jar 不存在 → s3GetBuffer 抛 NoSuchKey → 拼装失败 → CreateApplication 都没发出。" +
            "🔴 排查(别被表象带偏):①`aws s3 ls s3://<脚本桶>/flink/modules/` 看是否为空/缺 jar(第一步,最直接);" +
            "②日志里 `Application ... does not exist`+`InvalidArgumentException` 是【快照探测】对尚未建成的应用的" +
            "设计内容错噪音,不是根因,别顺着它查权限;③用 CLI 拿默认 jar 建应用能成功【不能证明 code 没问题】," +
            "因为 MSK 走的是拼装 jar 不是默认 jar。" +
            "根治:部署时把 `flink-connector-modules/*/target/flink-module-*.jar` 幂等上传到 `flink/modules/`" +
            "(deploy-all.sh §10.6(c);jar 是 mvn 产物且 .gitignore 排除 target/*.jar,git clone 不带,缺则 mvn 构建)。" +
            "手动急救:`aws s3 cp flink-connector-modules/<mod>/target/flink-module-<mod>.jar s3://<脚本桶>/flink/modules/`。",
        severity: "warn",
    },
    {
        // 【结构容错·自动纠正】最后一条语句分号后残留的孤立右括号/右方括号(纯空白+ ) ] 直到脚本结尾)。
        // 🔴 真实成因(2026-07-26 真机):页面 Monaco 编辑器【自动补全括号】,用户删改 SQL 时极易在末尾
        //    留下一个孤立 `)`(如 `...FROM t;\n)`)。runner 按 ';' 切分后,它成为独立语句片段 `)` →
        //    Calcite 解析报 `SqlParseException: Encountered ")" at line 1, column 1` → 作业启动即失败、
        //    反复重启(0 checkpoint)。这是编辑器产物,非用户本意,可安全机械去除。
        // 只吃【分号之后】的空白与 ) ] —— 语句已结束,这些单独出现必是残留;不吃字母/数字/引号/(,
        // 故绝不误伤"最后一条语句未写分号"的合法尾句(那种不以 ; 开头,不命中)。
        id: "flink.trailing-stray-bracket",
        engine: "flink",
        title: "去除末尾语句分号后的孤立残留括号(编辑器自动补全产物)",
        rule: "Flink SQL 最后一条语句以 ';' 结束后,不应再有游离的 ')'/']'(常见于页面编辑器自动补全括号后删改残留)。" +
            "这类碎片会被按 ';' 切成独立语句 ')' → Calcite 报 `Encountered \")\"` → 启动失败反复重启。" +
            "平台在校验期自动去除分号后的孤立括号/方括号(仅空白与 )] 构成的尾巴),不改变任何真实语句。",
        antiPattern: /;[\s)\]]*[)\]][\s)\]]*$/,
        fix: (seg) => seg.replace(/^(;)[\s\S]*$/, "$1"),
        severity: "error",
    },
];
exports.FLINK_RECIPES = [
    {
        // 提炼自 2026-07-29 P42.6b 新账号 412 真跑通(Java kafka CLI 发数 sent=6 consumed=6)+ 反复踩坑定案的
        // 【网络→SG→IAM→客户端库】四层排查法。配套 guard 方言 flink.msk-connectivity-4layers(校验)。
        id: "flink.msk-vpc-connectivity",
        engine: "flink",
        capability: "msk-connectivity",
        title: "MSK/VPC源连不上排查(网络→SG→IAM→客户端库四层隔离)",
        whenToUse: "MSK/Kafka 源(或任何 VPC 内源:RDS/自建库)连不上、报 `Unable to bootstrap from [broker:9098]`/`KafkaTimeoutError`/连接超时时,按此四层逐层隔离定位(别一上来就猜网络)。",
        template: [
            "-- 【MSK/VPC 源连不上四层排查法】报 `Unable to bootstrap from [...:9098]` / Timeout 时按序隔离,每层单独证真:",
            "",
            "-- ① 网络层(DNS/TCP/TLS)—— 从与源同 VPC 的客户端(VPC内EC2 / 挂NETWORK连接的Glue job)用 socket 探测:",
            "--    python: socket.gethostbyname_ex(broker) 解析出VPC内网IP(如10.0.x.x,MSK Serverless走vpce)",
            "--            socket.create_connection((broker,9098),15)  # TCP",
            "--            ssl.create_default_context().wrap_socket(...)  # TLS 握手",
            "--    三者全绿 = 网络无问题,别再动 SG/子网/NAT,转查 ②③④。",
            "",
            "-- ② 安全组(SG)配对 —— 客户端 ENI 必须落在【源 SG 放行的来源】里:",
            "--    MSK Serverless 的 SG 常是【自引用全端口】(只放行同SG成员)→ 客户端(EC2/Glue连接)必须用【与MSK完全相同的SG】。",
            "--    例:MSK SG=sg-xxx(自引用),Glue连接配 default SG 连不上;改用 sg-xxx 即通。",
            "--    RDS 类:非MySQL源浏览表0表 = SG只放行3306,需补: aws ec2 authorize-security-group-ingress --port {5432|1433|1521} --cidr <VPC CIDR>",
            "",
            "-- ③ IAM 权限 —— 客户端 role 要有 kafka-cluster:Connect/WriteData/ReadData/CreateTopic/DescribeTopic/DescribeGroup/AlterGroup",
            "--    (Resource arn:aws:kafka:REGION:ACCT:*/<集群名>/*) + kafka:GetBootstrapBrokers。缺权限表象也是连不上/超时。",
            "",
            "-- ④ 客户端库(最隐蔽)—— 🔴 MSK IAM(端口9098,AWS_MSK_IAM)必须用官方 Java aws-msk-iam-auth(2.2.0=Java8兼容MSAF Java11);",
            "--    kafka-python 的 OAUTHBEARER 即便配 aws-msk-iam-sasl-signer-python 也握手脆弱、实测连不上。",
            "--    Java client.properties 认证块:",
            "--      security.protocol=SASL_SSL",
            "--      sasl.mechanism=AWS_MSK_IAM",
            "--      sasl.jaas.config=software.amazon.msk.auth.iam.IAMLoginModule required;",
            "--      sasl.client.callback.handler.class=software.amazon.msk.auth.iam.IAMClientCallbackHandler",
            "",
            "-- 🔴 关键:生产与消费连通模型完全一致(同9098/SG/IAM/Java库)。发数能通=消费必通;消费不通先按这四层查,别只怀疑消费代码。",
        ].join("\n"),
        dialectNotes: [
            "四层顺序:网络(socket证DNS/TCP/TLS)→ SG(用源同款,自引用SG尤其)→ IAM(kafka-cluster:*)→ 客户端库(必须Java aws-msk-iam-auth,非kafka-python)。",
            "连不上先分层隔离,别一上来猜网络——网络三层常常是通的,真因多在SG配对错或客户端库选错。",
            "MSK发测试数据最优解:Glue 5.1(glueetl,非pythonshell)挂NETWORK连接(用MSK同款SG)跑Java kafka CLI,CloudWatch日志秒级确认。",
        ],
        tags: ["flink", "msk", "kafka", "连不上", "网络", "安全组", "sg", "权限", "iam", "bootstrap", "timeout", "连通性", "诊断", "vpc"],
        verifiedAt: "2026-07-29",
        engineVersion: "flink-1.20",
    },
    {
        // 提炼自 2026-07-29 P42.6b 新账号 412 真机(MSK→S3 端到端 11/11 打通前的根因排查)。配套方言 flink.msk-modular-jar-missing。
        id: "flink.msk-startup-error-modular-jar",
        engine: "flink",
        capability: "msk-startup-error",
        title: "MSK/Kafka 源作业启动即 error(key does not exist)排查根治(S3 flink/modules 缺模块 jar)",
        whenToUse: "MSK/Kafka 源 Flink 作业一点启动就 status=error、lastError 含 `The specified key does not exist`/NoSuchKey,且 AWS 侧查无 MSAF 应用时。",
        template: [
            "# 【MSK/Kafka 源作业启动即 error(key does not exist)排查】",
            "# 根因:MSK/Kafka 源【强制模块化拼装】—— 两个胖包(flink-sql-runner{,-s3t}.jar)均未打 kafka connector,",
            "#   启动时 assembleModularUberJar 从 S3 flink/modules/ 读 base+kafka+msk-iam-auth(+files/json;S3Tables再+iceberg-s3tables)合并。",
            "#   若 flink/modules/ 缺 jar → s3GetBuffer 抛 NoSuchKey → 拼装失败 → CreateApplication 都没发出 → status=error。",
            "",
            "# 🔴 排查第一步(最直接,别被表象带偏):",
            "aws s3 ls s3://<FLINK_CODE_BUCKET,约 bgp-glue-scripts-$ACCT>/flink/modules/",
            "#   期望有:flink-module-base.jar / flink-module-kafka.jar / flink-module-msk-iam-auth.jar / flink-module-files.jar / flink-module-json.jar",
            "#   若为空或缺 → 就是它。",
            "",
            "# ⚠️ 两个会带偏的表象(别顺着查):",
            "#   ① 日志 `Application ... does not exist`+`InvalidArgumentException`= 快照探测对尚未建成应用的设计内噪音,非根因。",
            "#   ② 用 CLI 拿【默认 jar】建应用能成功 ≠ code 没问题 —— MSK 走的是【拼装 jar】不是默认 jar。",
            "",
            "# 根治:部署脚本幂等上传模块 jar(deploy-all.sh §10.6(c));急救手动上传:",
            "for m in base kafka msk-iam-auth files json kinesis iceberg-s3tables; do",
            "  aws s3 cp flink-connector-modules/$m/target/flink-module-$m.jar s3://<脚本桶>/flink/modules/flink-module-$m.jar",
            "done   # jar 是 mvn 产物且 .gitignore 排除 target/*.jar,git clone 不带 → 缺则先 mvn -DskipTests package",
        ].join("\n"),
        dialectNotes: [
            "MSK/Kafka 源强制模块化拼装,不看全局开关(两个胖包都没打 kafka connector)。",
            "启动即 error + key does not exist + AWS 侧无应用 = 十有八九 flink/modules/ 缺 jar,先 aws s3 ls 查。",
            "快照探测的 `does not exist`/InvalidArgumentException 是设计内噪音;CLI 默认 jar 能建应用不能证明 code 没问题。",
        ],
        tags: ["flink", "msk", "kafka", "启动失败", "error", "key does not exist", "nosuchkey", "模块化", "拼装", "modules", "jar", "部署", "诊断"],
        verifiedAt: "2026-07-29",
        engineVersion: "flink-1.20",
    },
    {
        // 提炼自 2026-07-25 CloudTrail 真机实证的 S3 Tables sink 首帧 412 根治。配套方言 flink.s3tables-checkpoint-412。
        id: "flink.s3tables-412-troubleshoot",
        engine: "flink",
        capability: "checkpoint-412",
        title: "S3 Tables sink checkpoint 报 412 排查根治(冷启动致 checkpointId 归1撞残留)",
        whenToUse: "Flink 写 S3 Tables 的作业第二次及以后启动,首帧 checkpoint 报 `S3Exception ... 412 Precondition Failed`(堆栈 IcebergFilesCommitter.snapshotState)时。",
        template: [
            "-- 【S3 Tables sink 412 Precondition Failed 排查根治】",
            "-- 报错堆栈:IcebergFilesCommitter.snapshotState → FlinkManifestUtil.writeCompletedFiles → S3OutputStream.completeUploads → putObject",
            "--",
            "-- 机理:Flink delta manifest 文件名完全确定性(jobId-opUID-subTask-attempt-checkpointId-fileCount,无UUID);",
            "--   MSAF 对同一应用恒复用同一 JobID、opUID/subTask 也恒定 → 唯一变量是 checkpointId。",
            "--   作业以 SKIP_RESTORE 冷启动 → checkpointId 归1 → 与上轮残留 checkpoint-1 manifest 逐字节同名 → S3 Tables write-once 拒覆盖 → 412。",
            "--   (表首次创建为空无残留,故【第二次及以后】启动才报;失败逐轮恶化1→2→3,非抖一次自愈。)",
            "--",
            "-- 🔴 排查第一步(别跳过):查 CloudTrail 看 StartApplication 实际发的 ApplicationRestoreType",
            "--   是否 RESTORE_FROM_LATEST_SNAPSHOT;若是 SKIP_RESTORE,再查同时刻 ListApplicationSnapshots 是否 AccessDenied",
            "--   (平台 TaskRole 缺该权限 → 快照探测静默失败 → 误判无快照 → 冷启动)。",
            "--",
            "-- 根治:① TaskRole 补 kinesisanalytics 快照族权限(List/Describe/Create/DeleteApplicationSnapshot);",
            "--   ② 有状态作业默认开快照(snapshotsEnabled=true);",
            "--   ③ 启动恢复决策三态化——确认无快照才 SKIP,【探测失败(unknown)必须仍走 RESTORE】,绝不因探测失败退化成冷启动。",
            "-- 残留 manifest 由 AWS S3 Tables 自动 unreferenced file removal(3天)清理,平台不主动删(托管对象删除不可逆)。",
            "-- commit.retry 不适用(只认 CommitFailedException、只包 SnapshotProducer.commit,够不着 snapshotState 的 S3 412)。",
        ].join("\n"),
        dialectNotes: [
            "412根因=冷启动SKIP_RESTORE致checkpointId归1撞残留manifest,不是Iceberg命名缺熵。",
            "排查第一步查CloudTrail的ApplicationRestoreType;SKIP_RESTORE则查ListApplicationSnapshots是否AccessDenied。",
            "根治:TaskRole补快照权限+默认开快照+恢复决策三态化(探测失败仍RESTORE不冷启动)。",
        ],
        tags: ["flink", "s3tables", "412", "checkpoint", "precondition", "冷启动", "快照", "snapshot", "诊断", "根治", "manifest"],
        verifiedAt: "2026-07-25",
        engineVersion: "flink-1.20",
    },
    {
        id: "flink.cdc-to-sink",
        engine: "flink",
        capability: "cdc-stream",
        title: "Flink SQL 流:source → sink(近实时)",
        whenToUse: "用 Flink SQL 做近实时流(如 CDC/Kinesis 源实时写入 sink)时。",
        template: [
            "-- 1) 定义 source(如 MySQL CDC 或 Kinesis)",
            "CREATE TABLE src (",
            "  id BIGINT, amount DECIMAL(10,2), ts TIMESTAMP(3)",
            ") WITH ( 'connector' = 'kinesis' /* 或 mysql-cdc */, ... );",
            "-- 2) 定义 sink(s3table 才落 S3 Tables;默认 s3 是裸文件)",
            "CREATE TABLE sink ( ... ) WITH ( 'connector' = '<s3table/redshift/...>' , ... );",
            "-- 3) 必须有 INSERT INTO 才会真正跑数据",
            "INSERT INTO sink SELECT id, amount, ts FROM src;",
        ].join("\n"),
        dialectNotes: [
            "必须 INSERT INTO 才跑数据。",
            "要落 S3 Tables 用 sinkType=s3table,别用默认 s3(裸文件)。",
            "MySQL CDC 连接器需另打 mysql 驱动 jar。",
        ],
        tags: ["flink", "cdc", "stream", "实时", "近实时", "kinesis"],
    },
    {
        // 提炼自平台真跑验证过的 defaultFlinkSql(lib/realtime/flink-service.ts),Flink 1.20 窗口 TVF 范式。
        id: "flink.tumble-window-agg",
        engine: "flink",
        capability: "window-agg",
        title: "Flink 1.20 滚动窗口聚合(TVF + WATERMARK)",
        whenToUse: "用 Flink SQL 做实时窗口聚合(按时间窗口 SUM/COUNT,如每分钟各区域 GMV)时。",
        template: [
            "-- 源:事件时间列必须声明 WATERMARK(否则窗口不触发)",
            "CREATE TABLE src (",
            "  region STRING, amount DOUBLE, ts TIMESTAMP(3),",
            "  WATERMARK FOR ts AS ts - INTERVAL '5' SECOND",
            ") WITH (",
            "  'connector' = 'kinesis',",
            "  'stream.arn' = '${SOURCE_STREAM_ARN}',  -- 占位符原样保留,启动注入",
            "  'aws.region' = '${REGION}', 'source.init.position' = 'TRIM_HORIZON', 'format' = 'json'",
            ");",
            "-- sink:窗口聚合结果表",
            "CREATE TABLE agg_sink (",
            "  window_start TIMESTAMP(3), region STRING, total_amount DOUBLE, order_cnt BIGINT",
            ") WITH ( 'connector' = 'filesystem', 'path' = '${OUTPUT_PATH}', 'format' = 'json' );",
            "-- 窗口用 TVF(1.20);GROUP BY 必须含 window_start, window_end",
            "INSERT INTO agg_sink",
            "SELECT window_start, region, SUM(amount) AS total_amount, COUNT(*) AS order_cnt",
            "FROM TABLE(TUMBLE(TABLE src, DESCRIPTOR(ts), INTERVAL '1' MINUTE))",
            "GROUP BY window_start, window_end, region;",
        ].join("\n"),
        dialectNotes: [
            "窗口用 TVF:FROM TABLE(TUMBLE(TABLE src, DESCRIPTOR(ts), INTERVAL '1' MINUTE))(非老式 TUMBLE(ts,...))。",
            "GROUP BY 必须含 window_start, window_end(append-only sink 前提)。",
            "事件时间列必须 WATERMARK FOR ts AS ...;ts 用 TIMESTAMP(3)。",
            "敏感值(stream.arn/path)用占位符 ${...},启动时平台注入,勿写死。",
            "只能一条 INSERT INTO;多目标拆多作业。",
        ],
        tags: ["flink", "window", "窗口", "聚合", "tumble", "hop", "cumulate", "watermark", "实时", "tvf"],
        verifiedAt: "2026-07-19",
        engineVersion: "flink-1.20",
    },
];
