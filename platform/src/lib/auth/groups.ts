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
