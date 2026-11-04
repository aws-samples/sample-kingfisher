// @kf-batch 50-B02-spec-vs-observed
// 🔴🔴 **呈现面不许把「声称要装」显示成「已经装好」**（B-02）。
//
// 【真环境形态（2026-09-20，用户从页面复制给我的那三行之一）】
//   页面上：`eu-west-1 不承接新工作 已注册 tgt_euw1_a  core redshift  法域 eu-sim  探活 09-20 12:09`
//   ⇒ 界面宣称了**两个根本没有载体的组件**（`resources` 一个键都没有）。
//
// 【根因两层，第二层是改了一版之后才量出来的 —— 这一点必须留在判据里】
//   第一层（09-20 量到）：`spec` 与 `observed` **都是空 map**，只有旧顶层 `components` 有值
//     ⇒ 页面信顶层就在撒谎 ⇒ 改成「以 observed 为准」。
//   🔴🔴 第二层（09-21 同一个描述符再量一次，它变了）：`observed.components` **也**说装了
//     （`['core','redshift']`），而 `phase=provisioning`、`resources=null`
//     ⇒ **观测态被期望态污染了**，「以 observed 为准」这一层照样撒谎
//     ⇒ 必须再 fail-closed 一层：只有 `phase=ready` 才谈得上「已装」。
//
// 【这组判据用的全是真环境量到的形状，不是我编的】
import { describe, it, expect } from "vitest";
import { componentViewItems, claimsNothingInstalled, targetIsReady } from "@/lib/exec-env/component-view";

// —— 真环境实测的三种形状（2026-09-20 扫 bgp-execution-envs 得到）——
// 🔴 真环境量到的**两种**坏形态(2026-09-20 与 2026-09-21 各量了一次,它变了):
//   ① 早期:`observed` 是空 map(双轴还没写过)
const EUW1_EARLY = { components: ["core", "redshift"], observed: {}, ready: false };
//   ② 现在:`observed.components` **也**说装了,而 phase 还在 provisioning、resources 是 null
//      —— 观测态被期望态污染了,所以「以 observed 为准」这一层也会撒谎
const EUW1_BROKEN = {
  components: ["core", "redshift"],
  observed: { components: ["core", "redshift"], phase: "provisioning", health: "unknown" },
  ready: false,
};
const HOME_OK = {
  components: ["core", "redshift", "dms", "flink", "airflow-serverless", "agentcore"],
  observed: {
    components: ["core", "redshift", "dms", "flink", "airflow-serverless", "agentcore"],
    phase: "ready",
    health: "healthy",
  },
  ready: true,
};
const USW2_OK = {
  components: ["core", "redshift", "dms", "flink", "airflow-serverless"],
  observed: {
    components: ["core", "redshift", "dms", "flink", "airflow-serverless"],
    phase: "ready",
    health: "healthy",
  },
  ready: true,
};
const FRESH_REGISTERED = { components: undefined, observed: {}, ready: false }; // 新注册(走了双轴)的样子

