// 🔴 **D4 权限收紧的唯一判据**(52 DESIGN §D4 + INTERACTION §1;用户拍板:
//    「项目空间只有管理员和研发经理可以有权限创建和配置管理」)。
//
// 【为什么是纯函数、放在这里】同一条判据有**三个消费者**:
//   ① API 守卫(`guard.requireProjectConfigAdmin`)—— 真正的权限边界;
//   ② `/projects` 页按钮显隐 —— 交互要求"对 developer 直接隐藏,而不是点了才 403";
//   ③ 门禁测试。
// 三处若各写一遍布尔表达式,就会出现"按钮亮着但 API 403"或反过来"按钮灰了其实有权"
// —— 前者是用户眼里的故障,后者是权限缩水。⇒ 判据只写一次,零依赖(前端可安全 import)。
//
// 🔴 **UI 显隐不是安全边界**:真正拦截在 ① 的 403。本文件被前端 import 不代表判据可信,
//    它只保证"前端呈现与后端判定同源"。

import { PLATFORM_ADMIN_GROUP, MANAGER_GROUP } from "@/lib/auth/groups";
import type { ProjectRole } from "./constants";

/** 组名列表里是否含平台管理员组(前端只有 token 里的 groups,故一律从 groups 判)。 */
export function isPlatformAdminGroups(groups: readonly string[] | null | undefined): boolean {
  return !!groups && groups.includes(PLATFORM_ADMIN_GROUP);
}

/** 是否研发经理(平台管理员**不**隐含 manager 组,但下面两条判据都把 admin 单独放行)。 */
export function isManagerGroups(groups: readonly string[] | null | undefined): boolean {
  return !!groups && groups.includes(MANAGER_GROUP);
}

/**
 * D4 ——**创建**项目空间:平台 admin ∨ manager。
 *
 * 🔴 收紧点:改动前还包含 `bgp-developer`(`api/projects/route.ts` 旧 :32-36)。
 * 白名单式最小权限(不是"不在 viewer 组就放行"那种反证式判断 —— 无组账号会绕过)。
 */
export function canCreateProject(groups: readonly string[] | null | undefined): boolean {
  return isPlatformAdminGroups(groups) || isManagerGroups(groups);
}

/**
 * D4 ——项目**配置管理**(改名 / 删项目 / 成员增删改 / 审批决策):
 * 平台 admin ∨(manager **且**在该项目里是 owner)。
 *
 * 🔴 `myRole` 必须是**该项目的成员角色**(`resolveRole` 的结果);
 *    纯 developer 即使被设为项目 owner 也管不了配置(仍可正常开发资源)——这是拍板原文。
 * 🔴 判据严格窄于改动前(改动前 = `myRole === "owner"`):只是在其上**多要求**平台组,
 *    所以不会有"原来不能、现在能"的方向。
 */
export function canManageProjectConfig(
  groups: readonly string[] | null | undefined,
  myRole: ProjectRole | null | undefined
): boolean {
  if (isPlatformAdminGroups(groups)) return true;
  return isManagerGroups(groups) && myRole === "owner";
}

/**
 * 403 文案(交互 §1.2 明确要求"兜底 403 也带话",不是裸 403)。
 * 🔴 把"权限收紧"讲成**分工**而不是故障:告诉用户找谁,并明确"开发权没变"。
 */
export const CONFIG_ADMIN_DENY_MESSAGE =
  "配置管理(改名 / 删项目 / 成员增删改 / 审批决策)需平台管理员(bgp-admin)或研发经理(bgp-manager)" +
  "且为本项目 owner;你仍可正常开发本项目的同步/作业/工作流等资源。如需变更请联系管理员或研发经理。";

/** 创建被拒的文案(同样带"找谁"的出口)。 */
export const CREATE_PROJECT_DENY_MESSAGE =
  "无权创建项目空间:仅平台管理员(bgp-admin)与研发经理(bgp-manager)可创建。" +
  "如需新的项目空间,请联系管理员或研发经理。";

/** UI 置灰按钮的 Tooltip(与上面 403 同源,措辞更短)。 */
export const CONFIG_ADMIN_HINT = "配置管理需平台管理员或研发经理;你仍可正常开发本项目资源";
