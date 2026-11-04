// 模块 33-A — EMR Serverless 作业规格「单一事实源」。
// 对齐 EMR Serverless console「提交 Spark 作业」核心可填项；照 lib/etl/worker-types.ts 范式：
// 表单、参数顾问 catalog、provider 都从这里取，避免多处漂移。

// EMR Serverless release(序 53,用户 2026-10-26 拍板:**缺省取最高版本、清单允许用户降版**;与 Glue 版本同一口径)。
// 版本列表 = EMR Serverless 控制台展示顺序,但 **label 用 API 真实值**(实测踩坑:控制台显示 emr-spark-8.0,
// 但 CreateApplication/StartJobRun 只认 emr-spark-8.0.0——写控制台那个会 ValidationException does-not-exist)。
// EMR Serverless 无 list-release API,以控制台顺序 + create-application 实测 label 为准。2026-10-26 复核:
//   · 最高 emr-spark-8.0.0(控制台标"emr-spark 8.0",API label 带末尾 .0)—— 仍是缺省;
//   · 其后 emr-7.14.0(2026-09-08 发布,Spark 3.5.8 / Iceberg 1.10.1,7.x 系列最高)/ 7.13.0 / 7.12.0 …;
//   · 两者在测试账号 create-application 都实测成功(建后即删)。
// 🔴 **清单第一项就是缺省**(单测钉 EMR_DEFAULT_RELEASE === EMR_RELEASE_LABELS[0]);env EMR_RELEASE_LABEL 可覆盖
//   (第二作者 application.ts / infra platform-stack.ts 的回落值都必须等于这里的缺省,单测钉)。
export const EMR_RELEASE_LABELS = [
  "emr-spark-8.0.0", "emr-7.14.0",
  "emr-7.13.0", "emr-7.12.0", "emr-7.11.0", "emr-7.10.0", "emr-7.9.0",
  "emr-7.8.0", "emr-7.7.0", "emr-7.6.0", "emr-7.5.0", "emr-7.4.0",
  "emr-7.3.0", "emr-7.2.0", "emr-6.15.0",
] as const;
export const EMR_DEFAULT_RELEASE = "emr-spark-8.0.0";

// 架构（ARM64 更省成本，作默认；x86 兼容第三方 native 依赖）。
export const EMR_ARCHITECTURES = ["ARM64", "X86_64"] as const;

// worker CPU / 内存 / 磁盘档位（driver/executor 通用）。EMR Serverless 有 vCPU:内存配比约束，
// 这里给出常用合法档位；非法组合由 AWS 侧在 StartJobRun 时报错（参数顾问可前置提示，见 §7.4）。
export const EMR_CPU_OPTIONS = ["1 vCPU", "2 vCPU", "4 vCPU", "8 vCPU", "16 vCPU"] as const;
export const EMR_MEMORY_OPTIONS = ["2 GB", "4 GB", "8 GB", "16 GB", "30 GB", "32 GB", "60 GB", "64 GB", "120 GB"] as const;

// executor 实例数上限（平台放开，由 application maximumCapacity 兜底）。
export const EMR_MAX_EXECUTORS = 100;

export interface EmrWorkerSpec {
  cpu: string; // "4 vCPU"
  memory: string; // "16 GB"
  disk?: string; // "20 GB"（EMR Serverless 磁盘 20-200GB）
}

export interface EmrSpec {
  releaseLabel: string;
  architecture: "ARM64" | "X86_64";
  driver: EmrWorkerSpec;
  executor: EmrWorkerSpec;
  executorCount: number; // spark.executor.instances
  executionRoleArn?: string; // 执行角色(留空=平台默认 EMR_EXECUTION_ROLE_ARN;填=自定义最小权限角色)
}

export const EMR_SPEC_DEFAULT: EmrSpec = {
  releaseLabel: EMR_DEFAULT_RELEASE,
  architecture: "ARM64",
  driver: { cpu: "4 vCPU", memory: "16 GB", disk: "20 GB" },
  executor: { cpu: "4 vCPU", memory: "16 GB", disk: "20 GB" },
  executorCount: 2,
};

// "4 vCPU" → "4"
const cpuNum = (v: string) => String(v || "").replace(/vcpu/i, "").trim() || "4";
// "16 GB" → "16g"（Spark memory 记法）
const memG = (v: string) => String(v || "").replace(/\s*gb/i, "").trim().toLowerCase() + "g";
// "20 GB" → "20G"（EMR Serverless disk 记法，大写 G）
const diskG = (v: string) => String(v || "").replace(/\s*gb/i, "").trim() + "G";

