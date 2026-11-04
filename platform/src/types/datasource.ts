export interface DataSource {
  userId: string;
  datasourceId: string;
  name: string;
  // 模块42:与 SPI DataSourceType 对齐。JDBC 四兄弟走扁平 host/port/db;
  //   stream(kinesis/msk)/nosql(dynamodb)/object-store(s3)走 connection 连接袋(下方)。
  type: "mysql" | "postgresql" | "oracle" | "sqlserver" | "kinesis" | "msk" | "dynamodb" | "s3";
  // JDBC 扁平字段(非 JDBC 源为空,连接信息在 connection 袋)。
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  /** @kf-batch 44-jdbc-params —— 附加 JDBC 连接参数(归一化的 `k=v&k=v`;唯一作者 lib/datasource-spi/jdbc/jdbc-params.ts)。
   *  只作用于经 Glue 连接 / Glue 作业的 JDBC 连接(同步、表发现、Glue 连接属性);控制面直连探测(mysql2 / pg …)不读它。
   *  不填 = 只有方言默认参数(MySQL:zeroDateTimeBehavior=CONVERT_TO_NULL)。 */
  jdbcParams?: string;
  // 非 JDBC 源(stream/nosql/object-store)的连接属性袋(kinesis:{streamName};dynamodb:{tableName};s3:{bucket,prefix,format})。
  connection?: Record<string, any>;
  paradigm?: "jdbc" | "stream" | "nosql" | "object-store";
  credentialKind?: "userpass" | "sasl-scram" | "iam-role" | "mtls" | "none";
  status: "active" | "inactive" | "unreachable" | "error" | "testing";
  env?: string;
  tags?: string[];
  // @kf-batch 50-W3f-T0-T3(50 ROADMAP §2octies.17 T3 / SPEC §1.3a S6)
  // 数据源的**落点**:归属 / 可达于哪个执行目标(`tgt_*`)。新建行由 `lib/datasource/placement.ts` 盖;
  // 存量行(placement 概念之前建的,那时平台只有 home 一条执行路径)由同文件的迁移补成 `tgt_home`。
  // 🔴 本刀只落字段与迁移,**不接线**:读侧 / 建源向导选项 / 跨区可达性判定 = O4(先拍跨区网络)。
  //    PUT 端点不接受客户端改它(与 projectId 同列为不可变属性),改落点要走 O4 定义的授权动作。
  ownerTargetId?: string;
  // Auto-provisioned resources
  secretArn?: string;
  glueConnectionName?: string;
  networkConfig?: {
    vpcId: string;
    subnetId: string;
    /** 序 61 B-133 第二刀 —— 子网所在可用区(2.1.2 及之前的存量行没有这个键;Glue 连接要写的 AZ 以子网事实为准,这里只是回显)。 */
    availabilityZone?: string;
    /** 第一个安全组(存量消费者读它)。 */
    securityGroupId: string;
    /** @kf-batch 37-B54-ds-user-sg —— 用户指定(建源或改网络)时的全部安全组;自动探测的行没有这个键。 */
    securityGroupIds?: string[];
    /** 批次 A 存量行:用户指定组时平台多建的那个 bgp-ds-* 组(B-54 起新行不再有;删源时由它清理)。 */
    platformSecurityGroupId?: string;
    isRds: boolean;
    rdsInstanceId?: string;
  };
  /** 序 61 B-133 —— 外部网络对象(安全组 / 子网 / Glue 连接 / 密钥)最近一次核对的结论:
   *  intact = 都在;healed = 平台自建对象曾被外部删除、已按原规则重建并接回;broken = 用户自带对象或密钥缺失(平台不代建)/ 自愈失败。
   *  存量行没有这个键 = 从未核对过(按 intact 显示)。写点唯一作者 lib/datasource/network-reconcile.ts。 */
  networkState?: "intact" | "healed" | "broken";
  /** broken 时的原因(对象 / id / 归属 / 中文说明 / 时刻);healed / intact 时为 null */
  networkIssue?: { object: "security-group" | "subnet" | "glue-connection" | "secret"; objectId?: string; userOwned: boolean; message: string; at: string } | null;
  /** 累计自愈次数(响亮:它在涨 = 账号里有清理工具在删平台对象) */
  healCount?: number;
  lastHealedAt?: string;
  testResult?: {
    success: boolean;
    steps: { name: string; status: string; message: string; latencyMs?: number }[];
    totalMs: number;
    testedAt: string;
  };
  // 序 38 B-70 —— 探测与浏览表走哪条网(客户生产环境 2026-10-13:源库在客户自己的 VPC,控制面 ECS 直连不到,
  //   页面「检测」把源刷成不可达、「浏览表」0 张,而同一连接的 Glue 作业跑得通)。
  //   · auto(缺省 / 存量行):先控制面直连,连不上且有 Glue 连接 ⇒ 自动改走 Glue 连接(TestConnection / 发现作业);
  //   · glue-connection:源在自有网络,直接走 Glue 连接,不再拿控制面直连的失败刷状态。
  probeVia?: "auto" | "glue-connection";
  /** 最近一次探测(DS-05 心跳 / B-70 Glue 连接验证)。 */
  heartbeat?: {
    reachable: boolean | null;
    latencyMs?: number | null;
    error?: string | null;
    at: string;
    /** 结论来自哪条网:控制面直连(存量语义)/ 数据源自己的 Glue 连接。 */
    via?: "control-plane" | "glue-connection";
    /** glue-connection:testing = 发现作业(探测载体)在跑;settled = 已有结论;unknown = 等超时 / 没结果(不猜)。 */
    state?: "testing" | "settled" | "unknown";
    startedAt?: string;
    validatedAt?: string;
    /** glue-connection:这次探测对应的发现作业 run(与 discovery.jobRunId 对得上) */
    jobRunId?: string;
    /** 走 Glue 连接时,顺带记下控制面直连那一下的结果(页面明示「控制面直连不到」用)。 */
    controlPlane?: { reachable: boolean | null; error?: string | null };
  };
  /** 序 38 B-70 —— 经 Glue 连接的表发现作业(一次性 Glue 作业,结果落脚本桶)。 */
  discovery?: {
    state: "running" | "succeeded" | "failed";
    jobName: string;
    jobRunId: string;
    startedAt: string;
    finishedAt?: string;
    error?: string;
    database: string;
    bucket: string;
    resultKey: string;
    region: string;
  };
  /** 发现作业的最近一次结果(浏览表 / 向导读它;「重新发现」才再起作业)。 */
  discoveredSchema?: {
    at: string;
    database: string;
    via: "glue-discovery";
    tables: Array<{ name: string; database: string; columns: Array<{ name: string; type: string; nullable?: boolean; key?: string; comment?: string }> }>;
  };
  createdAt: string;
  updatedAt: string;
}

