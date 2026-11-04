import type { DeploymentRecord } from "@/lib/exec-env/deployments-shared";
// ETL 开发模块（作业开发）— 用户自写脚本的作业类型。
// 引擎复用现有 Glue（PySpark 脚本作业）/ Redshift（SQL 作业），调度走 MWAA。

export type EtlJobType = "glue" | "redshift";

export interface GlueJobConfig {
  workerType?: string; // G.1X | G.2X ...
  numberOfWorkers?: number;
  glueVersion?: string; // 闭合清单 + 缺省见 lib/sync/glue-version.ts(缺省最高,可降版)
  connectionName?: string; // 可选：访问 VPC 内源(如 RDS)的 Glue 连接
  timeoutMinutes?: number;
  // 执行角色(IAM Role ARN):留空=用平台默认角色(GLUE_ROLE_ARN);填了=用自定义角色(最小权限)。
  // 托管服务创建任务必须指定执行角色;此前只用平台统一角色,不符最小权限(见 qa-findings U3)。
  executionRoleArn?: string;
  // ── 参数齐全暴露(对齐 Glue console 创建页) ──
  maxRetries?: number; // Number of retries(失败自动重试,Glue 默认 0)
  executionClass?: "STANDARD" | "FLEX"; // Execution class(FLEX=弹性容量计费更省,不支持 G.4X)
  jobBookmark?: "job-bookmark-disable" | "job-bookmark-enable" | "job-bookmark-pause"; // Job bookmark(--job-bookmark-option)
  maxConcurrentRuns?: number; // Max concurrency(最大并发运行数)
  jobParameters?: Record<string, string>; // 自定义 Job parameters(--key → value)
  extraJars?: string; // 依赖 JAR 的 S3 URI,逗号分隔(--extra-jars)
  extraPyFiles?: string; // 依赖 Python 文件(.py/.whl/.zip)的 S3 URI,逗号分隔(--extra-py-files)
}

export interface RedshiftJobConfig {
  workgroupName?: string;
  database?: string;
}

export interface EtlJob {
  userId: string;
  jobId: string;
  name: string;
  // @kf-batch 52-P52.2-W2a-run-stamp
  // 🔴 **DDB 行早就带 `projectId`,只有 TS 类型一直没写**(读侧 `api/etl-jobs` 就在按它
  // `projectFilter`)。这个缺口很坑:run 盖章要以作业行的 projectId 为权威,而类型层说"没有这个字段"
  // ⇒ 带类型的单测 fixture 永远不会设它 ⇒ 盖章恒为默认项目也测不出来
  // (同 memory `unwired-code-is-unverified` 的退化 fixture)。可选是因为存量行确实没有。
  projectId?: string;
  // @kf-batch 50-P50.3-dataplane
  /**
   * ⚠️ **W3-a 落的单值绑定,已被 `targets` 取代**(50 SPEC §1.3a-S1 的合同是 `targets?: string[]`)。
   *
   * 保留它**只为读兼容**:W3-a 已经在真环境产生了带这个字段的行,不能当它不存在。
   * 🔴 **新代码一律走 `bindingTargets(job)` 归一**(`lib/exec-env/data-plane-target.ts`),
   * 不要直接读这两个字段中的任何一个 —— 直接读就等于让"这个作业绑了哪些区"有两个说法。
   * 写入路径只写 `targets`。
   */
  targetId?: string;
  // @kf-batch 50-P50.3-multibind —— 50 SPEC §1.3a-**S1**(被点名为"整个模块
  // 「哪个任务打哪个 target」的核心数据模型";纯追加属性、零迁移)。
  /**
   * 🔴 **执行目标绑定**(缺省 `["tgt_home"]`)。一个定义可绑多个区域;
   * 一次**运行**只在一个区域发生(run 记录的 `targetId` 是单值)。
   * 服务端必须逐个校验(准入 / 组件 / 跨法域),见 `assertBindableTargets`。
   */
  targets?: string[];
  /**
   * 🔴 **逐 target 下发台账** —— 版本一致性矩阵读的就是它。
   * `version` = 下发时该定义的版本号(`snapshotVersion` 的递增号);
   * 与当前版本不一致 ⇒ 矩阵判"版本不齐";`status:"failed"` ⇒ 红格;缺条目 ⇒ "漏发"。
   */
  // @kf-batch 50-WP15-airflow-serverless:值形态 = lib/exec-env/deployments-shared 的 DeploymentRecord(单一作者;+scheduler / workflowArn),不再第二份手抄
  deployments?: Record<string, DeploymentRecord>;
  /** 该 (定义 × target) 已特化(脱离共享定义)。特化格**不参与**矩阵的红黄判定。 */
  specializedFrom?: Record<string, { sourceId: string; at: number }>;
  type: EtlJobType;
  description?: string;
  script: string; // PySpark（glue）或 SQL（redshift），用户自写
  glueConfig?: GlueJobConfig;
  redshiftConfig?: RedshiftJobConfig;
  // 调度（MWAA）
  cronExpression?: string;
  scheduleEnabled?: boolean;
  airflowDagId?: string;
  // 运行态
  glueJobName?: string; // 实际创建的 Glue 作业名（type=glue）
  status?: "draft" | "ready" | "running" | "succeeded" | "failed";
  lastRunId?: string;
  lastRunStatus?: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export const ETL_GLUE_TEMPLATE = `import sys
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from awsglue.context import GlueContext
from awsglue.job import Job
from pyspark.sql import functions as F

# 业务日期参数 ds 由平台运行时注入（--ds）
args = getResolvedOptions(sys.argv, ["JOB_NAME", "ds"])
ds = args["ds"]
sc = SparkContext()
glueContext = GlueContext(sc)
spark = glueContext.spark_session
job = Job(glueContext)
job.init(args["JOB_NAME"], args)

# 平台已配置好 S3 Tables 的 Iceberg 目录：s3tablescatalog.<命名空间>.<表>
# 数据湖命名空间为 ecommerce，可用表如 orders / order_items / fx_rates。
SRC = "s3tablescatalog.ecommerce.orders"

# 示例：读取并按地区聚合订单数后打印（print/show 会进 CloudWatch 日志）
df = spark.table(SRC)
print(f"[ETL] ds={ds}, 读取 {SRC}: {df.count()} 行")
df.groupBy("region").count().orderBy(F.desc("count")).show(truncate=False)

# 写回数据湖示例（Iceberg，幂等可用 MERGE INTO）：
# spark.sql("CREATE TABLE IF NOT EXISTS s3tablescatalog.ecommerce.my_result (region STRING, cnt BIGINT) USING iceberg")
# 写 Redshift 数仓请用 boto3 redshift-data Data API（workgroup=bgp-workgroup, database=dev），勿用 JDBC。

job.commit()
`;

export const ETL_REDSHIFT_TEMPLATE = `-- 在这里写你的 Redshift SQL（可多条，用分号分隔）。
-- 示例：用 CTAS 生成一张汇总表。
CREATE TABLE IF NOT EXISTS public.sales_by_region AS
SELECT region, SUM(amount) AS total_amount
FROM public.sales
GROUP BY region;

-- 🔴 建表后【不要】授权给 PUBLIC：平台各读写路径用同一个数仓身份执行，建完表在查询页/智能问数
--    里本来就看得到；而授权给 PUBLIC 会让库内所有身份读写这张表，击穿项目隔离（平台已禁）。
`;