describe("呈现面的组件状态:以 observed 为准、fail-closed(B-02)", () => {
  it("① 🔴 观测态被污染的那一行:两个组件都必须显示成**待部署**(B-02 真环境形态)", () => {
    const items = componentViewItems(EUW1_BROKEN);
    expect(items.map((x) => x.name)).toEqual(["core", "redshift"]);
    expect(
      items.every((x) => !x.installed),
      "顶层声称而 observed 里没有 ⇒ 不许显示成已装(界面不许宣称没有载体的东西)"
    ).toBe(true);
    expect(claimsNothingInstalled(EUW1_BROKEN), "一个都没装出来 ⇒ 卡片要说清「尚未部署」").toBe(true);
    // 早期那种形态(observed 完全空)同样不许算已装
    const early = componentViewItems(EUW1_EARLY);
    expect(early.every((x) => !x.installed)).toBe(true);
    expect(claimsNothingInstalled(EUW1_EARLY)).toBe(true);
  });

  it("①b 🔴🔴 **光看 observed.components 不够**:它说装了而 phase 还没 ready ⇒ 仍是待部署", () => {
    // 这是 2026-09-21 真值坐实的第二层:`observed.components=['core','redshift']` 而
    // `phase=provisioning`、`resources=null` —— 观测态被期望态污染,呈现面必须再 fail-closed 一层。
    expect(targetIsReady(EUW1_BROKEN), "phase=provisioning 不算 ready").toBe(false);
    expect(componentViewItems(EUW1_BROKEN).every((x) => !x.installed)).toBe(true);
    // 同一份 observed,只把 phase 换成 ready ⇒ 立刻算已装(证明判别点就是 phase,不是别的)
    const readyNow = { ...EUW1_BROKEN, observed: { ...EUW1_BROKEN.observed, phase: "ready" }, ready: true };
    expect(targetIsReady(readyNow)).toBe(true);
    expect(componentViewItems(readyNow).every((x) => x.installed)).toBe(true);
    // 兼容:phase 缺失(旧描述符)时认顶层投影 ready —— 那是同一件事的镜像,不是回落到期望态
    expect(targetIsReady({ observed: {}, ready: true })).toBe(true);
    expect(targetIsReady({ observed: {}, ready: false })).toBe(false);
    expect(targetIsReady({}), "什么都读不到 ⇒ fail-closed").toBe(false);
  });

  it("② 🔴 零回归(正控制):真装好的两个区必须**全部显示为已装**", () => {
    for (const [label, t] of [["home", HOME_OK], ["usw2", USW2_OK]] as const) {
      const items = componentViewItems(t);
      expect(items.length, `${label} 的组件行数不对`).toBe(t.components!.length);
      expect(
        items.every((x) => x.installed),
        `${label} 明明装好了却被显示成待部署 ⇒ 这一改把好的也打红了(比 B-02 本身更糟)`
      ).toBe(true);
      expect(claimsNothingInstalled(t)).toBe(false);
    }
  });

  it("③ 投影落后(只在 observed 里)⇒ 仍算**已装**,不许因为顶层漏了就不显示", () => {
    // 顶层投影没跟上、而资源真的在:这时候骗人的方向相反 —— 不显示 = 用户以为没装
    const lagging = { components: ["core"], observed: { components: ["core", "redshift"], phase: "ready" }, ready: true };
    const items = componentViewItems(lagging);
    expect(items.map((x) => x.name).sort()).toEqual(["core", "redshift"]);
    expect(items.every((x) => x.installed)).toBe(true);
  });

  it("④ 新注册(还没部署)且顶层为空 ⇒ 一行都不摆,也不谎称「尚未部署」", () => {
    expect(componentViewItems(FRESH_REGISTERED)).toEqual([]);
    // 🔴 没有任何组件信息时**不许**打「尚未部署」——那是在替用户编一个它没声称过的意图
    expect(claimsNothingInstalled(FRESH_REGISTERED)).toBe(false);
  });

  it("⑤ 脏输入不许把界面搞崩,也不许被当成已装", () => {
    const dirty = {
      components: ["core", "", null as unknown as string, "redshift"],
      observed: { components: null, phase: "ready" },
      ready: true,
    };
    const items = componentViewItems(dirty);
    expect(items.map((x) => x.name)).toEqual(["core", "redshift"]);
    expect(items.every((x) => !x.installed)).toBe(true);
    expect(componentViewItems({})).toEqual([]);
    expect(claimsNothingInstalled({})).toBe(false);
  });

  it("⑥ 接线:页面真的用了这个唯一判断(不是各自再写一遍 includes)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const page = readFileSync(resolve(__dirname, "../../../app/exec-envs/page.tsx"), "utf8");
    const noImports = page.replace(/^\s*import[\s\S]*?;\s*$/gm, "");
    expect(/componentViewItems\s*\(/.test(noImports), "页面没调 componentViewItems ⇒ 判据在空转").toBe(true);
    expect(/claimsNothingInstalled\s*\(/.test(noImports)).toBe(true);
    // 负向:不许再出现「直接拿顶层 components 渲染 Tag」那个写法
    expect(
      /\(x\.components \?\? \[\]\)\.map\(/.test(noImports),
      "还在直接渲染顶层 components ⇒ 双轴缺失的行又会被显示成已装"
    ).toBe(false);
    // 无头判据要靠 testid 定位,别被改名
    expect(page).toContain("comp-installed-");
    expect(page).toContain("comp-pending-");
  });
});
