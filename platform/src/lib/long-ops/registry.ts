// 长操作统一框架 —— 执行体注册表(装配各域执行体;键集 = LONG_OP_KINDS,tsc 钉死:少一个 / 多一个都编不过)。
//
// 框架不写业务:每个域在自己目录里写执行体(lib/ai/long-op-executors.ts · lib/modeling/long-ops.ts · lib/governance/long-ops.ts ·
// 第二批 lib/projects · lib/sync · lib/realtime · lib/workflow · lib/datasource · lib/metrics 各自的 long-ops.ts),
// 这里只做并集。判据 registry-wiring.test 从本文件的 import / 展开字面推出域文件清单,再按各文件的源码字面钉一遍键集(「写了」≠「接上了」)。

import type { LongOpExecutorRegistry } from "./executor-types";
import { AI_LONG_OP_EXECUTORS } from "@/lib/ai/long-op-executors";
import { MODELING_LONG_OP_EXECUTORS } from "@/lib/modeling/long-ops";
import { GOVERNANCE_LONG_OP_EXECUTORS } from "@/lib/governance/long-ops";
import { PROJECT_LONG_OP_EXECUTORS } from "@/lib/projects/long-ops";
import { SYNC_LONG_OP_EXECUTORS } from "@/lib/sync/long-ops";
import { REALTIME_LONG_OP_EXECUTORS } from "@/lib/realtime/long-ops";
import { WORKFLOW_LONG_OP_EXECUTORS } from "@/lib/workflow/long-ops";
import { DATASOURCE_LONG_OP_EXECUTORS } from "@/lib/datasource/long-ops";
import { METRICS_LONG_OP_EXECUTORS } from "@/lib/metrics/long-ops";
import { ENGINE_LONG_OP_EXECUTORS } from "@/lib/engines/long-ops";

export const LONG_OP_EXECUTORS: LongOpExecutorRegistry = {
  ...AI_LONG_OP_EXECUTORS,
  ...MODELING_LONG_OP_EXECUTORS,
  ...GOVERNANCE_LONG_OP_EXECUTORS,
  ...PROJECT_LONG_OP_EXECUTORS,
  ...SYNC_LONG_OP_EXECUTORS,
  ...REALTIME_LONG_OP_EXECUTORS,
  ...WORKFLOW_LONG_OP_EXECUTORS,
  ...DATASOURCE_LONG_OP_EXECUTORS,
  ...METRICS_LONG_OP_EXECUTORS,
  ...ENGINE_LONG_OP_EXECUTORS,
};
