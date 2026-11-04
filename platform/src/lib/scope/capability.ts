// @kf-batch 50-WP4-o1-scope
// WP-4 O1 —— 「每个路由支持哪种执行范围」的类型与登记表(合同 SPEC v3.35 §2.6.7;矩阵 INTERACTION §9.6)。
//
// 🔴 本文件**零 React 依赖**(菜单树在 `components/layout/routes.tsx`,那边引本文件的类型),
// 解析函数用**注入叶子列表**的形式,避免与菜单树互相 import 成环。

/**
 * 路由的**基础**范围能力(设计意图):
 * · `global-and-target` —— 既能看「全部」,也能只看一个执行范围
 * · `target-only`       —— 必须锚定一个执行范围(如问数:单 region 执行 + 用该区模型)
 * · `global-only`       —— 全局控制平面,**不受**当前执行范围影响(如执行环境管理页)
 *
 * 🔴 **v3.36 订正:`compare` 不在本 union 里** —— 一个页面「能否只看一个区」与「能否做多区对比」
 * 是**两件独立的事**(`/finops` 两者都成立)。塞进同一个字段就必须二选一,那会让矩阵说假话。
 * 故对比能力单独用可选字段 `scopeCompare` 表达。
 */
import { MENU_ROUTE_SCOPE, menuRouteScope } from "./route-scope";

export const SCOPE_CAPABILITIES = ["global-and-target", "target-only", "global-only"] as const;
export type ScopeCapability = (typeof SCOPE_CAPABILITIES)[number];

// @kf-batch 50-WP4ter-coverage
// ── 🔴🔴 2026-09-10 用户拍板后的重做:`scopeWired: boolean` 已删,改**判别联合** ──────────
// 用户原话:「这些都有问题,你都必须要覆盖到,我不想再说第二次」,点名的**两句横幅都在内**
// (既否「尚未按执行范围过滤」,**也否**「此页属于全局控制平面,不受影响」)。
//
// 旧类型的病:`scopeWired: false` **零成本** —— 加一页只要写个 false,横幅还替它把话说圆了,
// 没人再回来接;`global-only` 更省事,一句断言就把整页豁免掉(实测 `/settings` 就是这么
// 把 home 的 Redshift 工作组 / Glue 桶 / MWAA 桶 / VPC 当「平台配置」给所有区看的 —— 那是**撒谎**,
// 比「尚未过滤」更坏,因为它明确否认自己与区有关)。
//
// ⇒ 三种形态各带**强制字段**,写不出「沉默的豁免」:
//   ① 已接入        `wired: true`
//   ② 还没接入      `wired: false` + `ticket`(SC-n,必须在 WP-4ter ③ 台账里) + `missing`(差什么,直接渲染给用户看)
//   ③ 真全局        `globalReason`(**登记过的理由码**,不是自由文本 ⇒ 编不出理由就说明它不是全局) + `insteadSee`(按区的东西去哪看)
// 门禁 `scope-coverage-guard` 另加**棘轮**:② 的条数只减不增(WP-4ter ②③)。

/**
 * `global-only` 的**理由码**(封闭集合)。
 *
 * 🔴 为什么不是自由字符串:自由文本可以写「本页是全局的」这种同义反复,豁免就又变成零成本。
 * 收成枚举之后,新页要么能对上其中一条(那它确实与区无关),要么对不上 —— 对不上就是**它该接入**。
 * 文案在这里一处定义,横幅直接渲染它(用户看到的是**理由**,不再是断言)。
 */
