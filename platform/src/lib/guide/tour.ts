// 新手引导的**交互式导览**纯逻辑(单一作者)。
//
// 用户 2026-09-14 原话:「我要的新手指引是那种一步一步引导人家的,不是给一个操作说明放在那里不动的东西……
// 会给使用者看到第一步点击什么,然后下一步操作再点击什么」⇒ 形态 = **产品导览**:
// 聚光灯高亮**真实控件** + 气泡写这一步做什么 + 上一步/下一步/跳过 + 进度 + **跨页续跑**。
//
// 🔴 内容**不另造一套**:直接展开既有的 `JOURNEYS`(角色动线,说明书抽屉也在用它)——
//    一份内容两种呈现。另写一份导览脚本 = 两处各自漂移(change-safety A1)。
// 🔴 每个动线步展开成 1–2 个导览步:
//    ① `nav`    高亮左侧菜单那一项(「点这里进入 X」)—— 锚点 `nav-<path>` 由 Sidebar 统一给;
//    ② `action` 导航到该页后再高亮**页面上那个控件**(仅当动线步给了 `target`)。
// 🔴 找不到锚点时**不许静默跳过** —— 静默跳过会让用户以为导览走完了(见 TourRunner 的显式提示)。
import { JOURNEYS, type Journey, type JourneyStep } from "./content";

export const TOUR_PROGRESS_KEY = "bgp-tour-progress";
export const TOUR_DONE_KEY = "bgp-tour-done";

export type TourStepKind = "nav" | "action";

export interface TourStep {
  journeyKey: Journey["key"];
  kind: TourStepKind;
  /** 这一步要停在哪个页面(`nav` 步不要求已在该页;`action` 步要求)。 */
  path: string;
  /** 要高亮的元素的 `data-testid`。 */
  testid: string;
  title: string;
  body: string;
}

export function navTestId(path: string): string {
  return `nav-${path}`;
}

/** 把一条角色动线展开成导览步序列。 */
export function expandJourney(j: Journey): TourStep[] {
  const out: TourStep[] = [];
  j.steps.forEach((s: JourneyStep, i) => {
    out.push({
      journeyKey: j.key,
      kind: "nav",
      path: s.path,
      testid: navTestId(s.path),
      title: `${i + 1}. ${s.title}`,
      body: `先点左侧菜单进入这一页。${s.desc}`,
    });
    if (s.target) {
      out.push({
        journeyKey: j.key,
        kind: "action",
        path: s.path,
        testid: s.target,
        title: `${i + 1}. ${s.title} —— 就点这里`,
        body: s.hint || s.desc,
      });
    }
  });
  return out;
}

export function journeyByKey(key: string): Journey | null {
  return JOURNEYS.find((j) => j.key === key) ?? null;
}

/** 某条动线的第 `index` 步(越界 ⇒ null)。Sidebar 与 TourRunner 共用同一个展开结果,不各算一遍。 */
export function tourStepAt(journeyKey: string | null | undefined, index: number): TourStep | null {
  const j = journeyKey ? journeyByKey(journeyKey) : null;
  if (!j) return null;
  return expandJourney(j)[index] ?? null;
}

/**
 * 锚点的**量测结果**。DOM 相关的取值留给组件,判定规则留在这里(可单测)。
 */
export interface AnchorProbe {
  /** 选择器有没有找到元素。 */
  found: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 元素在文档里但**渲染不出来**(祖先 display:none / 折叠的菜单分类等)。 */
  hidden: boolean;
}

/** 位置签名(取整到 1px):用来判断「量到的 rect 还在动没有」。 */
export function anchorRectSignature(p: AnchorProbe): string {
  return [p.x, p.y, p.width, p.height].map((n) => Math.round(n)).join("|");
}

/**
 * 🔴 锚点是否**稳定可用** —— 可用 **且** 与上一次量到的位置一致。
 *
 * 为什么必须等稳定:菜单分类展开是有动画的(inline SubMenu 动画 ~0.2s,子项的 y 一直在动),
 * 而 `@rc-component/tour` 量目标只在 `open`/`resize`/`scroll` 时做一次(**没有 ResizeObserver**)
 * ⇒ 中途量到的位置会**一直偏着不自纠**:聚光灯罩在两个菜单项之间,气泡指着错的东西。
 */
export function anchorSettled(prevSignature: string | null, p: AnchorProbe): boolean {
  return anchorIsUsable(p) && prevSignature !== null && prevSignature === anchorRectSignature(p);
}

/**
 * 🔴 这一步的锚点能不能用来打聚光灯。
 * 「找到了元素」**不等于**「它在页面上看得见」:antd inline 菜单收起过的分类会把子项留在 DOM 里
 * 但 `display:none`(rect 0×0)⇒ 只判 `found` 会让聚光灯**静默打在左上角/错的位置**,
 * 比诚实地报「控件不在页面上」更坏(用户以为导览指的就是那里)。
 */
export function anchorIsUsable(p: AnchorProbe): boolean {
  return p.found && !p.hidden && p.width > 0 && p.height > 0;
}

