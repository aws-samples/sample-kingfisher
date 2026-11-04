// @paramadvisor/core — 参数目录/提示词渲染所需的核心类型单一来源。
//
// 【core 契约】(照 @genbi/core)core 内部所有文件引用类型都走 "./types"(相对路径,不用 @/ alias),
// 保证 core 能独立编译成 CJS 给容器 agent import 时无 alias 解析问题。
//
// 只放 core(catalog/prompt 渲染)真正需要的两个类型:ParamChannel + ParamDef。
// 其余顾问契约(WorkloadProfile/ParamAdviceRequest/HistoryFacts/ParamAdvice…)仍留
// param-advisor/types.ts(不牵连进 core);后者反向 re-export 本文件这两个类型,对外 API 不变。

// 参数通道——决定用哪套参数目录与 prefill 形态。
export type ParamChannel =
  | "glue-etl" // ETL 脚本作业(etl-jobs 页):workerType/numberOfWorkers/glueVersion/timeout
  | "glue-sync" // 数据同步 Glue 通道(sync 表单):retry/timeout + Iceberg + Redshift 目标参数
  | "flink" // 实时计算 MSAF:parallelism/parallelismPerKPU/autoScaling
  | "dms" // 实时同步 DMS 通道:实例规格/迁移类型/LOB + Redshift 目标参数
  | "emr"; // 离线多引擎 EMR Serverless Spark 作业(模块 33-A):driver/executor 规格 + release/架构 + executor 数 + sparkConf

// 单个参数的目录定义——对齐托管服务 console 创建页([[full-param-parity-with-managed-consoles]]的机器可读化)。
export interface ParamDef {
  key: string; // 表单/payload 字段名(点路径,如 "redshiftConfig.distStyle")
  label: string; // 中文名(与表单一致)
  consoleRef: string; // 对应 AWS console 创建页的字段(出处)
  type: "string" | "number" | "boolean" | "enum";
  options?: string[]; // enum 可选值
  min?: number;
  max?: number;
  unit?: string; // 展示单位(GB/分钟/秒…)
  platformDefault: unknown; // 平台当前默认值
}
