// 模块 13 — 前端「当前项目空间」状态（localStorage）。
// 全局 fetch 拦截器（AuthProvider）据此附加 x-bgp-project 请求头。

import { DEFAULT_PROJECT_ID } from "./constants";

export const ACTIVE_PROJECT_KEY = "bgp-active-project";

export function getActiveProject(): string {
  if (typeof window === "undefined") return DEFAULT_PROJECT_ID;
  try {
    return window.localStorage.getItem(ACTIVE_PROJECT_KEY) || DEFAULT_PROJECT_ID;
  } catch {
    return DEFAULT_PROJECT_ID;
  }
}

export function setActiveProject(id: string): void {
  try {
    window.localStorage.setItem(ACTIVE_PROJECT_KEY, id);
  } catch {
    /* ignore */
  }
}

// 模块 15 — 当前环境 (dev/staging/prod)。
export const ACTIVE_ENV_KEY = "bgp-active-env";

export function getActiveEnv(): string {
  if (typeof window === "undefined") return "dev";
  try {
    return window.localStorage.getItem(ACTIVE_ENV_KEY) || "dev";
  } catch {
    return "dev";
  }
}

export function setActiveEnv(env: string): void {
  try {
    window.localStorage.setItem(ACTIVE_ENV_KEY, env);
  } catch {
    /* ignore */
  }
}