/**
 * 用户**照着做了** ⇒ 该不该自动前进一步(nav 步说的是「点左侧菜单进入这一页」)。
 *
 * 🔴 两种情形必须分开,否则「上一步」会当场失效:
 *   · 这一步开始时**不在**目标页、之后到了 ⇒ 用户真去点了 ⇒ 前进;
 *   · 进入这一步时**已经在**目标页(最典型:用「上一步」退回一个走过的 nav 步)⇒ 不前进,
 *     否则会被立刻又推回去,用户按不动上一步。
 * 🔴 最后一步不再前进(前进过界会把索引推出 steps 之外 ⇒ 导览无声消失)。
 */
export function shouldAdvanceAfterNavigation(p: {
  kind: TourStepKind;
  stepPath: string;
  currentPath: string;
  /** 这一步**开始时**所在的页面(null = 还没记录到)。 */
  enteredPath: string | null;
  index: number;
  total: number;
}): boolean {
  if (p.kind !== "nav") return false;
  if (p.currentPath !== p.stepPath) return false;
  if (p.enteredPath === null || p.enteredPath === p.stepPath) return false;
  return p.index < p.total - 1;
}

export interface TourProgress {
  journeyKey: Journey["key"];
  index: number;
}

export function readProgress(read: (k: string) => string | null): TourProgress | null {
  try {
    const raw = read(TOUR_PROGRESS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as TourProgress;
    if (!p || typeof p.index !== "number" || !journeyByKey(String(p.journeyKey))) return null;
    return { journeyKey: p.journeyKey, index: Math.max(0, Math.floor(p.index)) };
  } catch {
    // 🔴 存的东西坏了 ⇒ 当没有进度(而不是崩掉整个壳层);但**不静默重置**别的键
    return null;
  }
}

/**
 * 🔴 **还没有页内锚点的动线步** —— 棘轮 `TOUR_UNANCHORED_LIMIT` 数的就是它。
 * 只减不增:每给一页的主控件加上 `data-testid` 并填进 `target`,这个数就少一个。
 * 它代表「导览只走到『进这一页』就停住」的步数 —— 是**已知缺口**,不是完整导览。
 */
export function unanchoredSteps(): Array<{ journeyKey: string; title: string; path: string }> {
  const out: Array<{ journeyKey: string; title: string; path: string }> = [];
  for (const j of JOURNEYS) {
    for (const s of j.steps) if (!s.target) out.push({ journeyKey: j.key, title: s.title, path: s.path });
  }
  return out;
}

/**
 * 只减不增。当前值 = 现网真实欠账数;改小才允许提交。
 * **归 0**(2026-09-14):16 个动线步全部配上了页内锚点,
 * 每一步都会高亮那一页上**无条件渲染**的主控件(逐页新加 11 个 `data-testid`)。
 * 🔴 归 0 之后这条棘轮的作用变成**防回退**:谁新增一个没有 `target` 的动线步就会红。
 */
export const TOUR_UNANCHORED_LIMIT = 0;

/** 锚点缺失时给什么话 —— 纯函数,便于离线钉住(渲染只负责把它显示出来)。 */
export type MissingAnchorAdvice = {
  kind: "need-scope" | "generic";
  /** 顶部一行(Alert message) */
  headline: string;
  /** 这一步到底怎么了 */
  what: string;
  /** 下一步动作 / 常见原因 */
  next: string;
};

/**
 * 🔴 2026-09-15 真环境(段 `guide` GT-11)抓到的一类**可解页面状态**:
 * 业务分析动线第一步要高亮 `/genbi` 的问数输入框,而那一页是 **target-only** ——
 * 当前执行范围是「全部」时整页只渲染 ScopeGate 的「请选择执行范围」(`scope-need-target`),
 * 输入框压根不在 DOM 里。产品两边都没错(问数必须锚定一个区),错在导览把它说成
 * 「这一页还没接入导览锚点 / 该功能对当前角色不可见」—— 一句泛泛的猜测,把新用户带进死胡同。
 *
 * ⇒ 认出这个状态,给**这一页真正的下一步动作**;规则不变:导览只指路,**绝不替用户选**
 * (选哪个区决定接下来问的是哪一份数据)。
 */
export function missingAnchorAdvice(input: {
  index: number;
  total: number;
  title: string;
  testid: string;
  /** 页面上是否存在 ScopeGate 的「请选择执行范围」空壳 */
  scopeGated: boolean;
}): MissingAnchorAdvice {
  const pos = `第 ${input.index + 1}/${input.total} 步`;
  if (input.scopeGated) {
    return {
      kind: "need-scope",
      headline: `${pos}:这一页要先选定一个执行范围`,
      what: `「${input.title}」要用的控件在这一页,但这一页必须锚定**单个**执行环境才会渲染 —— 当前是「全部」。`,
      next: "去顶栏「执行范围」里选一个区,这一步就会自己出来;导览不会替你选 —— 选哪个区决定了接下来问的是哪一份数据。",
    };
  }
  return {
    kind: "generic",
    headline: `${pos}的控件当前不在页面上`,
    what: `「${input.title}」要高亮的是 ${input.testid},但这一页现在找不到它。`,
    next: "常见原因:这一页还没接入导览锚点 / 该功能对当前角色不可见 / 需要先选中一条记录。导览**不会**替你跳过 —— 你可以自己跳过这一步,或结束导览。",
  };
}
