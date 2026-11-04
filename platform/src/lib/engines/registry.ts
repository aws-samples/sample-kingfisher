// 引擎注册表（表驱动，照抄 lib/versions/version-service.ts:24-37）。
// 加引擎 = 这张表加一行 + 独立目录纯增量；老代码零改动。

import type { EngineProvider } from "./spi";
import type { EngineType } from "./types";
import { emrServerlessProvider } from "./emr/provider";

const PROVIDERS: Record<EngineType, EngineProvider> = {
  "emr-serverless": emrServerlessProvider, // ← 加引擎只加一行
};

export function isEngineType(v: unknown): v is EngineType {
  return typeof v === "string" && v in PROVIDERS;
}

export function getProvider(type: EngineType): EngineProvider {
  return PROVIDERS[type];
}

export function listEngines(): EngineType[] {
  return Object.keys(PROVIDERS) as EngineType[];
}
