// 新手引导「交互式导览」的门禁(用户 2026-09-14:「一步一步引导人家…第一步点击什么,然后下一步…」)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { JOURNEYS } from "@/lib/guide/content";
import {
  expandJourney, journeyByKey, navTestId, readProgress,
  unanchoredSteps, TOUR_UNANCHORED_LIMIT, TOUR_PROGRESS_KEY,
  anchorIsUsable, anchorRectSignature, anchorSettled, shouldAdvanceAfterNavigation, tourStepAt,
  missingAnchorAdvice,
} from "@/lib/guide/tour";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1 ");

describe("🔴 导览由既有 JOURNEYS 展开(一份内容两种呈现,不另造一套脚本)", () => {
  it("每条动线都能展开;每个动线步至少产出一个「点这里进这一页」步", () => {
    for (const j of JOURNEYS) {
      const steps = expandJourney(j);
      expect(steps.length, j.key).toBeGreaterThanOrEqual(j.steps.length);
      const navs = steps.filter((s) => s.kind === "nav");
      expect(navs.length, "每个动线步恰好一个 nav 步").toBe(j.steps.length);
      for (let i = 0; i < navs.length; i++) {
        expect(navs[i].testid).toBe(navTestId(j.steps[i].path));
        expect(navs[i].title).toContain(`${i + 1}.`); // 进度感:标题带序号
      }
    }
  });

  it("给了 `target` 的动线步会多出一个「就点这里」步,且锚在该页真实控件上", () => {
    const dev = journeyByKey("dev")!;
    const steps = expandJourney(dev);
    const actions = steps.filter((s) => s.kind === "action");
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      // 🔴 锚点必须**真的存在**于代码里(凭想象写 testid ⇒ 用户看到的是「控件找不到」)
      const hits = execSyncGrep(a.testid);
      expect(hits.length, `锚点 ${a.testid} 在全仓找不到 ⇒ 导览这一步永远高亮不到`).toBeGreaterThan(0);
      expect(a.path.startsWith("/")).toBe(true);
    }
  });

  it("🔴 菜单锚点由 Sidebar 统一给(nav-<key>),不许赌 antd 的 data-menu-id", () => {
    const sb = strip(read("components/layout/Sidebar.tsx"));
    expect(sb).toContain('data-testid={`nav-${key}`}');
    expect(sb, "赌框架内部属性 = 它随版本变").not.toContain("data-menu-id");
    // 🔴 **两个分支都要用上**(分组的子项 + 顶层叶子)—— 只接一处就有一半菜单没锚点。
    //    断**恰好 2 个调用点**,不是「>= N」(我第一版写 >=3 把定义行也算进去了,被这条自己逮到)
    expect((sb.match(/label: navLabel\(/g) ?? []).length, "两个分支各一个调用点").toBe(2);
  });

  it("进度读取:坏数据 ⇒ 当没有进度(不崩壳层);合法进度原样读回", () => {
    expect(readProgress(() => null)).toBeNull();
    expect(readProgress(() => "not-json")).toBeNull();
    expect(readProgress(() => JSON.stringify({ journeyKey: "nope", index: 1 })), "动线不存在 ⇒ 不认").toBeNull();
    expect(readProgress(() => JSON.stringify({ journeyKey: "dev", index: 3 }))).toEqual({ journeyKey: "dev", index: 3 });
    expect(readProgress(() => JSON.stringify({ journeyKey: "dev", index: -5 })), "负数收敛到 0").toEqual({ journeyKey: "dev", index: 0 });
  });
});

