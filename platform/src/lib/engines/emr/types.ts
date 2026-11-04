// EMR Serverless 作业类型（EngineJobBase 的 EMR 专属扩展）。

import type { EngineJobBase } from "../types";
import type { EmrSpec } from "./spec";
import type { EmrNetwork } from "./network";

export interface EmrEngineJob extends EngineJobBase {
  engine: "emr-serverless";
  entryPointArguments?: string[]; // 传给 PySpark 主脚本的位置参数
  sparkConf?: Record<string, string>; // 用户自定义 --conf 追加（保留键黑名单见 spec.ts）
  spec: EmrSpec; // driver/executor 规格（全暴露）
  network: EmrNetwork; // 连接信息（创建时前置填清）
  applicationId?: string; // 本作业专属 application（per-作业动态创建后回写）
}
