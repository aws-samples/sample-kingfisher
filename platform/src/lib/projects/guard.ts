// RBAC 守卫 (v1.4.0)
//
// Helpers used by API routes to enforce project-scoped, role-based access. The platform
// middleware already verifies every /api/* token; these helpers resolve identity + the
// active project + the caller's role, and gate the operation by a minimum role.

import { NextRequest, NextResponse } from "next/server";
import { resolveIdentity, Identity } from "@/lib/auth/identity";
import { resolveRole } from "./project-service";
import {
  DEFAULT_PROJECT_ID,
  PROJECT_HEADER,
  ProjectRole,
  roleAtLeast,
  DEFAULT_ENV,
  ENV_HEADER,
  Env,
  isEnv,
} from "./constants";
import { canManageProjectConfig, CONFIG_ADMIN_DENY_MESSAGE } from "./config-permissions";
import { apiError } from "@/lib/api-response";

// The active project for this request: x-bgp-project header, defaulting to the workspace
// that holds all legacy (pre-v1.4.0) resources.
export function getActiveProjectId(req: NextRequest): string {
  return req.headers.get(PROJECT_HEADER) || DEFAULT_PROJECT_ID;
}

// The active environment (module 15): x-bgp-env header, defaulting to dev.
export function getActiveEnv(req: NextRequest): Env {
  const v = req.headers.get(ENV_HEADER) || "";
  return isEnv(v) ? v : DEFAULT_ENV;
}

export interface ProjectContext {
  identity: Identity;
  projectId: string;
  role: ProjectRole;
}

// Require that the caller has at least `min` role in `projectId` (or the active project).
// Returns a ProjectContext on success, or a NextResponse (401/403) the route returns directly:
//
//     const ctx = await requireProject(req, "editor");
//     if (ctx instanceof NextResponse) return ctx;
//     // ...use ctx.identity / ctx.projectId / ctx.role
export async function requireProject(
  req: NextRequest,
  min: ProjectRole,
  projectId?: string
): Promise<ProjectContext | NextResponse> {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效，请重新登录", 401);
  const pid = projectId || getActiveProjectId(req);
  const role = await resolveRole(identity, pid);
  if (!role) return apiError("无权访问该项目空间", 403);
  if (!roleAtLeast(role, min)) return apiError("权限不足：需要更高的项目角色", 403);
  return { identity, projectId: pid, role };
}

// 🔴 **项目配置管理专用守卫**(改名 / 删项目 / 成员增删改 / 审批决策)。
//
// 判据 = 平台 admin ∨(manager ∧ 本项目 owner),见 `config-permissions.canManageProjectConfig`
// (前端按钮显隐用**同一个函数**,避免"按钮亮着却 403")。
//
// 实现刻意**叠在 `requireProject(req, "owner")` 之上**而不是另写一套:
//   · 401 / "无权访问该项目空间"(非成员)两条语义与消息**逐字不变** —— 非成员看到的东西不变,
//     不会因为本次收紧而多泄露"这个项目存在且我只是缺个组"这类信息;
//   · 本守卫只在"原本已经能过 owner 闸"的人里**再筛一次平台组** ⇒ 结构上不可能放宽。
export async function requireProjectConfigAdmin(
  req: NextRequest,
  projectId?: string
): Promise<ProjectContext | NextResponse> {
  const ctx = await requireProject(req, "owner", projectId);
  if (ctx instanceof NextResponse) return ctx;
  if (!canManageProjectConfig(ctx.identity.groups, ctx.role)) {
    return apiError(CONFIG_ADMIN_DENY_MESSAGE, 403, { code: "RBAC_DENIED" });
  }
  return ctx;
}

// For resource by-id routes: gate access by the *resource's* project (legacy items with no
// projectId belong to the default workspace).
export async function guardResourceAccess(
  req: NextRequest,
  item: { projectId?: string } | null | undefined,
  min: ProjectRole
): Promise<ProjectContext | NextResponse> {
  const pid = item?.projectId || DEFAULT_PROJECT_ID;
  return requireProject(req, min, pid);
}

// Build the DynamoDB FilterExpression fragment that scopes a Scan to a project. For the
// default workspace, legacy items (no projectId attribute) are included so pre-v1.4.0 demo
// data stays visible.
export function projectFilter(projectId: string): {
  clause: string;
  values: Record<string, unknown>;
} {
  if (projectId === DEFAULT_PROJECT_ID) {
    return {
      clause: "(projectId = :pid OR attribute_not_exists(projectId))",
      values: { ":pid": projectId },
    };
  }
  return { clause: "projectId = :pid", values: { ":pid": projectId } };
}

// Build the DynamoDB FilterExpression fragment scoping a Scan to an environment (module 15).
// For dev, legacy items (no env attribute) are included so pre-v1.6.0 resources stay visible.
export function envFilter(env: Env): { clause: string; values: Record<string, unknown> } {
  if (env === DEFAULT_ENV) {
    return { clause: "(#env = :env OR attribute_not_exists(#env))", values: { ":env": env } };
  }
  return { clause: "#env = :env", values: { ":env": env } };
}