// 规格 → sparkSubmitParameters（确定性生成；平台保留键，用户 sparkConf 不覆盖这些，见 provider）。
/**
 * 🔴🔴 **把执行区注入到 driver / executor 的环境变量**(2026-09-22 真环境抓到,B-21 第八层)。
 *
 * 【真实失败】IAM 全部补齐、日志也能推上去之后,用户那个 copilot 生成的 ROI 作业仍然 ExitCode 1:
 *     botocore.exceptions.NoRegionError: You must specify a region.
 *   因为脚本写的是 `boto3.client('redshift-data')`(不带 region),而 **EMR Serverless 容器里
 *   没有 `AWS_REGION` / `AWS_DEFAULT_REGION`** ⇒ botocore 解析不出区域。
 *
 * 【为什么修在平台侧而不是只改配方】「每段生成的代码都记得带 region」是靠人/靠模型记得,必然漏;
 *   而**执行区这件事平台自己最清楚**(它就是这次 run 的落点)。⇒ 平台注入,代码不必关心。
 *   配方侧同批也补了一条规则(双管叉:用户手写 / planner 生成的代码同样安全)。
 * 🔴 与本仓那条元模式一致:凡「部署期快照 + 运行期增长」的配置,单一真值源派生,不散点硬编码。
 */
export function regionEnvParameters(region: string): string {
  if (!region) return "";
  // EMR Serverless 的 driver/executor 环境变量注入口径(spark-submit conf)。
  return [
    `--conf spark.emr-serverless.driverEnv.AWS_REGION=${region}`,
    `--conf spark.emr-serverless.driverEnv.AWS_DEFAULT_REGION=${region}`,
    `--conf spark.executorEnv.AWS_REGION=${region}`,
    `--conf spark.executorEnv.AWS_DEFAULT_REGION=${region}`,
  ].join(" ");
}

/**
 * 🔴🔴 **落点事实 + 执行区环境变量** 的唯一作者(2026-09-22 收;B-21 第八层)。
 *
 * 【为什么收成一处】原来 `provider.ts` 与 `schedule-fanout.ts` 各写了一份 `spark.bgp.*` 清单
 *   —— 两份清单必然走岔:这次要加「区域注入」,漏改一处就等于**定时调度那条路依然会 NoRegionError**
 *   (本仓老账:「列举式修法一定漏第 N+1 个」「写了 ≠ 接上了」)。
 * 【注入了什么】
 *   · `spark.bgp.*`  该区落点事实(桶/表桶/区/targetId)——用户脚本用 `spark.conf.get(...)` 读,
 *                    不必硬编码桶名(否则多区执行时所有区的产物都写回同一个桶,而作业照样报成功);
 *   · `AWS_REGION` / `AWS_DEFAULT_REGION` 注入 driver 与 executor 环境 ——
 *     **EMR Serverless 容器里没有默认区域**,`boto3.client('redshift-data')` 会直接
 *     `NoRegionError: You must specify a region`(2026-09-22 用户那个 ROI 作业的真实失败)。
 */
export function bgpLandingParameters(landing: {
  targetId: string; region: string; datalakeBucket: string; tableBucket: string;
  /** 该区 Redshift 的连接事实(工作组 / 库 / **凭证 secret ARN**)。 */
  redshiftWorkgroup?: string; redshiftDatabase?: string; redshiftSecretArn?: string;
}): string {
  return [
    `--conf spark.bgp.targetId=${landing.targetId}`,
    `--conf spark.bgp.region=${landing.region}`,
    `--conf spark.bgp.datalakeBucket=${landing.datalakeBucket}`,
    `--conf spark.bgp.tableBucket=${landing.tableBucket}`,
    // 🔴🔴 **Redshift 连接事实**(2026-09-22 真环境第九层):IAM 放行了 `redshift-data:*`、
    //   区域也注入了,作业仍然 `ERROR: permission denied for database dev` ——
    //   因为 `execute_statement` **不带 `SecretArn`** 时,Data API 用调用者 IAM 身份派生一个
    //   临时数据库用户,而那个用户在库里**没有任何授权**。
    //   平台自己所有 Redshift 调用的权威口径是 `SecretArn=<该区的 admin 凭证>`
    //   (`lib/redshift/admin-secret.ts`:统一执行身份,保证表属主一致)。
    //   ⇒ 把那三个事实注入作业,生成的代码照配方写 `SecretArn=spark.conf.get('spark.bgp.redshiftSecretArn')`,
    //     从此**不必猜、也不必硬编码某个区的工作组名**。
    landing.redshiftWorkgroup ? `--conf spark.bgp.redshiftWorkgroup=${landing.redshiftWorkgroup}` : "",
    landing.redshiftDatabase ? `--conf spark.bgp.redshiftDatabase=${landing.redshiftDatabase}` : "",
    landing.redshiftSecretArn ? `--conf spark.bgp.redshiftSecretArn=${landing.redshiftSecretArn}` : "",
    regionEnvParameters(landing.region),
  ].filter(Boolean).join(" ");
}

