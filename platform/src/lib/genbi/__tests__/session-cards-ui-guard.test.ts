// @kf-batch 54-genbi-session-cards
// 前端结构性门禁:把 50 INTERACTION v2.30 §9.7(护栏 7)那七条里**最容易做错的**几条钉在源码上。
// 🔴 为什么用源码断言而不是渲染测试:这几条的本质是「有没有接上」(wiring),而渲染测试很容易
//    因为 antd 版本 / locale 变化假红 —— 本仓已为此栽过多次(见 verify-script-quality-lesson)。
//    真正的行为由无头段 `gbc` 的 GC-10 / GC-14 在真环境断。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const page = strip(readFileSync(resolve(SRC, "app/genbi/page.tsx"), "utf8"));
const comp = strip(readFileSync(resolve(SRC, "../src/components/genbi/SessionCards.tsx"), "utf8"));

describe("54 会话卡片 · 前端接线(§9.7 护栏 7)", () => {
  it("保存入口与「提为需求」**同级**(用户原话),且文案是「保存对话」不是「保存卡片」", () => {
    expect(page).toMatch(/onSaveCard/);
    expect(page).toMatch(/保存对话/);
    // 两个按钮在同一个操作区
    expect(comp.length + page.length).toBeGreaterThan(0);
    expect(page).toMatch(/genbi-save-card-btn/);
    expect(page).toMatch(/提为需求/);
  });

  it("🔴 §9.7 第 1 条:**绝不静默切范围** —— `setScope` 只许出现在用户点了「切区并继续」那条回调里", () => {
    const calls = page.match(/setScope\(/g) || [];
    expect(calls.length, "setScope 被调了多处 ⇒ 有一处可能是自动切换").toBe(1);
    // 那一处必须在 onSwitchAndResume 里
    const idx = page.indexOf("onSwitchAndResume");
    const call = page.indexOf("setScope(");
    expect(idx).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(idx);
  });

  it("🔴 §9.7 第 6 条:选「只读查看」**不调 resume 接口**(拒绝切区零副作用)", () => {
    // openCard 里 `resume` 为假时必须提前 return,不许走到 doResume
    expect(page).toMatch(/if \(!resume\) \{[^}]*setReadOnlyCard\(card\);\s*return;/);
  });

  it("🔴 §9.7 第 4 条:只读态**既 disable 又给原因**(缺哪一半都不行)", () => {
    // 🔴 变异 U3 曾**存活**:原来只写 `toMatch(/disabled=\{!!readOnlyCard\}/)` —— 发送键上也有同一串,
    //    于是把**提问框**那处删掉仍然匹配得到。⇒ 必须**逐个锚定**(取该控件所在的那一小段源码),
    //    并断总数。这是本仓「负向/存在性断言必须有判别力」那一族的第三次犯。
    const inputSeg = page.slice(page.indexOf("Input.TextArea value={question}"), page.indexOf("onPressEnter"));
    expect(inputSeg, "提问框没有 disabled ⇒ 只读态照样能问,而问的是**错的区**").toMatch(/disabled=\{!!readOnlyCard\}/);
    const sendSeg = page.slice(page.indexOf("genbi-send-btn") - 200, page.indexOf("genbi-send-btn") + 120);
    expect(sendSeg, "发送键没有 disabled").toMatch(/disabled=\{!!readOnlyCard\}/);
    expect((page.match(/disabled=\{!!readOnlyCard\}/g) || []).length, "两处都要有(提问框 + 发送键)").toBe(2);
    expect(page).toMatch(/genbi-card-readonly-note/);              // 原因 + 保留切区入口
    expect(page).toMatch(/切区并继续/);
  });

  it("🔴 §9.7 第 3 条:对话框复述 **targetId + region + 对象标识** 三样", () => {
    expect(comp).toMatch(/genbi-card-scope-restate/);
    expect(comp).toMatch(/card\.targetId/);
    expect(comp).toMatch(/card\.region/);
    expect(comp).toMatch(/card\.turnCount/);
  });

  it("🔴 §9.7 第 7 条:可见但**不可承接** ⇒ 没有「切区并继续」这个按钮,只有只读 + 原因 + 直达", () => {
    expect(comp).toMatch(/\{serviceable && \(/);
    expect(comp).toMatch(/genbi-card-not-serviceable/);
    // 组件把人话原因渲染出来(prop 名是 notServiceableWhy);页面把**注册表的单一作者字段**喂给它
    // ⇒ 这条链证明「不可承接的原因」不是页面自己编的(§9.7 第 7 条:判据只认 `unusableReason()`)
    expect(comp).toMatch(/notServiceableWhy/);
    expect(page).toMatch(/unusableReason/);
  });

  it("🔴 标题读不到 ⇒ **降级不消失**:占位 + 计数如实说,不许过滤掉那一行", () => {
    expect(comp).toMatch(/titleUnavailable/);
    expect(comp).toMatch(/genbi-card-title-na-/);
    expect(comp).toMatch(/genbi-cards-title-unavailable/);
    // 🔴 变异 U4 曾**存活**:原来写 `not.toMatch(/filter\([^)]*titleUnavailable/)` —— 而
    //    `.filter((x) => !x.titleUnavailable)` 里 `(x)` 自带一个 `)`,`[^)]*` 直接匹配不到。
    //    ⇒ 负向断言不要靠「猜写法」,**切出那条语句整段判**。
    const rowsStmt = comp.slice(comp.indexOf("const rows ="), comp.indexOf("const rows =") + 260);
    expect(rowsStmt, "列表按 titleUnavailable 过滤 ⇒ 读不到标题的卡片会**从列表消失**,用户以为卡片丢了")
      .not.toMatch(/titleUnavailable/);
    expect(rowsStmt).toMatch(/kw/); // 只按搜索词过滤
  });

  // ── 🔴🔴 2026-09-13 根治:个人索引必须**够得着它自己数出来的那些卡** ──
  // 病:配额是「每人全局 100」(用户拍板)而列表被执行范围**截肢** ⇒ 计数器说 97 而列表只有 3 张;
  //    唯一出口文案写「切换顶栏范围查看」= 让用户手动做 §9.7 该替他做的事;
  //    结果除了「全部」视角,§9.7 那套二选一**任何真实用户都触发不到** = 死代码。
  describe("🔴 卡片集合的「阅读镜头」可放宽,但绝不动执行范围", () => {
    it("抽屉有一键放宽入口,且**旧文案不许再出现**", () => {
      // 🔴 断**完整的属性串**:变异把 testid 改成 `genbi-cards-show-all-DISABLED` 时,
      //    `toContain("genbi-cards-show-all")` 照样过(子串关系)—— 这条变异当场存活过一次。
      expect(comp, "🔴 没有〔显示全部范围〕入口 ⇒ 范围外的卡片够不着,§9.7 不可达")
        .toContain('data-testid="genbi-cards-show-all"');
      expect(comp, "放宽后要能收回来").toContain('data-testid="genbi-cards-show-scoped"');
      // 负向:那句让用户自己去切顶栏的话必须消失(它把护栏 7 的活推给了用户)
      expect(comp, "🔴 旧文案「切换顶栏范围查看」还在").not.toContain("切换顶栏范围查看");
    });

    it("🔴🔴 放宽只改**列表请求**,绝不调 setScope(否则等于静默移动执行范围,违反 §9.7 第 1 条)", () => {
      // 切出抽屉组件那一整段来判 —— 不猜正则(负向断言猜正则本仓栽过两次)
      const i = comp.indexOf("export function MyCardsDrawer");
      expect(i).toBeGreaterThan(-1);
      const drawer = comp.slice(i);
      expect(drawer, "🔴 抽屉里出现了 setScope ⇒ 放宽列表顺手把执行范围也改了").not.toContain("setScope");
      // 放宽的实现必须是「不带 scope 参数」= 与「全部」同一个口径
      expect(drawer).toMatch(/widened\s*\?\s*null\s*:\s*scopeParam/);
      // 而且用户看得到「顶栏没变」这句保证
      expect(drawer).toContain("genbi-cards-widened");
    });

    it("范围仍是**默认**镜头(默认不放宽 ⇒ 全平台按范围过滤的口径不变)", () => {
      const i = comp.indexOf("export function MyCardsDrawer");
      const drawer = comp.slice(i);
      // 🔴 断**那一行声明整句**:抽屉里还有别的 `useState(false)`(loading 等),
      //    只断 /useState\(false\)/ 时把 widened 的初值改成 true 也过 —— 这条变异当场存活过一次。
      expect(drawer, "默认就放宽 = 悄悄取消了按范围过滤")
        .toContain("const [widened, setWidened] = useState(false);");
      // 关抽屉要复位,否则「上次放宽过」会变成隐式的持久设置
      expect(drawer).toMatch(/if \(!open\) setWidened\(false\)/);
    });
  });

  it("🔴 护栏 1:范围外还有几张必须说出来;拉不到列表**不当成空**", () => {
    expect(comp).toMatch(/genbi-cards-hidden/);
    expect(comp).toMatch(/hiddenByScope/);
    expect(comp).toMatch(/genbi-cards-error/);
  });

  it("🔴 续聊沿用**卡片原来的 conversationId**(换新 id ⇒ 再次保存会多吃一个额度)", () => {
    expect(page).toMatch(/setConversationId\(d\.data\.conversationId\)/);
  });

  it("🔴 满额不静默淘汰:删除是**用户主动**动作(Popconfirm),前端没有任何自动删除", () => {
    expect(comp).toMatch(/Popconfirm/);
    expect(comp).not.toMatch(/autoDelete|evict|lru/i);
  });

  // ── 🔴🔴 2026-09-13:接线的那一半(库名不送到后端 ⇒ 重脱敏永久失效,而且没人会发现)──
  it("🔴 保存请求必须带 `database`,且页面用的是**提问时的同一个表达式**", () => {
    // ① 组件真的把它放进请求体(切出 POST 那一整段判,不用猜正则 —— 猜正则栽过两次)
    const i = comp.indexOf('fetch("/api/genbi/cards"');
    expect(i, "找不到保存请求").toBeGreaterThan(-1);
    const post = comp.slice(i, i + 400);
    expect(post, "🔴 请求体没带 database ⇒ 这张卡以后每次打开都拼不出 FQN ⇒ 重脱敏静默失效").toContain("database");

    // ② 页面传给弹框的值 == 提问时用的那个表达式(半截跟随比不跟随更坏:错得像对的)
    const askExpr = "engine === \"athena\" ? selectedNs : selectedDb";
    expect(page, "提问路径的库名表达式变了?先核对再改本判据").toContain(askExpr);
    const j = page.indexOf("<SaveCardModal");
    expect(j, "找不到 SaveCardModal 挂载点").toBeGreaterThan(-1);
    const mount = page.slice(j, j + 900);
    expect(mount, "🔴 保存弹框拿到的库名与提问用的不是同一个表达式").toContain(`database={${askExpr}}`);
  });

  it("**不新增菜单叶**:卡片集合是抽屉(新增叶子会触发 31 叶全覆盖的棘轮机制)", () => {
    expect(comp).toMatch(/<Drawer/);
    const menu = strip(readFileSync(resolve(SRC, "lib/scope/route-scope.ts"), "utf8"));
    expect(menu).not.toMatch(/genbi\/cards/);
  });
});