export const GLOBAL_REASONS = {
  /** 管的就是「区」本身 */
  "manages-regions": "本页管理的就是「执行环境(区域)」本身 —— 它是执行范围的定义者,自然不被执行范围过滤",
  /** 本身就是跨区视图 */
  "cross-region-view": "本页本身就是跨区域对照视图,按单个区过滤等于让它自己过滤掉自己要对照的东西",
  /** 身份/账号单池 */
  "identity-global": "身份与权限是单一用户池的全局资源,没有区域维度(跨法域的身份隔离另有专项,见 50 SPEC §6.4)",
  /** 纯前端 */
  "frontend-only": "纯前端样式预览页,不读任何业务数据,也不产生任何区内执行",
  /** 只存文本定义 */
  "doc-only": "本页只存文字定义(需求 / 说明),不产生任何区内执行或落地物",
  /**
   * @kf-batch 50-WP4ter-coverage
   * **全平台只有一份**的定义。🔴 这条理由码有严格的成立条件:该定义**不存在按区的副本**,
   * 所有区共用同一份(例:业务口径与规则 —— 用户 2026-09-10 拍板「都走同一个 AgentCore」,
   * 记忆与技能全区共用 ⇒ 口径本来就只有一份)。
   * 🔴 不许拿它当挡箭牌:只要该页面显示了任何**按区会不同**的东西(状态 / 用量 / 落地情况),
   * 它就不适用 —— 那种页面该接入,并用 `partial` 说明哪几块不分区。
   */
  "platform-wide-definition":
    "本页存的是**全平台只有一份**的定义(所有执行环境共用同一份,不存在按区的副本)—— 所以它没有「按区看」这回事",
  /**
   * @kf-batch 50-WP4quater-reads(工单 SC-14)
   * **纯 URL 兼容跳转页**:自己不读任何数据,只把用户 replace 到真正那一页。
   * 🔴 成立条件很窄:文件里除了 `router.replace(...)` 不许有任何取数;
   * 而且 `insteadSee` 必须指向那个**真页面**(它自己得是已按范围过滤的)——
   * 否则这条理由码就变成了「把欠账藏到跳转后面」。门禁 `scope-redirect-guard` 钉住这两条。
   */
  "redirect-only":
    "本页只是旧 URL 的兼容跳转(不读任何数据,立即 replace 到真正那一页)—— 按区过滤要看的是跳转目标那一页",
} as const;
export type GlobalReasonCode = keyof typeof GLOBAL_REASONS;

/** 未接入工单号:必须是 `SC-<数字>`(台账 = WORK-PACKAGES WP-4ter ③ / ACCEPTANCE 段 `sc`)。 */
export type ScopeTicket = `SC-${number}`;

/**
 * ① 已按执行范围过滤。
 *
 * @param partial @kf-batch 50-WP4ter-coverage —— **部分接入**必须登记在这里,不许只写在页面正文里。
 * 理由:「整页已按区过滤」与「这页有几块还不分区」是两件事,而**部分**才是常态
 * (`/modeling` 六个 Tab 只有两个有区域维;`/finops` 四个 Tab 里账单大盘按区要重新采集)。
 * 藏进页面正文 = 又一处「界面说了但没结构化、下一个人接手就漏」⇒ 正是用户 2026-09-10 抱怨的形态。
 * 登记在这里的好处:ScopeGate 统一渲染一条**常驻**说明条 + 门禁能核对它有没有归宿(ticket)。
 */
export interface ScopeDeclWired {
  scope: "global-and-target" | "target-only";
  wired: true;
  partial?: {
    /** 哪几块还不分区 + 为什么(直接给用户看) */
    note: string;
    /** 有欠账就写工单号(纯设计使然、不打算改的不用写) */
    ticket?: ScopeTicket;
  };
  scopeCompare?: true;
}

/**
 * ② 还没接入。**必须**说清工单号与差什么 —— 横幅渲染的就是这两样,
 * 用户看到的不再是一句放之四海皆准的「尚未过滤」,而是「差什么、归哪个工单」。
 */
export interface ScopeDeclNotWired {
  scope: "global-and-target" | "target-only";
  wired: false;
  ticket: ScopeTicket;
  /** 差什么(一句话,直接给用户看;不许写「待接入」这种同义反复) */
  missing: string;
  scopeCompare?: true;
}