export function toSparkSubmitParameters(s: EmrSpec): string {
  const parts = [
    `--conf spark.driver.cores=${cpuNum(s.driver.cpu)}`,
    `--conf spark.driver.memory=${memG(s.driver.memory)}`,
    `--conf spark.executor.cores=${cpuNum(s.executor.cpu)}`,
    `--conf spark.executor.memory=${memG(s.executor.memory)}`,
    `--conf spark.executor.instances=${s.executorCount}`,
  ];
  if (s.driver.disk) parts.push(`--conf spark.emr-serverless.driver.disk=${diskG(s.driver.disk)}`);
  if (s.executor.disk) parts.push(`--conf spark.emr-serverless.executor.disk=${diskG(s.executor.disk)}`);
  return parts.join(" ");
}

// 平台保留的 spark conf 键（由 spec 确定性生成，用户自定义 sparkConf 不允许覆盖，对齐 ETL 保留键黑名单语义）。
export const RESERVED_SPARK_CONF = new Set([
  "spark.driver.cores",
  "spark.driver.memory",
  "spark.executor.cores",
  "spark.executor.memory",
  "spark.executor.instances",
  "spark.emr-serverless.driver.disk",
  "spark.emr-serverless.executor.disk",
  // 🔴 执行区注入的四个键是**保留**的:用户 sparkConf 覆盖它 = 把 boto3 调用打到别的 region,
  //   那不只是「跑不起来」,是**数据驻留**问题(模块 50 的红线)。
  "spark.emr-serverless.driverEnv.AWS_REGION",
  "spark.emr-serverless.driverEnv.AWS_DEFAULT_REGION",
  "spark.executorEnv.AWS_REGION",
  "spark.executorEnv.AWS_DEFAULT_REGION",
]);

// 用户自定义 sparkConf → 追加的 --conf 串（过滤保留键；空值跳过）。
export function userSparkConfToParameters(conf?: Record<string, string>): string {
  if (!conf) return "";
  return Object.entries(conf)
    .filter(([k]) => k && k.trim() && !RESERVED_SPARK_CONF.has(k.trim()))
    .map(([k, v]) => `--conf ${k.trim()}=${String(v ?? "").trim()}`)
    .join(" ");
}

// 平台自动注入的 S3 Tables（托管 Iceberg）catalog 支持——让用户脚本直接
// spark.table("s3tablescatalog.<namespace>.<table>") 读数据湖表，无需自己配 catalog/JAR。
// 权威配法（实证 SUCCESS，见 memory emr-serverless-s3tables-recipe）：
//  · catalog-impl = software.amazon.s3tables.iceberg.S3TablesCatalog（S3 Tables 官方类，非 GlueCatalog）
//  · --jars 挂 s3-tables-catalog-for-iceberg-runtime（EMR 默认 classpath 无此类）
//  · warehouse = 表桶 ARN
//  · application 必须挂带 NAT 的私有子网（S3TablesCatalog 运行时连 s3tables 公共 API）
// 环境变量由 CDK 注入（platform-stack）：EMR_S3TABLES_JAR / EMR_S3TABLES_WAREHOUSE_ARN。
export const S3TABLES_CATALOG_NAME = "s3tablescatalog";

export function s3TablesCatalogParameters(jarS3Uri?: string, warehouseArn?: string): string {
  if (!jarS3Uri || !warehouseArn) return ""; // 未配置则不注入（作业仍可跑纯 Spark）
  const c = S3TABLES_CATALOG_NAME;
  return [
    `--jars ${jarS3Uri}`,
    `--conf spark.sql.extensions=org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions`,
    `--conf spark.sql.catalog.${c}=org.apache.iceberg.spark.SparkCatalog`,
    `--conf spark.sql.catalog.${c}.catalog-impl=software.amazon.s3tables.iceberg.S3TablesCatalog`,
    `--conf spark.sql.catalog.${c}.warehouse=${warehouseArn}`,
  ].join(" ");
}
