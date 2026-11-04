// @kf-batch 50-B10-stale-response-race
// 🔴🔴 **并发请求的陈旧响应竞态:晚到的那份会赢**（B-10）。
//
// 【为什么是结构判据而不是行为判据 —— 这一点必须说清，别让下一个人以为我偷懒】
// 竞态的行为判据**天生不稳定**：要它红，必须让「先发的那次」比「后发的那次」**晚回来**，
// 而请求返回顺序不由判据控制。跑一百次可能九十九次是正常顺序 ⇒ 判据绿而缺陷完好无损
// （本仓已经有过一次教训：`stale-response-race-shows-wrong-region` 那次是**判据红而我手工绿**，
//  因为我那个上下文恰好没触发竞态；决定性工具是带时间戳的 `page.on("response")`，不是断言结果）。
// ⇒ 主力判据钉**结构**：凡写 state 的位置，都必须在「序号比对」之后。这是闭合式的：
//   不是枚举「哪几处忘了比」，而是要求**每一处** `setCatalogData` 都在那道闸后面。
//
// 【真缺陷（2026-09-20 在 B-06 诊断过程中发现）】
//   `searchCatalog` 原本是 `const d = await fetch(...); setCatalogData(...)` ——
//   没有序号、没有 AbortController、没有「只认最后一次」⇒ 用户连着搜两次（或切区与搜索同时发生），
//   两个请求并发，**谁晚回来谁写进 state**：搜了新词，列表显示的却是上一次的结果。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(__dirname, "../../..");
const raw = readFileSync(resolve(SRC, "app/governance/page.tsx"), "utf8");