describe("🔴🔴 三条护栏:不静默跳过 / 跨页续跑不从头 / 不替用户点", () => {
  const runner = strip(read("components/guide/TourRunner.tsx"));

  it("锚点找不到 ⇒ **显式提示**并给出两个出口,不静默跳过", () => {
    expect(runner).toContain('data-testid="guide-tour-anchor-missing"');
    expect(runner).toContain('data-testid="guide-tour-skip-step"');
    expect(runner).toContain('data-testid="guide-tour-quit"');
    // 🔴🔴 **钉性质,不猜写法**:第一版写成 `not.toMatch(/if \(!el…onIndex\(index \+ 1\)/)`,
    //    而变异 X1 把自动跳过写在 `if (Date.now() > deadline) { onIndex(index + 1); …}` 里 ⇒
    //    正则压根匹配不到、**变异存活**。这是「负向断言靠猜正则 = 空断言」的第三次(今天第三次)。
    // 正解两条:① 响亮那一支**必须存在**;② **切出锚点探测那段 effect**,断它里面一个 onIndex 都没有
    //    (自动前进只许由用户点按钮触发)。
    expect(runner, "缺锚点时必须显式进入 missing 态").toContain('setStatus("missing")');
    const i = runner.indexOf("const deadline");
    expect(i, "找不到锚点探测那段 ⇒ 形状变了,请同步本门禁").toBeGreaterThan(-1);
    const detect = runner.slice(i, runner.indexOf("return () => { cancelled = true; };", i));
    expect(detect.length).toBeGreaterThan(80);
    expect(detect, "锚点探测里出现 onIndex ⇒ 它在替用户静默前进").not.toContain("onIndex(");
  });

  it("🔴🔴 锚点没稳定之前**不许挂出 Tour**(antd 只在挂出那一瞬量目标,量歪了不会自纠)", () => {
    expect(runner, "三态:pending / ready / missing").toContain('useState<"pending" | "ready" | "missing">("pending")');
    expect(runner, "只有 ready 才渲染 Tour").toMatch(/if \(status !== "ready"\) return null;/);
    // 🔴 「稳定了」必须是一次**状态变化**:沿用 `setMissing(null)` 那种写法(值没变 ⇒ React 不重渲染)
    //    会让 Tour 再也不重量目标 ⇒ 聚光灯整步停在屏幕正中。
    expect(runner).toContain('setStatus("ready")');
    const i = runner.indexOf("const deadline");
    const detect = runner.slice(i, runner.indexOf("return () => { cancelled = true; };", i));
    expect(detect, "放行只能置 ready,不许在探测里直接渲染/置别的态").not.toContain('setStatus("pending")');
  });

  it("跨页续跑:`action` 步不在目标页 ⇒ 先导航,**不重置 index**", () => {
    expect(runner).toContain('if (cur.kind === "action" && pathname !== cur.path)');
    expect(runner).toContain("router.push(cur.path)");
    expect(runner, "导航后把 index 归零 = 每换一页都从头讲一遍").not.toMatch(/router\.push\([^)]*\);\s*onIndex\(0\)/);
    const gp = strip(read("components/guide/GuideProvider.tsx"));
    expect(gp).toContain("readProgress(");
    expect(gp).toContain("TOUR_PROGRESS_KEY");
  });

  it("🔴 导览**只高亮不代点**(替用户点会在真环境造出他没同意的副作用)", () => {
    expect(runner, "出现 el.click() = 导览在替用户操作").not.toMatch(/\.click\(\)/);
  });

  it("进度可见(第 N / M 步)+ 有上一步/跳过(antd Tour 自带,这里钉住指示器)", () => {
    expect(runner).toContain('data-testid="guide-tour-indicator"');
    expect(runner).toContain("第 ${i + 1} / ${steps.length} 步");
  });

  it("入口三处都走同一个 startTour(首次进站 / 首页卡 / 说明书抽屉)", () => {
    const gp = strip(read("components/guide/GuideProvider.tsx"));
    expect(gp, "首次进站要**直接开导览**,不再只弹说明书").toContain('setTourJourney("dev")');
    expect(strip(read("components/guide/GuideHomeCard.tsx"))).toContain('data-testid="guide-home-tour"');
    expect(strip(read("components/guide/OperationGuideDrawer.tsx"))).toContain("guide-start-tour-");
  });
});

describe("🔴 棘轮:还没有页内锚点的动线步只减不增", () => {
  it("实数必须恰好等于上限(修好一处就把数字改小;新长出一处 ⇒ 红)", () => {
    const left = unanchoredSteps();
    expect(
      left.length,
      `还有 ${left.length} 个动线步只能走到「进这一页」就停住:\n` +
        left.map((x) => `  ${x.journeyKey} / ${x.title}(${x.path})`).join("\n") +
        `\n⇒ 给那一页的主控件加 data-testid 并填进 JourneyStep.target,然后把 TOUR_UNANCHORED_LIMIT 改小`
    ).toBe(TOUR_UNANCHORED_LIMIT);
  });
  it("上限不许被悄悄放大", () => {
    expect(TOUR_UNANCHORED_LIMIT, "只减不增:已归 0").toBeLessThanOrEqual(0);
  });
});