export type DataSourceFormValues = Omit<DataSource, "userId" | "datasourceId" | "status" | "secretArn" | "glueConnectionName" | "networkConfig" | "testResult" | "heartbeat" | "discovery" | "discoveredSchema" | "createdAt" | "updatedAt">;

/** 序 38 B-70:探测方式的闭合清单(表单 / 路由校验同一份)。 */
export const DS_PROBE_VIA = ["auto", "glue-connection"] as const;
export type DsProbeVia = (typeof DS_PROBE_VIA)[number];

// UI 类型目录(纯静态数据,前端安全 import——不引 registry,那会把 @aws-sdk/client-kinesis 等
// Node 依赖拉进前端 bundle)。paradigm 驱动建源表单分支:jdbc 走 host/port/db+网络;stream 走流名+新建。
// 与后端 SPI capabilities 保持一致(新增源类型:这里加一行 + 后端 registry 加 provider)。
export const DS_TYPE_OPTIONS = [
  { label: "MySQL", value: "mysql", defaultPort: 3306, icon: "🐬", paradigm: "jdbc" },
  { label: "PostgreSQL", value: "postgresql", defaultPort: 5432, icon: "🐘", paradigm: "jdbc" },
  { label: "Oracle", value: "oracle", defaultPort: 1521, icon: "🔶", paradigm: "jdbc" },
  { label: "SQL Server", value: "sqlserver", defaultPort: 1433, icon: "🔷", paradigm: "jdbc" },
  { label: "Kinesis 流", value: "kinesis", defaultPort: 0, icon: "🌊", paradigm: "stream" },
  { label: "MSK / Kafka", value: "msk", defaultPort: 0, icon: "📨", paradigm: "stream" },
  { label: "DynamoDB", value: "dynamodb", defaultPort: 0, icon: "🔑", paradigm: "nosql" },
  { label: "S3 对象存储", value: "s3", defaultPort: 0, icon: "🪣", paradigm: "object-store" },
] as const;
