// 前端角色判定（与后端 identity / middleware 一致）。
// 仅用于 UI 呈现（菜单/跳转）；真正的权限在 API 层（middleware 白名单 + 各路由守卫）强制。
import { PLATFORM_ADMIN_GROUP, MANAGER_GROUP, DEVELOPER_GROUP, ANALYST_GROUP } from "./groups";

export function groupsFromToken(token?: string | null): string[] {
  if (!token) return [];
  try {
    const p = JSON.parse(atob(token.split(".")[1] || ""));
    return (p["cognito:groups"] as string[]) || [];
  } catch {
    return [];
  }
}

// 运营分析账号：仅 bgp-analyst，且不属于 admin/manager/developer 任一特权组。
// 这类账号只能使用「智能问数」并从中「提为需求」，其余功能一律不开放。
export function isAnalystOnly(groups: string[]): boolean {
  const g = new Set(groups);
  return g.has(ANALYST_GROUP) && !g.has(PLATFORM_ADMIN_GROUP) && !g.has(MANAGER_GROUP) && !g.has(DEVELOPER_GROUP);
}