// 部署后真环境抓到的两个缺口(见 ACCEPTANCE §8septtricies)
describe("🔴🔴 锚点「找到了」≠「看得见」", () => {
  it("只有找到 + 可见 + 有面积才算能打聚光灯", () => {
    expect(anchorIsUsable({ found: true, width: 60, height: 16, hidden: false })).toBe(true);
    expect(anchorIsUsable({ found: false, width: 0, height: 0, hidden: true }), "压根没找到").toBe(false);
    // 🔴 这一条对应真实故障:antd inline 菜单**收起过**的分类会把子项留在 DOM 里(display:none)⇒
    //    只判「找到了」会让聚光灯静默打在 0×0 的位置,用户以为导览指的就是那儿(比诚实报错更坏)。
    expect(anchorIsUsable({ found: true, width: 0, height: 0, hidden: true }), "在 DOM 里但渲染不出来").toBe(false);
    expect(anchorIsUsable({ found: true, width: 60, height: 16, hidden: true }), "有 rect 但祖先隐藏").toBe(false);
    expect(anchorIsUsable({ found: true, width: 0, height: 16, hidden: false }), "宽度 0").toBe(false);
    expect(anchorIsUsable({ found: true, width: 60, height: 0, hidden: false }), "高度 0").toBe(false);
  });

  it("TourRunner 的判据是**可用性**,不是「querySelector 有没有返回」", () => {
    const src = strip(read("components/guide/TourRunner.tsx"));
    const i = src.indexOf("const deadline");
    const detect = src.slice(i, src.indexOf("return () => { cancelled = true; };", i));
    expect(detect, "探测循环必须量测这一步的锚点").toContain("probeAnchor(cur.testid)");
    expect(detect, "放行判据必须是「稳定可用」(anchorSettled 内含可用性)").toContain("anchorSettled(");
    expect(detect, "只判元素在不在 ⇒ 隐藏元素会被当成可用").not.toMatch(/if \(elFor\(/);
    // 🔴 antd 的 `target` 回调也要过同一道判定(否则别的步仍会高亮隐藏元素)
    expect(src).toContain("target: () => usableElFor(s.testid)");
    // fixed 定位的元素 offsetParent 也是 null ⇒ 必须排除,否则弹层里的锚点被误判成缺失
    expect(src).toContain('window.getComputedStyle(el).position === "fixed"');
  });

  it("🔴 位置**稳定**才放行(菜单展开动画中途量到 ⇒ 聚光灯一直偏着,rc-tour 没有 ResizeObserver 不会自纠)", () => {
    const ok = { found: true, x: 52, y: 300, width: 60, height: 16, hidden: false };
    expect(anchorSettled(anchorRectSignature(ok), ok), "两次量到同一个位置 ⇒ 稳了").toBe(true);
    expect(anchorSettled(null, ok), "第一次量到就放行 ⇒ 可能正在动画中途").toBe(false);
    expect(anchorSettled(anchorRectSignature({ ...ok, y: 288 }), ok), "位置还在动 ⇒ 不放行").toBe(false);
    expect(anchorSettled(anchorRectSignature(ok), { ...ok, hidden: true }), "不可用一律不放行").toBe(false);
    // 签名取整到 1px:亚像素抖动不该被当成「还在动」
    expect(anchorRectSignature({ ...ok, y: 300.4 })).toBe(anchorRectSignature(ok));
    // 判别力:签名必须真的区分不同位置(常量签名会让上面几条全恒真)
    expect(anchorRectSignature({ ...ok, y: 301 })).not.toBe(anchorRectSignature(ok));
    const src = strip(read("components/guide/TourRunner.tsx"));
    expect(src, "探测循环必须用稳定判定").toContain("anchorSettled(lastSig, p)");
    expect(src, "不可用时必须把上次签名清掉,否则「隐藏→显示」会被误判成稳定").toContain("lastSig = anchorIsUsable(p) ? anchorRectSignature(p) : null;");
  });
});

describe("🔴 用户照着做了就前进 —— 但不许把「上一步」弄坏", () => {
  const base = { kind: "nav" as const, stepPath: "/sync", index: 0, total: 8 };
  it("这一步开始时不在目标页、之后到了 ⇒ 前进(用户真去点了那个菜单)", () => {
    expect(shouldAdvanceAfterNavigation({ ...base, currentPath: "/sync", enteredPath: "/" })).toBe(true);
  });
  it("🔴 进入这一步时**已经在**目标页 ⇒ 不前进(否则「上一步」退回来会被立刻又推回去)", () => {
    expect(shouldAdvanceAfterNavigation({ ...base, currentPath: "/sync", enteredPath: "/sync" })).toBe(false);
  });
  it("还没到目标页 / 还没记录到起点 / 不是 nav 步 / 已是最后一步 ⇒ 都不前进", () => {
    expect(shouldAdvanceAfterNavigation({ ...base, currentPath: "/", enteredPath: "/" })).toBe(false);
    expect(shouldAdvanceAfterNavigation({ ...base, currentPath: "/sync", enteredPath: null })).toBe(false);
    expect(shouldAdvanceAfterNavigation({ ...base, kind: "action", currentPath: "/sync", enteredPath: "/" })).toBe(false);
    expect(shouldAdvanceAfterNavigation({ ...base, currentPath: "/sync", enteredPath: "/", index: 7 })).toBe(false);
  });
  it("组件必须走这条**单一作者**的规则(内联条件写错一个字就没人看得见)", () => {
    const src = strip(read("components/guide/TourRunner.tsx"));
    expect(src).toContain("shouldAdvanceAfterNavigation({");
    expect(src, "起点必须来自 ref(每次步变化时记一次),不是当前 pathname").toContain("enteredPath: stepEnteredPath.current");
    expect(src, "记起点的 effect 必须只依赖步的变化").toMatch(/stepEnteredPath\.current = pathname;[\s\S]{0,120}\}, \[index, journeyKey\]\)/);
  });
  it("tourStepAt:越界 / 没在导览 ⇒ null(Sidebar 靠它拿当前步的 path)", () => {
    expect(tourStepAt(null, 0)).toBeNull();
    expect(tourStepAt("nope", 0)).toBeNull();
    expect(tourStepAt("dev", 999)).toBeNull();
    const s0 = tourStepAt("dev", 0)!;
    expect(s0.kind).toBe("nav");
    expect(s0.testid).toBe(navTestId(journeyByKey("dev")!.steps[0].path));
  });
});

