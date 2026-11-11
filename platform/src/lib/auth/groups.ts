// 平台 Cognito 组名的**唯一定义处**(纯常量,零依赖 ⇒ 前端组件也能安全 import)。
//
// 【为什么单独一个文件】原来这三个常量定义在 `identity.ts`,而那个文件 import 了
// `next/server` 与 `verify-token`(aws-jwt-verify)⇒ **客户端组件不能 import 它**。
// 于是前端只能写字面量:`groups.includes("bgp-manager")`(见 `app/requirements/page.tsx:58`
// 与 `lib/auth/roles.ts:18`)。D4 要让**前端按钮显隐与后端 403 判据同源**,
// 若判据函数只能拿字面量,就又造一处会漂移的副本。
// ⇒ 常量搬到这里,`identity.ts` 原样 re-export(既有 import 路径与行为**逐字不变**)。
//
// 🔴 别往本文件加任何 import:它的价值就在于"前后端都能用"。

/** 平台管理员组 → 跨全部项目的超级用户。 */
export const PLATFORM_ADMIN_GROUP = "bgp-admin";
/** 数据产品/研发经理组(受理/指派/验收需求);D4 起也是项目空间创建/配置管理的必要组。 */
export const MANAGER_GROUP = "bgp-manager";
/** 研发组(承接被指派的需求)。🔴 D4 起**不再**能创建项目空间。 */
export const DEVELOPER_GROUP = "bgp-developer";
/** 运营分析组(只开放智能问数 + 提需求)。 */
export const ANALYST_GROUP = "bgp-analyst";

// ── 用户管理页的「平台角色」:角色 ↔ 组的**唯一映射**(页面下拉、列表角色列、建号 / 改角色路由三处共用)──
// 🔴 为什么:原来页面 / 路由只认 Admin / Developer / Viewer 三档,「Viewer」被建进 bgp-viewer —— 四组之外、没有任何守卫认它;
//   bgp-manager / bgp-analyst 的账号在页面上被显示成「Viewer」,在页面改一次角色就把 manager / analyst 组摘掉。
//   现在角色就是四个真实平台组 + 「无平台组」(只靠项目成员资格;问数 / 直查等仍按项目成员校验)。
/** 平台角色闭合清单(有静默合法默认值的参数是一整类缺陷:建号 / 改角色必须显式给、清单外 400)。 */
export const PLATFORM_ROLES = ["Admin", "Manager", "Developer", "Analyst", "None"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
/** 角色 → 组;None 不对应任何组。 */
export const PLATFORM_ROLE_GROUP: Record<Exclude<PlatformRole, "None">, string> = {
  Admin: PLATFORM_ADMIN_GROUP,
  Manager: MANAGER_GROUP,
  Developer: DEVELOPER_GROUP,
  Analyst: ANALYST_GROUP,
};
/** 全部平台组(改角色先从这些组摘掉,再加进目标组)。 */
export const PLATFORM_GROUPS: readonly string[] = [PLATFORM_ADMIN_GROUP, MANAGER_GROUP, DEVELOPER_GROUP, ANALYST_GROUP];
/** 历史遗留组:早期用户管理页把「Viewer」建进它;平台没有任何守卫认它 ⇒ 显示为「无平台组」,改角色时一并摘掉。 */
export const LEGACY_VIEWER_GROUP = "bgp-viewer";
/** 角色标签(中文键,渲染处经 t() 翻译;英文词典须有同键)。 */
export const PLATFORM_ROLE_LABEL: Record<PlatformRole, string> = {
  Admin: "Admin - 平台管理员",
  Manager: "Manager - 研发经理",
  Developer: "Developer - 开发者",
  Analyst: "Analyst - 运营分析",
  None: "无平台组(仅项目成员)",
};
export function isPlatformRole(v: unknown): v is PlatformRole {
  return typeof v === "string" && (PLATFORM_ROLES as readonly string[]).includes(v);
}
/** 从组清单判角色:按特权高低取最高的一个(Admin > Manager > Developer > Analyst),都不在 ⇒ None。 */
export function roleFromGroups(groups: readonly string[]): PlatformRole {
  const g = new Set(groups);
  if (g.has(PLATFORM_ADMIN_GROUP)) return "Admin";
  if (g.has(MANAGER_GROUP)) return "Manager";
  if (g.has(DEVELOPER_GROUP)) return "Developer";
  if (g.has(ANALYST_GROUP)) return "Analyst";
  return "None";
}
