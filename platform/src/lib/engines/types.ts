// 模块 33-A — 离线多引擎 SPI:通用引擎类型（引擎无关）。
//
// 设计红线：引擎走 SPI 插件化——新引擎 = 独立目录纯增量 + registry 注册一行；老代码零改动。
// 照抄样板：lib/versions/version-service.ts（表驱动注册表 Record<type,meta> + 类型守卫）。
// 本期只 EmrServerless（application+job-run，PySpark）；EngineType 未来顺势加 emr-hive/emr-presto…。

export type EngineType = "emr-serverless";

// 运行记录统一状态词表（对齐 bgp-task-runs 约定，仅 4 值；见 lib/etl/job-service.ts 各引擎收敛）。
export type EngineJobStatus = "draft" | "ready" | "running" | "succeeded" | "failed";

// 引擎作业「引擎无关」基础形态。引擎专属配置（如 EMR 的 spec/network）在各引擎 types 里扩展。
// 物理分区键 userId 恒 "default-user"（逻辑多租户，与全仓一致，真实用户靠 createdBySub 区分）。
export interface EngineJobBase {
  userId: string;
  jobId: string;
  engine: EngineType;
  name: string;
  projectId: string;
  env: string;
  script: string; // 主脚本源码（PySpark）
  status: EngineJobStatus;
  lastRunId?: string;
  lastRunStatus?: string;
  lastRunAt?: string;
  // 模块 33-A 补齐:MWAA 周期调度(与 etl-job 一致)。schedule 路由维护。
  cronExpression?: string;
  scheduleEnabled?: boolean;
  airflowDagId?: string;
  createdBy: string;
  createdBySub: string;
  createdAt: string;
  updatedAt: string;
}

// provider 方法的入参基类型（各 provider 内部按 engine 收窄到自己的作业类型）。
export type EngineJob = EngineJobBase;
