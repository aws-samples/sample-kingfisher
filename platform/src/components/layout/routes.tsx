// 菜单树 — Sidebar(导航)与 MultiTabs(页签标题)共用的单一事实源。
import React from "react";
import type { MenuRouteKey } from "@/lib/scope/route-scope";
import {
  DatabaseOutlined,
  SyncOutlined,
  ApartmentOutlined,
  ConsoleSqlOutlined,
  DashboardOutlined,
  SafetyCertificateOutlined,
  HomeOutlined,
  UserOutlined,
  SettingOutlined,
  FileSearchOutlined,
  RobotOutlined,
  CodeOutlined,
  AppstoreOutlined,
  SolutionOutlined,
  CloudServerOutlined,
  BuildOutlined,
  FundOutlined,
  FieldTimeOutlined,
  ClusterOutlined,
  DeploymentUnitOutlined,
  CloudOutlined,
  ApiOutlined,
  ThunderboltOutlined,
  BellOutlined,
  FundProjectionScreenOutlined,
  HistoryOutlined,
  BulbOutlined,
  DollarCircleOutlined,
  GlobalOutlined,
} from "@ant-design/icons";

// @kf-batch 50-WP4-o1-scope —— 🔴 `key` 的类型 = 「执行范围能力登记表」的 keyof
// (`lib/scope/route-scope.ts` 的 `MENU_ROUTE_SCOPE`):**菜单里加一页而没登记能力 ⇒ `tsc` 直接红**,
// 不会出现「新页面悄悄按全部渲染」(A4:非法状态无法表达)。逐路由取值与理由见 INTERACTION §9.6 表 A;
// 不在菜单树里的 9 条见 `lib/scope/capability.ts` 的 `EXTRA_ROUTE_SCOPE`。
export interface Leaf {
  key: MenuRouteKey;
  icon: React.ReactNode;
  label: string;
}
export interface Group {
  key: string; // 分类 key（不以 / 开头 → 不可导航，仅展开/收起）
  icon: React.ReactNode;
  label: string;
  children: Leaf[];
}
export type Node = Leaf | Group;