describe("🔴 导览的出口是**我们自己的**控件", () => {
  it("有一个带稳定锚点的「跳过导览」(antd 面板关闭图标是否渲染取决于框架默认值)", () => {
    const src = strip(read("components/guide/TourRunner.tsx"));
    expect(src).toContain('data-testid="guide-tour-skip"');
    // 出口必须真的**结束**导览,不是只前进一步
    const i = src.indexOf('data-testid="guide-tour-skip"');
    expect(src.slice(i, i + 200)).toContain("onClick={close}");
    expect(src, "自带指示器与默认按钮都要留着(上一步/下一步)").toContain("{originNode}");
  });
});

/** 全仓找某个 data-testid(用来证明导览锚点真的存在)。 */
function execSyncGrep(testid: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  try {
    return execFileSync("grep", ["-rl", `data-testid="${testid}"`, "--include=*.tsx", SRC], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("🔴🔴 锚点缺失时说什么:ScopeGate 是**可解的页面状态**,不许说成「没接入锚点」", () => {
  const base = { index: 1, total: 12, title: "自然语言问数", testid: "genbi-ask-input" };

  it("页面处于「请选择执行范围」空壳时 ⇒ 给这一页真正的下一步(去顶栏选一个区)", () => {
    const a = missingAnchorAdvice({ ...base, scopeGated: true });
    expect(a.kind).toBe("need-scope");
    expect(a.headline).toContain("先选定一个执行范围");
    expect(a.what).toContain("单个");
    expect(a.next).toContain("顶栏");
    // 🔴 不许再冒出那句泛泛的猜测(它把新用户带进死胡同)
    expect(a.what + a.next).not.toContain("还没接入导览锚点");
    expect(a.what + a.next).not.toContain("对当前角色不可见");
    // 🔴 规则不变:只指路不代选
    expect(a.next).toContain("不会替你选");
  });

  it("反例:页面**不是**那个空壳时 ⇒ 照旧给通用三种可能(不许把所有缺锚点都说成缺范围)", () => {
    const a = missingAnchorAdvice({ ...base, scopeGated: false });
    expect(a.kind).toBe("generic");
    expect(a.headline).toContain("控件当前不在页面上");
    expect(a.what).toContain("genbi-ask-input");
    expect(a.next).toContain("还没接入导览锚点");
    expect(a.headline).not.toContain("执行范围");
  });

  it("两种话都必须**说清是第几步**(用户要能对上气泡上的进度)", () => {
    for (const gated of [true, false]) {
      expect(missingAnchorAdvice({ ...base, scopeGated: gated }).headline).toContain("第 2/12 步");
    }
  });

  it("🔴 组件真的用了这个纯函数(而不是又内联一套文案)+ 认的事实是 `scope-need-target`", () => {
    const src = strip(read("components/guide/TourRunner.tsx"));
    expect(src).toContain("missingAnchorAdvice(");
    expect(src).toContain('data-testid="scope-need-target"');
    // 组件里不许再出现自己拼的那两句(单一作者)
    expect(src).not.toContain("还没接入导览锚点 /");
    // testid 是按 kind 三元选的 ⇒ 断字面量本身(别断整段 `data-testid="…"`,那样只是在猜写法)
    expect(src).toContain('"guide-tour-need-scope"');
    expect(src).toContain('"guide-tour-anchor-what"');
  });
});
