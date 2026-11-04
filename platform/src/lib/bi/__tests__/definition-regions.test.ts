// @kf-batch 50-WP4quater-reads(工单 SC-28)
/**
 * 钉住 BI 定义级过滤的**语义**。用户 2026-09-10 原话:
 * 「**这个我没看懂,到底是做了分区过滤还是没做?我觉得可以增加一个过滤能力,默认不过滤。**」
 *
 * 🔴 「默认不过滤」是**产品决定**,不是实现细节 —— 下一个人很容易顺手把它改成默认开
 * (那看起来更「一致」)。改成默认开的后果:顶栏切区就把别区的看板悄悄藏起来,
 * 而用户根本没要求过滤 —— 那正是护栏 1「永远不让用户丢东西」要挡的事。所以这里显式钉住。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analysisRegions, reportRegions, widgetTarget, filterDefinitionsByRegions } from "../definition-regions";

const SRC = resolve(__dirname, "../../..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const read = (p: string) => strip(readFileSync(resolve(SRC, p), "utf8"));

const HOME = "tgt_home";
const USW2 = "tgt_usw2_a";

describe("从 widget 落点派生「涉及哪些区」", () => {
  it("多个 widget 各在不同区 ⇒ 多个区(一张看板可以并排放不同区的图)", () => {
    const a = { widgets: [{ source: { targetId: USW2 } }, { source: { targetId: HOME } }, { source: { targetId: USW2 } }] };
    expect(analysisRegions(a)).toEqual([HOME, USW2]);
  });
  it("没有落点的 widget 归主控区(与平台其它「无章 ⇒ 主控区」一致)", () => {
    expect(widgetTarget({ source: {} })).toBe(HOME);
    expect(analysisRegions({ widgets: [{ source: { engine: "redshift" } }] })).toEqual([HOME]);
  });
  it("🔴 空看板 ⇒ 空数组,**不硬塞主控区**(它还没取任何区的数,标成主控区是编造)", () => {
    expect(analysisRegions({ widgets: [] })).toEqual([]);
    expect(analysisRegions({})).toEqual([]);
  });
  it("报表只有一个 source ⇒ 恒一个区;dataapi 变体没有 targetId ⇒ 归主控区", () => {
    expect(reportRegions({ source: { kind: "sql", targetId: USW2 } })).toEqual([USW2]);
    expect(reportRegions({ source: { kind: "dataapi", apiId: "x" } })).toEqual([HOME]);
  });
});

describe("🔴 可选过滤:默认不过滤", () => {
  const rows = [
    { id: "a", regions: [USW2] },
    { id: "b", regions: [HOME] },
    { id: "c", regions: [] as string[] }, // 空看板
  ];
  const of = (r: { regions: string[] }) => r.regions;

  it("enabled=false ⇒ **原样返回**(这是用户明确要的默认行为)", () => {
    expect(filterDefinitionsByRegions(rows, of, [USW2], false).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
  it("enabled=true ⇒ 只留涉及当前范围的", () => {
    expect(filterDefinitionsByRegions(rows, of, [USW2], true).map((r) => r.id)).toEqual(["a", "c"]);
  });
  it("🔴 空看板在过滤开启时也**保留** —— 否则新建的空看板在任何区都看不见", () => {
    expect(filterDefinitionsByRegions(rows, of, [HOME], true).map((r) => r.id)).toContain("c");
  });
  it("wanted 为空(全局视角)⇒ 不过滤", () => {
    expect(filterDefinitionsByRegions(rows, of, [], true)).toHaveLength(3);
  });
});

describe("🔴 结构性:过滤必须是 opt-in,不许变成默认开", () => {
  it("两条列表路由都只在显式 `?scopeFilter=1` 时才筛", () => {
    for (const f of ["app/api/bi/analyses/route.ts", "app/api/bi/reports/route.ts"]) {
      const src = read(f);
      expect(src, `${f} 的过滤开关不是 opt-in`).toContain('searchParams.get("scopeFilter") === "1"');
      // 负向:不许直接把 scope 当过滤条件用(那就是默认开)
      expect(src, `${f} 直接按 scope 过滤了 ⇒ 变成默认开`).not.toMatch(/filterRowsByScope\(/);
    }
  });
  it("前端开关的初始值必须是 false", () => {
    const src = read("components/bi/AnalysisWorkbench.tsx");
    // 🔴 断言**那一行本身**。第一版写的是 `toContain("useState(false)")` —— 文件里到处都有
    // `useState(false)`,所以把开关默认值改成 true 时那条判据**照样绿**(变异验证当场抓到)。
    // 这就是「没有判别力的判据 = 空断言」的现形:断言必须落在会变的那个 token 上。
    expect(src, "按区过滤开关的默认值被改成了 true ⇒ 顶栏切区就会悄悄藏掉别区的看板").toContain(
      "const [scopeFilterOn, setScopeFilterOn] = useState(false);"
    );
    expect(src).toContain('qs.set("scopeFilter", "1")');
    expect(src, "开关状态要进 load 的 deps,否则切开关不重拉").toMatch(/\[scopeParam, scopeFilterOn\]/);
  });
});
