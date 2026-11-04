// 模块 44 — StepHandler SPI(步骤处理器接口)。把补数 execute.ts 写死的分支泛化为可注册的处理器:
// 新增步骤类型 = 注册一个 handler,不改推进器(executor)。这是"高度抽象 + 全球自安装可插拔"的核心。
//
// 一个 handler 对应一种 StepType,提供 4 段能力(按安全级别分层):
//   createDraft (L1):建 draft(无执行)。用户"确认某步"时调,返回 draft 资源 id。
//   execHint    (L2):告诉用户去哪个页面执行(纯文案,不调执行 API)。
//   execute?    (L3,留接口,默认引擎不调用):代表用户调 gated 执行 API。返回长任务定位或瞬时完成。
//   reconcile?  (L3):长任务终态回收(读 bgp-task-runs)。executor 默认走通用 reconcile,handler 可覆盖。

import type { CopilotCaller } from "../../tools/types";
import type { CopilotStepRow, StepType } from "../types";

// execute 的结果:要么落了长任务 run(走 reconcile 回收),要么瞬时完成(done)。
export type StepExecResult =
  | { runTaskId: string; runId: string }
  | { done: true };

export interface StepHandler {
  stepType: StepType;

  // L1:建 draft(无执行、不碰云资源、status=draft)。返回 draft 资源 id + 种类(深链用)。
  // 复用现有 create-service(createSyncDraft/createEtlDraft/...),不重写。
  createDraft(step: CopilotStepRow, caller: CopilotCaller): Promise<{ draftResourceId: string; draftResourceKind: string }>;

  // L2:执行指引(去哪页点)。可依赖已建 draft 的 id 做深链。纯文案,零副作用。
  execHint(step: CopilotStepRow): { page: string; action: string };

  // L3(留接口,默认 executor 因 autoExecute=false 不调用):代表用户调 gated 执行 API。
  execute?(step: CopilotStepRow, caller: CopilotCaller): Promise<StepExecResult>;

  // L3:长任务终态回收(覆盖通用 reconcile)。不提供则 executor 用通用 bgp-task-runs 回收。
  reconcile?(step: CopilotStepRow): Promise<"succeeded" | "failed" | null>;
}
