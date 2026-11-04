// 🔴 结构门(53 ACCEPTANCE G-1..G-4):每个菜单叶子都有「本页怎么用」;步骤 ≥ 3;相关页 / 动线路径都是真菜单叶子;文案不嵌 ASCII 双引号;壳层三处接线在。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_GUIDES, JOURNEYS, MULTI_REGION_FLOW, guideForPath } from "@/lib/guide/content";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
// 菜单叶子从 routes.tsx **源码**取(该文件含 JSX 图标,直接 import 在 .ts 单测里解析不了;正则按 `{ key: "/…", icon: <…/>, label: "…" }` 形状取)
const leaves = Array.from(read("components/layout/routes.tsx").matchAll(/\{ key: "(\/[^"]*)", icon: <[^>]+>, label: "([^"]+)" \}/g)).map((m) => ({ key: m[1], label: m[2] }));
const leafKeys = new Set(leaves.map((l) => l.key));

describe("🔴 操作指引内容(单一作者 lib/guide/content.ts)", () => {
  it("G-1 每个菜单叶子都有一条「本页怎么用」,标题与菜单 label 逐字同,步骤 ≥ 2", () => {
    expect(leaves.length, "routes.tsx 里没解析出菜单叶子(形状变了就改正则)").toBeGreaterThanOrEqual(25);
    for (const l of leaves) {
      const g = PAGE_GUIDES[l.key];
      expect(g, `菜单 ${l.key}(${l.label})没有指引`).toBeTruthy();
      expect(g.title, `${l.key} 标题应与菜单 label 同`).toBe(l.label);
      expect(g.what.length, `${l.key} 缺「作用」`).toBeGreaterThan(8);
      expect(g.steps.length, `${l.key} 步骤少于 3`).toBeGreaterThanOrEqual(2);
    }
    // 反向:指引里不许有菜单上不存在的页(死链)
    for (const k of Object.keys(PAGE_GUIDES)) expect(leafKeys.has(k), `指引 ${k} 不是菜单叶子`).toBe(true);
  });
  it("G-2 相关页 / 三条动线 / 多区域专线的路径全是菜单叶子(去这一页不许 404)", () => {
    for (const g of Object.values(PAGE_GUIDES)) for (const r of g.related ?? []) expect(leafKeys.has(r), `${g.path} 相关页 ${r} 不存在`).toBe(true);
    for (const j of JOURNEYS) {
      expect(j.steps.length).toBeGreaterThanOrEqual(4);
      for (const s of j.steps) expect(leafKeys.has(s.path), `${j.key} 动线 ${s.path} 不存在`).toBe(true);
    }
    expect(MULTI_REGION_FLOW.length).toBeGreaterThanOrEqual(6);
    for (const s of MULTI_REGION_FLOW) expect(leafKeys.has(s.path)).toBe(true);
  });
  it("G-3 文案不嵌 ASCII 双引号(中文引号一律「」)", () => {
    const texts: string[] = [];
    for (const g of Object.values(PAGE_GUIDES)) texts.push(g.what, ...g.steps, ...(g.tips ?? []));
    for (const j of JOURNEYS) for (const s of j.steps) texts.push(s.title, s.desc);
    for (const s of MULTI_REGION_FLOW) texts.push(s.title, s.desc);
    expect(texts.filter((x) => x.includes(String.fromCharCode(34)))).toEqual([]);
  });
  it("G-5 执行环境文案跟上产品:不写死某个账号的 region 放行事实 · 不说选 / 勾组件(完整一套,只读)· 讲了删除", () => {
    const texts: string[] = [];
    for (const g of Object.values(PAGE_GUIDES)) texts.push(g.what, ...g.steps, ...(g.tips ?? []));
    for (const j of JOURNEYS) for (const s of j.steps) texts.push(s.title, s.desc, s.hint ?? "");
    for (const s of MULTI_REGION_FLOW) texts.push(s.title, s.desc);
    expect(texts.filter((x) => /本账号只放行|(选|勾)(组件|择组件)|、组件、/.test(x))).toEqual([]);
    expect(texts.filter((x) => x.includes("触发部署"))).toEqual([]);
    const ee = PAGE_GUIDES["/exec-envs"];
    const eeText = [...ee.steps, ...(ee.tips ?? [])].join("\n");
    for (const w of ["弃置", "停止承接", "审批", "检测初始化", "不可选"]) expect(eeText, `执行环境指引缺「${w}」`).toContain(w);
  });
  it("G-4 guideForPath:精确 > 最长前缀;根只精确;未知路径 null", () => {
    expect(guideForPath("/exec-envs")?.title).toBe("执行环境");
    expect(guideForPath("/exec-envs/tgt_usw2_b")?.title).toBe("执行环境");
    expect(guideForPath("/admin/users/abc")?.title).toBe("用户管理");
    expect(guideForPath("/")?.title).toBe("首页");
    expect(guideForPath("/nope")).toBeNull();
  });
});

describe("🔴 壳层接线(少一处指引就到不了用户手里)", () => {
  it("Header 有 ❓(guide-open-btn);layoutClient 挂 GuideProvider;首页挂 GuideHomeCard;抽屉三 tab 的 testid 在", () => {
    expect(read("components/layout/Header.tsx")).toContain('data-testid="guide-open-btn"');
    const lc = read("app/layoutClient.tsx");
    expect(lc).toContain("<GuideProvider>");
    expect(lc).toContain("</GuideProvider>");
    expect(read("app/page.tsx")).toContain("<GuideHomeCard />");
    const d = read("components/guide/OperationGuideDrawer.tsx");
    for (const id of ["guide-drawer", "guide-tab-page", "guide-tab-start", "guide-tab-region", "guide-goto", "guide-auto-toggle", "guide-current-page"]) expect(d).toContain(id);
  });
});