// 二级菜单：首页置顶单列 + 6 大类。分组按"数据进来→加工→用数→管数→运行保障→平台管理"的链路。
export const menuTree: Node[] = [
  { key: "/", icon: <HomeOutlined />, label: "首页" },
  {
    // 模块 44 — 智能中枢:贯穿全平台的 AI 能力入口(不属于任一单一模块)。置顶,与首页同区。
    // 现有 Copilot 计划中心;未来 GenBI 问数、网络/参数顾问等 AI 能力可陆续收入此组。
    key: "g-ai",
    icon: <RobotOutlined />,
    label: "智能中枢",
    children: [
      { key: "/copilot/plans", icon: <RobotOutlined />, label: "Copilot 计划中心" },
    ],
  },
  {
    key: "g-integration",
    icon: <CloudServerOutlined />,
    label: "数据集成",
    children: [
      { key: "/datasources", icon: <DatabaseOutlined />, label: "数据源管理" },
      { key: "/sync", icon: <SyncOutlined />, label: "数据同步" },
    ],
  },
  {
    key: "g-dev",
    icon: <BuildOutlined />,
    label: "数据开发",
    children: [
      { key: "/etl-jobs", icon: <CodeOutlined />, label: "离线计算" },
      { key: "/workflow", icon: <ApartmentOutlined />, label: "ETL 编排" },
      { key: "/redshift", icon: <ConsoleSqlOutlined />, label: "Redshift 查询" },
      { key: "/athena", icon: <CloudOutlined />, label: "Athena 查询" },
      { key: "/realtime-compute", icon: <ThunderboltOutlined />, label: "实时计算" },
      // @kf-batch 50-W5-seg2-WP1 — 「数据服务」leaf 已于 2026-09-05 随能力下线摘除(50 SPEC §3.9c / WP-1;页面 / 管理 API / lib 同批删)。
    ],
  },
  {
    key: "g-analytics",
    icon: <FundOutlined />,
    label: "智能分析",
    children: [
      { key: "/genbi", icon: <RobotOutlined />, label: "智能问数" },
      { key: "/skills", icon: <ApiOutlined />, label: "技能 Skills" },
      { key: "/observability", icon: <DashboardOutlined />, label: "可观测看板" },
      { key: "/bi", icon: <FundProjectionScreenOutlined />, label: "报表搭建器" },
      // 「指标中台」已收敛到「数据建模 → 指标体系」(模块39)——移除导航入口,页面/API/数据保留可回滚。
      { key: "/requirements", icon: <SolutionOutlined />, label: "需求工作台" },
    ],
  },
  {
    key: "g-governance",
    icon: <SafetyCertificateOutlined />,
    label: "数据治理",
    children: [
      { key: "/governance", icon: <SafetyCertificateOutlined />, label: "数据治理" },
      { key: "/governance-workbench", icon: <FundOutlined />, label: "治理工作台" },
      { key: "/modeling", icon: <ApartmentOutlined />, label: "数据建模" },
      { key: "/knowledge", icon: <SafetyCertificateOutlined />, label: "业务口径与规则" },
      { key: "/openmetadata", icon: <DeploymentUnitOutlined />, label: "数据治理中心" },
    ],
  },
  {
    key: "g-ops",
    icon: <FieldTimeOutlined />,
    label: "调度运维",
    children: [
      // 2026-07-13 收敛:调度管理→任务监控「调度配置」Tab;SLA→告警中心 Tab;可观测看板→智能分析组。
      // 排序=运行(monitor/backfill)→ 检测配置(alerting/finops)→ 洞察沉淀(ops/incidents)。
      { key: "/monitor", icon: <DashboardOutlined />, label: "任务监控" },
      // @kf-batch 50-P50.3-matrix — 模块 50 版本一致性矩阵(INTERACTION §3.1)。
      // 放「调度运维」组:它回答的是"要不要管"(漏发/版本不齐/失败),属运维视角;
      // 与「执行环境」(系统管理组,回答"环境建没建好")刻意分开。
      { key: "/multi-region", icon: <GlobalOutlined />, label: "多 Region 看板" },
      { key: "/backfill", icon: <HistoryOutlined />, label: "补数中心" },
      { key: "/alerting", icon: <BellOutlined />, label: "告警中心" },
      { key: "/finops", icon: <DollarCircleOutlined />, label: "成本治理 FinOps" },
      { key: "/ops", icon: <FundProjectionScreenOutlined />, label: "运维大屏" },
      { key: "/incidents", icon: <BulbOutlined />, label: "运维知识库" },
    ],
  },
  {
    key: "g-system",
    icon: <ClusterOutlined />,
    label: "系统管理",
    children: [
      { key: "/projects", icon: <AppstoreOutlined />, label: "项目空间" },
      // 模块 50 P50.2 切片 d — 执行环境管理页(多 region;INTERACTION §1)。
      { key: "/exec-envs", icon: <GlobalOutlined />, label: "执行环境" },
      { key: "/admin/users", icon: <UserOutlined />, label: "用户管理" },
      { key: "/audit", icon: <FileSearchOutlined />, label: "审计日志" },
      { key: "/settings", icon: <SettingOutlined />, label: "系统设置" },
    ],
  },
];

export function isGroup(n: Node): n is Group {
  return (n as Group).children !== undefined;
}

// @kf-batch 50-WP4-o1-scope —— 导出给 ScopeGate 与门禁用(范围能力的登记面 = 这 31 条 + capability.ts 的 9 条)。
export const menuLeaves: Leaf[] = menuTree.flatMap((n) => (isGroup(n) ? n.children : [n]));
const allLeaves: Leaf[] = menuLeaves;

// 路由 → 页签标题(结构化):base=菜单叶子中文 label(作 i18n 字典 key),
// detail=是否动态详情页。渲染处按语种翻译 base 与「·详情」后缀,故 routes 本身不含译文。
export function routeLabelParts(pathname: string): { base: string; detail: boolean } {
  const exact = allLeaves.find((l) => l.key === pathname);
  if (exact) return { base: exact.label, detail: false };
  const prefix = allLeaves
    .filter((l) => l.key !== "/" && pathname.startsWith(l.key + "/"))
    .sort((a, b) => b.key.length - a.key.length)[0];
  if (prefix) return { base: prefix.label, detail: true };
  return { base: pathname.split("/").filter(Boolean).pop() || "页面", detail: false };
}

// 路由 → 页签标题(中文成品串)。保留供非 i18n 场景/兼容使用。
export function routeLabelOf(pathname: string): string {
  const { base, detail } = routeLabelParts(pathname);
  return detail ? `${base}·详情` : base;
}