/** 剥注释（负向文本断言前必须剥，否则「注释里解释了那句话」会被当成那句话还在）。 */
function stripComments(s: string): string {
  return s
    .split("\n")
    .map((l) => {
      const t = l.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
      const i = l.indexOf("//");
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join("\n");
}

/** 切出 `searchCatalog` 的函数体 —— 🔴 顺序类判据必须先锚定到它要判的那个函数，
 *  整篇比下标会拿别的 fetch/setState 的位置来判自己（本仓栽过两次）。 */
function searchCatalogBody(src: string): string {
  const start = src.indexOf("const searchCatalog = async");
  expect(start, "找不到 searchCatalog ⇒ 判据在空转（改名了？）").toBeGreaterThan(-1);
  // 到下一个顶层 `const xxx = ` 之前（本函数是 page 组件里的一个局部函数）
  const rest = src.slice(start + 10);
  const next = rest.search(/\n  const [A-Za-z_$]/);
  return rest.slice(0, next > 0 ? next : rest.length);
}

describe("治理目录搜索:陈旧响应必须被丢弃(B-10)", () => {
  const code = stripComments(raw);
  const body = searchCatalogBody(code);

  it("① 有「本次请求的序号」这个东西,且每次调用都自增", () => {
    expect(code, "没有序号 ref ⇒ 无从判断哪一次是最后一次").toMatch(/catalogSeqRef\s*=\s*useRef\(/);
    expect(body, "进函数没有自增序号 ⇒ 序号永远是同一个,比也比不出来").toMatch(
      /const\s+seq\s*=\s*\+\+\s*catalogSeqRef\.current/
    );
  });

  it("② 🔴 闭合式:**每一处**写 state 都在序号比对之后(不是枚举某几处)", () => {
    const guard = body.search(/if\s*\(\s*seq\s*!==\s*catalogSeqRef\.current\s*\)\s*return/);
    expect(guard, "函数体里没有「不是最后一次就丢弃」这道闸").toBeGreaterThan(-1);
    // 找出所有写 state 的位置,逐个要求晚于那道闸
    const writers = ["setCatalogData(", "setCatalogFresh(", "setNoWarehouse("];
    for (const w of writers) {
      let from = 0;
      for (;;) {
        const at = body.indexOf(w, from);
        if (at < 0) break;
        expect(
          at,
          `${w} 出现在序号比对**之前**(下标 ${at} < ${guard}) ⇒ 陈旧响应仍会写进 state`
        ).toBeGreaterThan(guard);
        from = at + 1;
      }
    }
  });

  it("③ loading 也只认最后一次(否则正在飞的那次会被提前关掉 ⇒ 用户以为搜完了)", () => {
    expect(
      /if\s*\(\s*seq\s*===\s*catalogSeqRef\.current\s*\)\s*setCatalogLoading\(false\)/.test(body),
      "finally 里无条件 setCatalogLoading(false) ⇒ 陈旧响应回来就把 loading 关了"
    ).toBe(true);
  });

  it("④ 负向:不许再出现「拿到响应直接写 state」那个原始形态", () => {
    // 原始形态 = `const d = await res.json();` 紧接着就 setCatalogFresh/setCatalogData(中间没有闸)
    const naive = /const\s+d\s*=\s*await\s+res\.json\(\);\s*set(CatalogFresh|CatalogData)/.test(body);
    expect(naive, "响应与写 state 之间没有那道闸 ⇒ 回到 B-10 的原始缺陷").toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// @kf-batch 50-B18-catalog-state-two-meanings
//
// 🔴🔴 **B-18:`catalogData` 被当成两件事用。**
// 无头对照实验(2026-09-21,同一个浏览器同一次运行,只差「中间搜没搜」):
//   A 组 全新进页面        ⇒ 质量页签下拉输入 `dws_channel_roi_daily` ⇒ **1 条,选得到**
//   B 组 先在目录里搜 `home_orders_`(8 行,不含目标表)⇒ 同一串操作 ⇒ **空态,选不到**
// 根因:`options={catalogData.map(...)}` 在血缘 / 影响分析 / 数据分级 / 数据质量**四处**都这么写,
// 而 `catalogData` 的语义是「目录页签当前那次搜索的结果」。⇒ 用户在目录里搜过一次之后,
// 那四个选择器就只剩搜到的那几张表 —— 而界面上没有任何线索(记忆 one-set-two-meanings-deadlock)。
//
// 🔴 这也是我自己判断错的一条:我原先在台账里写「B-16 是判据问题,不许因为它红去改产品」;
//    对照实验推翻了它 —— 判据确实也有毛病(用了全页下标),但**底下压着一个真产品缺陷**。
// ════════════════════════════════════════════════════════════════════════════
describe("治理页:`catalogData` 只有一个语义(B-18)", () => {
  const code = stripComments(raw);

  it("⑤ 🔴 闭合式:`catalogData` 的消费形态是**封闭清单**(不是枚举违规)", () => {
    // 唯一允许出现 `catalogData` 的形态 —— 多一种就红,这样第 N+1 处新用法逃不掉。
    const ALLOWED = [
      /const\s*\[\s*catalogData\s*,\s*setCatalogData\s*\]\s*=\s*useState/, // 声明
      /setCatalogData\(/,                                                  // 只由搜索写
      /\{\s*n:\s*catalogData\.length\s*\}/,                                // 目录页签的计数
      /dataSource=\{catalogData\}/,                                        // 目录页签的表格
      // 序 47d 目录筛选:下面三种都仍是「目录搜索结果」本身 —— 筛选 / 候选项是它的**派生视图**(纯函数 lib/governance/catalog-filters.ts),
      //   表格改吃派生出的 filteredCatalog;页签计数在筛选时写成「n / total」,total 仍是搜索结果总数。没有第二份 state、没有第二个作者。
      /applyCatalogFilter\(catalogData,\s*catalogFilter\)/,                 // 派生:筛选后的行
      /catalogFilterOptions\(catalogData,\s*catalogFilter\.db\)/,           // 派生:筛选候选项
      /total:\s*catalogData\.length/,                                       // 页签计数的分母
    ];
    const occurrences: string[] = [];
    const re = /^.*\bcatalogData\b.*$/gm;
    for (const m of code.match(re) || []) occurrences.push(m.trim());
    expect(occurrences.length, "一处都没有 ⇒ 判据在空转(改名了?)").toBeGreaterThan(0);
    for (const line of occurrences) {
      const ok = ALLOWED.some((p) => p.test(line));
      expect(
        ok,
        `🔴 \`catalogData\` 出现在一个**未登记的形态**里 ⇒ 它又被当成第二件事用了:\n    ${line}\n` +
          `    (若这是正当新用法,请把它加进本判据的 ALLOWED 并写明为什么它仍然是「目录搜索结果」)`
      ).toBe(true);
    }
  });

  it("⑥ 🔴 资产选择器的候选只有**一个**来源 `assetOptions`,它只从 `allAssets` 派生", () => {
    // 四个页签的选择器都必须用它(数字是**下界**:新增页签只会更多,不会更少)
    const n = (code.match(/options=\{assetOptions\}/g) || []).length;
    expect(n, "资产选择器没有全部走 assetOptions").toBeGreaterThanOrEqual(4);
    // 🔴 负向:不许任何选择器再拿 catalogData 当 options(这就是 B-18 的原始形态)
    expect(
      /options=\{catalogData/.test(code),
      "🔴 又有选择器拿「目录搜索结果」当候选清单 ⇒ B-18 原样复发"
    ).toBe(false);
    // `assetOptions` 只能从 allAssets 派生(否则又多一个作者)
    expect(code).toMatch(/const\s+assetOptions\s*=\s*useMemo\(/);
    expect(code, "assetOptions 的依赖不是 allAssets ⇒ 有第二个来源").toMatch(/\[\s*allAssets\s*\]\s*,?\s*\)/);
  });

  it("⑦ 🔴 `loadAllAssets` **永远不带 keyword** —— 否则搜索又能影响候选清单", () => {
    const at = code.indexOf("const loadAllAssets = async");
    expect(at, "找不到 loadAllAssets ⇒ 判据在空转").toBeGreaterThan(-1);
    const rest = code.slice(at + 10);
    const next = rest.search(/\n  const [A-Za-z_$]/);
    const body2 = rest.slice(0, next > 0 ? next : rest.length);
    // 🔴 取数收成单一作者之后,这条判据钉的是**传进去的关键词**:必须是空字符串**字面量**。
    //   比钉 URL 插值更直接 —— 变量名可以改,而「空字面量」是唯一允许的形态。
    const calls = body2.match(/fetchCatalogPayload\(([^)]*)\)/g) || [];
    expect(calls.length, "loadAllAssets 里没有取数 ⇒ 它没在干活").toBeGreaterThan(0);
    for (const c of calls) {
      const arg = c.replace(/^fetchCatalogPayload\(/, "").replace(/\)$/, "").trim();
      expect(
        arg,
        `🔴 loadAllAssets 取数时传了 ${arg || "(空)"} 而不是空字符串字面量 ⇒ ` +
          `候选清单又能被某个变量左右(B-18 原样复发)`
      ).toBe('""');
    }
    // 🔴 负向:它自己不许再直接拼 URL(那就是第二个取数作者)
    expect(/authedFetch\(/.test(body2), "loadAllAssets 自己又去拼 URL 了 ⇒ 第二个取数作者").toBe(false);
  });

  it("⑧ 进页面/切范围时,两份 state **都**要填(只填一份 = 四个选择器进页面就是空的)", () => {
    const eff = code.slice(code.indexOf("if (authLoading) return;"));
    const head = eff.slice(0, eff.indexOf("}, [authLoading"));
    expect(head, "初始化没有 bootstrapCatalog() ⇒ 两份 state 不知道谁来填").toMatch(/bootstrapCatalog\(\)/);
    // 🔴 `bootstrapCatalog` 必须**真的把两份都写了**(否则它只是改了个名字)
    const at = code.indexOf("const bootstrapCatalog = async");
    expect(at, "找不到 bootstrapCatalog ⇒ 判据在空转").toBeGreaterThan(-1);
    const rest = code.slice(at + 10);
    const nx = rest.search(/\n  const [A-Za-z_$]/);
    const boot = rest.slice(0, nx > 0 ? nx : rest.length);
    expect(boot, "bootstrapCatalog 没填目录搜索结果").toMatch(/applyCatalogPayload\(/);
    expect(boot, "bootstrapCatalog 没填资产全集").toMatch(/applyAssetsPayload\(/);
    // 🔴🔴 而且**只许取一次数** —— 这一条是这一批最贵的教训(见下面 ⑫ 的文件头)
    const fetches = (boot.match(/fetchCatalogPayload\(/g) || []).length;
    expect(
      fetches,
      `🔴 bootstrapCatalog 里取了 ${fetches} 次数 —— 初始化只许取一次(两份 state 的正确初值` +
        `**恰好是同一次取数的结果**;各取一次会让两个参数逐字节相同的请求互相拖慢)`
    ).toBe(1);
    // 🔴 两个序号闸各判各的,不许一个代劳(否则陈旧响应会写进另一份)
    expect(boot, "bootstrapCatalog 没有目录侧的序号闸").toMatch(/cSeq === catalogSeqRef\.current/);
    expect(boot, "bootstrapCatalog 没有资产侧的序号闸").toMatch(/aSeq === assetsSeqRef\.current/);
  });

  // ════════════════════════════════════════════════════════════════════════
  // 🔴🔴 **⑫ 这一条是用一次真实测量换来的,别删。**
  //
  // B-18 的第一版修法是「初始化各调一次」(`searchCatalog("")` + `loadAllAssets()`),
  // 我还在注释里写了「多一次请求换来语义分离,值得」—— **那句话没有任何依据**。
  // 带时间戳实测(`/tmp/probe_b18_timing.py`)当场否证它:
  //     1.6s REQ keyword=&scope=tgt_home    ← 两条请求**参数逐字节相同**
  //     1.6s REQ keyword=&scope=tgt_home
  //     6.2s RESP 200                        ← 第一个
  //    10.4s RESP 200                        ← 第二个被拖慢 4.2s(服务端串行处理这个重活)
  //   ⇒ 候选清单就绪 **+6.2s → +11.1s**,用户一进页面点「数据质量」就是空下拉。
  //
  // 🔴 **教训**:「拆语义」与「多发请求」是两件事,不许把后者当成前者的代价一笔勾销;
  //   凡写下「这个代价值得」,必须**先量**。
  // 🔴 而且这个代价**文本判据看不见** —— 上一版 11 条判据全绿,是真实环境的时间线把它抓出来的。
  //   ⇒ 所以除了下面这条结构门,**无头侧还有一条行为判据**钉「进页面只发一次 catalog 请求」。
  // ════════════════════════════════════════════════════════════════════════
  it("⑫ 🔴 取数只有一个作者,写两份 state 也各只有一处", () => {
    expect(code, "取数没有收成单一作者 fetchCatalogPayload").toMatch(/const fetchCatalogPayload = async/);
    // `authedFetch` 打 catalog 接口的地方**只允许**在那个作者里出现一次
    const urls = (code.match(/authedFetch\(`\/api\/governance\/catalog\?/g) || []).length;
    expect(urls, `🔴 catalog 取数出现在 ${urls} 处 ⇒ 又有第二个取数作者(URL 会各写一遍、各漂一份)`).toBe(1);
    // 每个 setter 各只有一处写入点(声明那一行不算)
    for (const [setter, applier] of [["setCatalogData(", "applyCatalogPayload"], ["setAllAssets(", "applyAssetsPayload"]] as const) {
      const at = code.indexOf(`const ${applier} = `);
      expect(at, `找不到 ${applier} ⇒ 判据在空转`).toBeGreaterThan(-1);
      const rest = code.slice(at + 10);
      const nx = rest.search(/\n  const [A-Za-z_$]/);
      const body3 = rest.slice(0, nx > 0 ? nx : rest.length);
      // 🔴 数的是**调用**(`setXxx(`);`useState` 那一行里是 `setXxx]`,压根不匹配 ⇒ 不用扣。
      const pat = new RegExp(setter.replace(/[()]/g, "\\$&"), "g");
      const inside = (body3.match(pat) || []).length;
      const total = (code.match(pat) || []).length;
      expect(inside, `${applier} 里一次都没写 ${setter} ⇒ 判据在空转`).toBeGreaterThan(0);
      expect(
        total,
        `🔴 ${setter} 在 ${applier} 外面还有写入点(全文 ${total} 处,${applier} 里只有 ${inside} 处)` +
          ` ⇒ 这份 state 又有第二个作者`
      ).toBe(inside);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 🔴🔴 **这一条是把上面那条门禁从「枚举式」升级成「闭合式」** ——
// B-10 的门禁只判 `searchCatalog` **一个**函数。而 B-18 的修法给这一页添了**第二个**
// 并发写者 `loadAllAssets`:如果门禁还是点名式的,第二个(以及第 N+1 个)就无人看管。
// 本仓已为此立过纪律:**门禁写成「枚举违规写法」就一定漏掉第 N+1 种**
// (记忆 gate-enumerates-violations-not-legal-form)。
//
// ⚠️ **同时如实登记一件事(不许掩盖)**:这一页现在共有 14 个「取数后写 state」的函数,
//    其中**只有 2 个**有序号闸。剩下 12 个里,至少 `loadLineage` / `loadImpact` /
//    `loadClassification` / `loadQRules` / `loadQResults` 是**真竞态**
//    (快速切换两个 fqn / 两张表,晚到的旧响应会赢,症状与 B-10 一模一样)。
//    ⇒ 登记为 **B-19**,下一批修;本判据把它做成**只减不增的棘轮**:
//      · 新增函数不许无闸(总数不许变大);
//      · 每修掉一个就把数字改小 —— **数字本身就是进度**。
// ════════════════════════════════════════════════════════════════════════════
describe("治理页:陈旧响应守卫的覆盖面(闭合式 + 只减不增棘轮)", () => {
  const code = stripComments(raw);

  /** 组件内所有 `const x = async` 局部函数 ⇒ [名字, 函数体]。
   *  🔴 函数体切到**下一个顶层 `const` 声明**为止(与上面 `searchCatalogBody` 同一个口径)。
   *  第一版切到「下一个 **async** 函数」⇒ `fetchCatalogPayload` 的体里混进了紧跟其后的
   *  两个**非 async** 的 `applyXxxPayload`(它们才是写 state 的)⇒ 把一个纯取数函数
   *  误判成「取数后写 state 却没有闸」,棘轮凭空 +1。
   *  —— 判据自己也必须**锚定到它要判的那个对象**,这是本仓第 N 次栽在切错边界上。 */
  function localAsyncFns(src: string): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const re = /\n  const ([A-Za-z_$][\w$]*) = async/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      const rest = src.slice(m.index + 10);
      const nx = rest.search(/\n  const [A-Za-z_$]/);
      out.push([m[1], rest.slice(0, nx > 0 ? nx : rest.length)]);
    }
    return out;
  }
  const fns = localAsyncFns(code);
  // 🔴 「取数」的形态有三种:直接 `authedFetch` / 裸 `fetch` / 调那个**单一取数作者**。
  //   少写第三种 ⇒ 重构之后 `searchCatalog` 这类函数就从清单里消失了,而它恰恰是最该判的那个
  //   (判据会**静默缩小覆盖面**,比红更危险 —— 所以 ⑨ 那条「判据自己先有判别力」必须在)。
  const TAKES_DATA = /authedFetch\(|await fetch\(|fetchCatalogPayload\(/;
  // 🔴 「写 state」同理有两种形态:直接 `setXxx(`,或经由 `applyXxxPayload(` 那一层。
  //   ⚠️ **这两条口径在本批里被重构打破了三次**(取数收成单一作者 / 写 state 收成 applier)——
  //   每次的表现都是某个点名函数**从清单里消失**、判据报「空转」。
  //   🔴 它没有变成假绿,是因为 ⑨/⑩ 要求「点名的那几个必须真被识别到」——
  //   **判据自己发现了自己的覆盖面在缩小**。这就是那两条看似多余的判据的全部价值:
  //   判据钉形态就一定会被重构打破,所以必须再钉一层「我还看得见我要判的东西吗」。
  //   ⇒ 新增任何一层写 state 的间接封装,**必须同时加进下面这个清单**。
  const WRITES_STATE = /\bset[A-Z][\w$]*\(|apply[A-Z][\w$]*Payload\(/;
  const fetchers = fns.filter(([, b]) => TAKES_DATA.test(b) && WRITES_STATE.test(b));
  // 🔴 闸的形态:自增了某个 SeqRef **且** 拿它比对过(比对可以是 `!==` 丢弃,也可以是 `===` 才写 ——
  //   `bootstrapCatalog` 用的是后者,因为它要分别决定两份 state 各写不写)。
  // 🔴 **本轮第 6 例「判据钉形态被自己的重构打破」**:B-19 把 12 个函数的闸收进一个
  //   `seqRefs` 集合(`++seqRefs.lineage.current`),而这条正则原来只认 `\w*SeqRef.current`
  //   ⇒ 那 12 个刚加的闸**一个都识别不到**。判据钉的**事实**没变(自增 + 比对),变的只是写法
  //   ⇒ 放宽到同时认两种写法,**但绝不放宽「必须自增且必须比对」这两件事**。
  const SEQ_BUMP = /\+\+\s*[\w.]*[Ss]eq[\w.]*\.current/;
  const SEQ_CMP = /\w+\s*(?:!==|===)\s*[\w.]*[Ss]eq[\w.]*\.current/;

  // 🔴🔴 **这条口径被变异验证当场打掉过一次(2026-09-22),必须钉「顺序」而不只是「存在」**:
  //   第一版只要求「函数体里有自增 ∧ 有比对」。而每个函数的 `finally` 里都有一句
  //   `if (seq === xxx.current) setXxxLoading(false);` —— 于是我把 `loadLineage` 写 state
  //   前那道闸整行删掉、又把 `loadImpact` 的比对改成 `if (false)`,**判据都是绿的**:
  //   它把「finally 里关 loading 的比对」当成了「写 state 前的闸」。**那是两件不同的事。**
  //   ⇒ 真正的不变量是:**第一个 `await` 之后、第一个「写 state」之前,必须有一次比对**。
  //     (开头那些 `setXxxFqn(fqn)` / `setXxxLoading(true)` 在第一个 `await` **之前**,
  //      它们由用户动作直接决定,本来就不该被闸拦 —— 所以按 `await` 切天然分得开。)
  const guarded = (b: string) => {
    if (!SEQ_BUMP.test(b)) return false;
    const ai = b.search(/\bawait\b/);
    if (ai < 0) return false;              // 压根没 await ⇒ 不是取数函数,不该进这个清单
    const after = b.slice(ai);
    const wi = after.search(WRITES_STATE);
    if (wi < 0) return true;               // await 之后不写 state ⇒ 没有「陈旧写入」这回事
    return SEQ_CMP.test(after.slice(0, wi));
  };

  it("⑨ 判据自己先有判别力:这一页真的存在「取数后写 state」的函数", () => {
    expect(fns.length, "一个 async 局部函数都没切出来 ⇒ 切法失效(页面重构了?)").toBeGreaterThan(5);
    expect(fetchers.length, "一个取数函数都没识别到 ⇒ 判据在空转").toBeGreaterThan(5);
  });

  it("⑩ 🔴 点名清单:写**共享展示 state** 且会被范围切换并发触发的,必须有序号闸", () => {
    // 这两个都在 `scopeQs` 变化时被同一个 effect 触发 ⇒ 两次 scope 的响应必然并发。
    for (const name of ["searchCatalog", "loadAllAssets", "bootstrapCatalog"]) {
      const hit = fetchers.find(([n]) => n === name);
      expect(hit, `找不到 ${name} ⇒ 判据在空转`).toBeTruthy();
      expect(guarded(hit![1]), `🔴 ${name} 没有「序号自增 + 比对丢弃」⇒ 晚到的陈旧响应会赢(B-10 同形)`).toBe(true);
    }
  });

  it("⑪ 🔴 棘轮:无闸的取数函数**只减不增**(新增的必须带闸)", () => {
    // 🔴 只减不增。修掉一个就把这个数字改小;**绝不允许改大**。
    //    2026-09-21 立此数 = 12(B-19 登记在案)。
    //    2026-09-22 **12 → 0**:B-19 全修完。登记时我写「至少 5 个是真竞态」,
    //    细看**动作型也一样是真竞态**(`runQuality` 点两次 / `addRule` 快速加两条,
    //    晚到的旧响应照样盖掉新的)⇒ 不分等级,12 个全加闸。
    //    🔴 归零之后这条判据的意义变了:它从「欠账计数器」变成「**新增取数函数必须自带闸**」
    //    的硬门 —— 任何一个新函数忘了加,这个数就从 0 变成 1,当场红。
    const UNGUARDED_LIMIT = 0;
    const unguarded = fetchers.filter(([, b]) => !guarded(b)).map(([n]) => n);
    expect(
      unguarded.length,
      `🔴 无序号闸的取数函数从 ${UNGUARDED_LIMIT} 变成了 ${unguarded.length} 个 ——\n` +
        `    新增取数函数必须自带序号闸(B-10 那一类缺陷不许再长出第 N+1 个)。\n` +
        `    当前无闸清单:${unguarded.join(", ")}`
    ).toBeLessThanOrEqual(UNGUARDED_LIMIT);
  });
});