/** ③ 真全局:理由码 + 「按区的东西去哪看」(`self` = 本页自己就是那个地方)。 */
export interface ScopeDeclGlobalOnly {
  scope: "global-only";
  globalReason: GlobalReasonCode;
  /** 一个真实路由,或 `self`;门禁核对它确实存在(写错的路由 = 把用户送进 404) */
  insteadSee: string;
  scopeCompare?: true;
}

export type ScopeDecl = ScopeDeclWired | ScopeDeclNotWired | ScopeDeclGlobalOnly;

export function isGlobalOnly(d: ScopeDecl): d is ScopeDeclGlobalOnly {
  return d.scope === "global-only";
}
/** 「这一页的数据是否已按执行范围过滤」。🔴 `global-only` 不参与这个问题(它没有要过滤的区维)。 */
export function isNotWired(d: ScopeDecl): d is ScopeDeclNotWired {
  return d.scope !== "global-only" && d.wired === false;
}
/** 已接入但有「这几块不分区」的登记。 */
export function partialOf(d: ScopeDecl): { note: string; ticket?: ScopeTicket } | null {
  if (d.scope === "global-only" || d.wired !== true) return null;
  return d.partial ?? null;
}

/** 不挂 ScopeGate 的路由(唯一白名单:未登录态没有项目、也没有范围)。 */
export const NO_GATE_ROUTES = ["/login"] as const;

/**
 * 有 `page.tsx` 但**不在菜单树**里的路由 —— 它们拿不到 `Leaf`,必须在这里显式登记,
 * 否则就是「永远没人声明、默认按全部渲染」的盲区(INTERACTION §9.6 表 B)。
 *
 * · `follows` = 详情页跟随它的列表页(范围 = 该资源自己的绑定,只读回显)
 * · `no-gate` = 不挂门
 */
export type ExtraRouteDecl = ScopeDecl | { follows: string } | { noGate: true };

export const EXTRA_ROUTE_SCOPE: Record<string, ExtraRouteDecl> = {
  "/login": { noGate: true },
  // @kf-batch 50-WP4ter-coverage —— 三个非菜单页与菜单页同等对待(用户点名的 9 页之外还有这 3 页)
  // @kf-batch 50-WP4quater-reads(工单 SC-13)—— 已接入。诊断复核后发现:**计算路径本来就按区**
  // (`computeMetric(metricId, scope)` + 两条 compute 路由早就收 `body.targetId`),
  // 缺的只是**值的存储**没有区维 ⇒ 在 usw2 算一次就覆盖掉主控区的值,而两个数字看起来都很正常。
  // 现在值按区存(`valueByTarget` map 单键更新,不整体覆盖)+ 快照行盖 `targetId` + 读侧按区过滤
  // (不过滤的话趋势线会把两个区的值交替画成锯齿,看起来像「指标在剧烈波动」);
  // 该区没算过回 null 而**不回落 lastValue**(那是别区的数字)—— 与建模指标 SC-37 同一形状。
  "/metrics": { scope: "global-and-target", wired: true },
  // @kf-batch 50-WP4quater-reads(工单 SC-14)—— 🔴 复核后改判:本页是 **19 行的 URL 兼容跳转页**
  // (2026-07-13 调度运维收敛时并入「任务监控 → 调度配置」Tab,菜单入口已移除),
  // 自己不读任何数据。真正的调度面板 `components/monitor/SchedulePanel.tsx` 已按执行范围过滤
  // (工单 SC-3 同批:两条列表带 `?scope=`、Airflow 入口按区、切区重拉)。
  // ⇒ 把欠账挂在这个跳转页上是记在了错的地方;真页面在 `/monitor`,那一页是 wired:true。
  "/schedule": { scope: "global-only", globalReason: "redirect-only", insteadSee: "/monitor" },
  // @kf-batch 50-WP4quater-reads(工单 SC-15)—— 已接入:SLA 行的 `targets[]` 派生自绑定对象
  // (任务 / 工作流的 targets),基线改成**每个执行区一份**(`byTarget`)并由接口摊平成「任务 × 区」。
  // 🔴 落章之前学出来的基线行没有区维 ⇒ 逐行标 `legacy: true` 如实说明,不冒充某个区的数字。
  // @kf-batch 50-WP4sexies-home-region —— 🔴 **改正一处登记表撒谎**(2026-09-11 逐页深挖抓到):
  //   `/sla` 是 19 行的 URL 兼容跳转页(`router.replace("/alerting?tab=sla")`,菜单入口 2026-07-13 已移除),
  //   压根不读执行范围,却被标成 `wired: true` ⇒ 棘轮被一个「什么都没做」的页面满足了。
  //   同类的 `/schedule` 早就是 `redirect-only`,这里一直漏改。
  //   🔴 之所以没被判据拦住:`scope-guards` 那条「wired 必须真读 useScope(」**只遍历 MENU_ROUTE_SCOPE**,
  //   EXTRA_ROUTE_SCOPE 从来没进过它的循环 —— 同刀已把遍历面补全。
  "/sla": { scope: "global-only", globalReason: "redirect-only", insteadSee: "/alerting" },
  "/sync/[id]": { follows: "/sync" },
  "/workflow/[id]": { follows: "/workflow" },
  "/theme-gallery": { scope: "global-only", globalReason: "frontend-only", insteadSee: "self" },
  "/theme-gallery/[id]": { scope: "global-only", globalReason: "frontend-only", insteadSee: "self" },
  "/theme-preview": { scope: "global-only", globalReason: "frontend-only", insteadSee: "self" },
};

