// 多引擎作业前端类型 + 模板（独立文件，不碰 types/etl-job.ts 老类型）。

import type { EmrSpec } from "@/lib/engines/emr/spec";
import type { EmrNetwork } from "@/lib/engines/emr/network";
// 数据湖表桶路由:数据湖表桶声明(浏览器安全的纯文法模块)
import type { LakeBucketDeclaration } from "@/lib/lake/routes-grammar";

export interface EngineJobView {
  userId: string;
  jobId: string;
  engine: "emr-serverless";
  name: string;
  description?: string;
  script: string;
  spec: EmrSpec;
  network: EmrNetwork;
  sparkConf?: Record<string, string>;
  // 数据湖表桶路由:数据湖表桶声明(与 lib/engines/emr/types.ts 的 EmrEngineJob 同形)
  lakeBuckets?: LakeBucketDeclaration[];
  defaultCatalogAlias?: string;
  entryPointArguments?: string[];
  applicationId?: string;
  applicationCreateError?: string;
  status?: "draft" | "ready" | "running" | "succeeded" | "failed";
  lastRunId?: string;
  lastRunStatus?: string;
  lastRunAt?: string;
  // 补齐:MWAA 周期调度。
  cronExpression?: string;
  scheduleEnabled?: boolean;
  airflowDagId?: string;
  createdAt: string;
  updatedAt: string;
}

// EMR Serverless PySpark 起手模板。开箱即跑通：平台已自动注入 S3 Tables (Iceberg) catalog 支持
// （catalog 名 s3tablescatalog + runtime JAR + 表桶 warehouse，无需用户自己配），脚本可直接
// spark.table("s3tablescatalog.<命名空间>.<表>") 读数据湖表。前提：作业「连接信息」填了带 NAT
// egress 的私有子网 + 安全组（S3TablesCatalog 运行时要出网连 s3tables API）。
// 已在 EMR Serverless 真跑 SUCCESS 验证（读 ecommerce.orders 表 100000 行）。
export const EMR_PYSPARK_TEMPLATE = `import sys
from pyspark.sql import SparkSession
from pyspark.sql import functions as F

# 业务日期由平台以参数形式追加在你的入参之后：--ds 2026-09-01 --ds_nodash 20260901 --yesterday_ds … --bizdate … --bizmonth …
# （与 Glue 作业同一套参数名；手动指定日期 / 补数 / 重跑 / 定时都走这一套，脚本文本里不要写 \${ds} 占位符，平台不替换 EMR 脚本文本）。
def _arg(name, default=""):
    for i, a in enumerate(sys.argv):
        if a == "--" + name and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
        if a.startswith("--" + name + "="):
            return a.split("=", 1)[1]
    return default

ds = _arg("ds")                 # YYYY-MM-DD
ds_nodash = _arg("ds_nodash")   # YYYYMMDD
bizdate = _arg("bizdate")       # 运行日前一天 YYYYMMDD（DataWorks 口径）

# catalog（s3tablescatalog）由平台自动配置，直接 getOrCreate 即可。
spark = SparkSession.builder.appName("bgp-emr-job").getOrCreate()

# 示例：读数据湖 ecommerce 命名空间的 orders 表并按地区聚合（改成你的业务逻辑）。
SRC = "s3tablescatalog.ecommerce.orders"
df = spark.table(SRC)
print(f"[EMR] ds={ds}, 读取 {SRC}: {df.count()} 行")
df.groupBy("region").count().orderBy(F.desc("count")).show(truncate=False)

# 写回数据湖（Iceberg，幂等可用 MERGE INTO / CREATE TABLE IF NOT EXISTS）：
# spark.sql("CREATE TABLE IF NOT EXISTS s3tablescatalog.ecommerce.my_result (region STRING, cnt BIGINT) USING iceberg")

spark.stop()
`;
