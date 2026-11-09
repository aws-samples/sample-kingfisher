// EMR Serverless 作业类型（EngineJobBase 的 EMR 专属扩展）。

import type { EngineJobBase } from "../types";
import type { EmrSpec } from "./spec";
import type { EmrNetwork } from "./network";
// 数据湖表桶路由:作业的数据湖表桶声明(与 Glue 作业 glueConfig 同一形状;唯一作者 lib/lake/routes.ts)
import type { LakeBucketDeclaration } from "@/lib/lake/routes";

export interface EmrEngineJob extends EngineJobBase {
  engine: "emr-serverless";
  entryPointArguments?: string[]; // 传给 PySpark 主脚本的位置参数
  sparkConf?: Record<string, string>; // 用户自定义 --conf 追加（保留键黑名单见 spec.ts）
  // 数据湖表桶路由(设计稿 §6.2 / §6.10.6):不给 = 本区全部路由;给了 = 每桶一条 { bucket, access } 子集,平台按它注入 S3TablesCatalog 目录、按桶量权限
  lakeBuckets?: LakeBucketDeclaration[];
  // 缺省目录别名(spark.sql.defaultCatalog;必须是本作业目录之一)
  defaultCatalogAlias?: string;
  spec: EmrSpec; // driver/executor 规格（全暴露）
  network: EmrNetwork; // 连接信息（创建时前置填清）
  applicationId?: string; // 本作业专属 application（per-作业动态创建后回写）
}
