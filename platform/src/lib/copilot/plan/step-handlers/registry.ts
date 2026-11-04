// 模块 44 — StepHandler 注册表(表驱动 SPI,照抄 lib/engines/registry.ts)。
// 加步骤类型 = STEP_HANDLERS 加一行 + 独立 handler 纯增量;推进器(executor)零改动。

import type { StepHandler } from "./spi";
import type { StepType } from "../types";
import { STEP_HANDLERS } from "./handlers";

const HANDLERS: Record<string, StepHandler> = Object.fromEntries(
  STEP_HANDLERS.map((h) => [h.stepType, h])
);

export function getStepHandler(stepType: StepType): StepHandler | undefined {
  return HANDLERS[stepType];
}

export function hasStepHandler(stepType: string): boolean {
  return stepType in HANDLERS;
}

export function listStepTypes(): string[] {
  return Object.keys(HANDLERS);
}
