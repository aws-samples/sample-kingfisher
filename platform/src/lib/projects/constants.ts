// 模块 13 — 项目空间常量与角色 (v1.4.0)

export const DEFAULT_PROJECT_ID = "proj-default";
export const DEFAULT_PROJECT_NAME = "默认空间";
// 默认工作区描述:平台预置常量(单一事实源,seed 与 i18n 词条共用)。
export const DEFAULT_PROJECT_DESCRIPTION =
  "平台默认工作空间（承载历史资源；任何登录用户隐式为 editor）";

// 工作区名/描述显示:默认工作区的 name/description 是平台预置常量(中文),走 i18n
// 翻译;用户自建工作区的是业务数据,原样返回(严禁翻)。渲染处统一调用。
export function projectDisplayName(
  name: string,
  projectId: string,
  t: (zh: string) => string,
): string {
  return projectId === DEFAULT_PROJECT_ID ? t(name) : name;
}
export function projectDisplayDescription(
  description: string | undefined,
  projectId: string,
  t: (zh: string) => string,
): string | undefined {
  if (!description) return description;
  return projectId === DEFAULT_PROJECT_ID ? t(description) : description;
}

// Header carrying the active project id (set by the frontend fetch interceptor from
// localStorage["bgp-active-project"]).
export const PROJECT_HEADER = "x-bgp-project";

// 模块 15 — 多环境 (v1.6.0): config resources live in an environment within a project.
export const ENVS = ["dev", "staging", "prod"] as const;
export type Env = (typeof ENVS)[number];
export const DEFAULT_ENV: Env = "dev";
export const ENV_HEADER = "x-bgp-env";
// Promoting INTO a protected environment requires an approval (type "deploy").
export const PROTECTED_ENVS: Env[] = ["prod"];
// @kf-batch 50-SEQ47a-promote-ux —— 环境颜色 / 说明的唯一作者(顶栏切换器、资源 EnvTag、各环境发布状态三处共用;原来只在 Header 里有一份)。
export const ENV_COLOR: Record<Env, string> = { dev: "green", staging: "gold", prod: "red" };
export const ENV_DESC: Record<Env, string> = { dev: "开发", staging: "预发", prod: "生产" };

export function isEnv(v: unknown): v is Env {
  return typeof v === "string" && (ENVS as readonly string[]).includes(v);
}
export function isProtectedEnv(env: string): boolean {
  return (PROTECTED_ENVS as string[]).includes(env);
}

// Constant partition values for the single-partition tables.
export const PROJECTS_PK = "project";
export const APPROVALS_PK = "approval";

export type ProjectRole = "owner" | "editor" | "viewer";

export const ROLE_RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, owner: 3 };

export function isProjectRole(v: unknown): v is ProjectRole {
  return v === "owner" || v === "editor" || v === "viewer";
}

// Does `role` satisfy the `min` requirement? (owner ⊇ editor ⊇ viewer)
export function roleAtLeast(role: ProjectRole | null | undefined, min: ProjectRole): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[min];
}