export function isFollows(d: ExtraRouteDecl): d is { follows: string } {
  return typeof (d as { follows?: unknown }).follows === "string";
}
export function isNoGate(d: ExtraRouteDecl): d is { noGate: true } {
  return (d as { noGate?: unknown }).noGate === true;
}

/** 解析结果:`null` = 不挂门。 */
export type ResolvedCapability = ScopeDecl | null;


/**
 * 路由 → 能力。匹配规则**与 `routes.tsx` 的 `routeLabelParts` 完全一致**(先精确、再最长前缀),
 * 这样动态详情页 `/sync/abc` 自然继承 `/sync` —— 不另造一套路径匹配(A1)。
 *
 * 数据来自 `route-scope.ts`(纯 .ts,零 React)⇒ 与菜单树没有 import 环,门禁也 import 得动。
 */
export function capabilityForPath(pathname: string): ResolvedCapability {
  if ((NO_GATE_ROUTES as readonly string[]).includes(pathname)) return null;

  const extra = EXTRA_ROUTE_SCOPE[pathname];
  if (extra) {
    if (isNoGate(extra)) return null;
    if (isFollows(extra)) return capabilityForPath(extra.follows);
    return extra;
  }

  const exact = menuRouteScope(pathname);
  if (exact) return exact;

  const prefixKey = Object.keys(MENU_ROUTE_SCOPE)
    .filter((k) => k !== "/" && pathname.startsWith(k + "/"))
    .sort((a, b) => b.length - a.length)[0];
  if (prefixKey) return menuRouteScope(prefixKey)!;

  // 🔴 兜底**不是**「已接入」:未知路由按未接入处理,至少会挂上提示条,而不是假装自己过滤过了。
  // @kf-batch 50-WP4ter-coverage —— 兜底也要说得出「差什么」:它差的就是「没人登记过它」。
  return {
    scope: "global-and-target",
    wired: false,
    ticket: "SC-16",
    missing: `这个路由(${pathname})没有在执行范围能力表里登记过 —— 谁也没声明它按不按区过滤(门禁 scope-coverage-guard 会红)`,
  };
}
