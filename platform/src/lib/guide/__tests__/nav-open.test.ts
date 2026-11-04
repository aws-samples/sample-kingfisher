// 导览锚点**可达性**的单测(部署后真环境抓到的缺口:首次进站 7 个菜单分类全收起 ⇒
// `nav-/sync` 在 DOM 里 count=0 ⇒ 导览第一步就报「控件不在页面上」,31 个菜单锚点里只有顶层叶子可达)。
//
// 🔴 这里测两层:
//   ① 规则本体(纯函数,含「无需变更返回原引用」这条防抖动性质);
//   ② **真实菜单树**上的性质 —— 每条动线步的 path 都能被展开到(树从 routes.tsx **文本**解析,
//      因为 tsconfig `jsx: preserve` + vitest `environment: node` 下 import .tsx 会直接解析失败)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { JOURNEYS } from "@/lib/guide/content";
import { expandJourney } from "@/lib/guide/tour";
import { parentGroupKeyOf, withParentGroupOpen, type NavNodeLike } from "@/lib/guide/nav-open";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1 ");

/**
 * 从 routes.tsx **文本**还原「分类 → 子项」结构(与 content.test.ts 同一手法)。
 * 🔴 按**缩进**解析,不写一条能横跨多行的巨型正则 —— 第一版正则假设 `key/icon/label/children`
 *    写在同一行,实测一个叶子都没解析出来;是本文件那条「解析出的树本身可信」的兜底判据当场逮住的
 *    (否则下面那条「每个 nav 步都能展开到」就是**空断言**)。
 */
function realTree(): NavNodeLike[] {
  const src = read("components/layout/routes.tsx");
  const block = src.slice(src.indexOf("export const menuTree"));
  const out: NavNodeLike[] = [];
  let group: { key: string; children: Array<{ key: string }> } | null = null;
  for (const line of block.split("\n")) {
    if (/^\];/.test(line)) break;
    let m = /^ {2}\{ key: "(\/[^"]*)"/.exec(line);           // 顶层叶子
    if (m) { out.push({ key: m[1] }); group = null; continue; }
    m = /^ {4}key: "([^"]+)",/.exec(line);                    // 分类
    if (m) { group = { key: m[1], children: [] }; out.push(group); continue; }
    m = /^ {6}\{ key: "(\/[^"]*)"/.exec(line);               // 分类子项
    if (m && group) group.children.push({ key: m[1] });
  }
  return out;
}

describe("规则本体:把某个路由所属的菜单分类并进已展开集合", () => {
  const tree: NavNodeLike[] = [
    { key: "grp-a", children: [{ key: "/x" }, { key: "/y" }] },
    { key: "grp-b", children: [{ key: "/z" }] },
    { key: "/top" },
  ];

  it("分类里的子项 ⇒ 补上它所属分类,已展开的其它分类**保留**", () => {
    expect(withParentGroupOpen(tree, [], "/x")).toEqual(["grp-a"]);
    expect(withParentGroupOpen(tree, ["grp-b"], "/x")).toEqual(["grp-b", "grp-a"]);
  });

  it("🔴 无需变更时返回**原数组引用**(每轮都造新数组会让菜单动画反复重播、并冲掉用户手动收起的分类)", () => {
    const prev = ["grp-a"];
    expect(withParentGroupOpen(tree, prev, "/x"), "已展开 ⇒ 原引用").toBe(prev);
    expect(withParentGroupOpen(tree, prev, "/top"), "顶层叶子不属于任何分类 ⇒ 原引用").toBe(prev);
    expect(withParentGroupOpen(tree, prev, "/不存在"), "未知路由 ⇒ 原引用").toBe(prev);
    expect(withParentGroupOpen(tree, prev, null), "没在导览 ⇒ 原引用").toBe(prev);
  });

  it("判别力:问的是别的路由就**不该**展开(否则「补上分类」这条断言等于恒真)", () => {
    expect(parentGroupKeyOf(tree, "/z")).toBe("grp-b");
    expect(parentGroupKeyOf(tree, "/top")).toBeUndefined();
    expect(parentGroupKeyOf(tree, "/nope")).toBeUndefined();
    expect(withParentGroupOpen(tree, [], "/z")).not.toContain("grp-a");
  });
});

describe("🔴🔴 真实菜单树:每一个导览步的锚点都要能被展开到", () => {
  const tree = realTree();

  it("解析出的树本身可信(≥ 6 个分类、≥ 25 个叶子)—— 解析失败会让下面那条判据变成空断言", () => {
    const groups = tree.filter((n) => n.children?.length);
    const leaves = tree.flatMap((n) => (n.children?.length ? n.children.map((c) => c.key) : [n.key]));
    expect(groups.length, `分类数=${groups.length}`).toBeGreaterThanOrEqual(6);
    expect(leaves.length, `叶子数=${leaves.length}`).toBeGreaterThanOrEqual(25);
    expect(new Set(leaves).size, "叶子 key 不许重复").toBe(leaves.length);
  });

  it("每条动线的每个 nav 步:要么是顶层叶子,要么能定位到它所属分类(定位不到 ⇒ 那一步永远高亮不到)", () => {
    const bad: string[] = [];
    const leaves = new Set(tree.flatMap((n) => (n.children?.length ? n.children.map((c) => c.key) : [n.key])));
    for (const j of JOURNEYS) {
      for (const s of expandJourney(j)) {
        if (s.kind !== "nav") continue;
        if (!leaves.has(s.path)) { bad.push(`${j.key}/${s.title}:${s.path} 不是菜单叶子`); continue; }
        const top = tree.some((n) => !n.children?.length && n.key === s.path);
        if (!top && !parentGroupKeyOf(tree, s.path)) bad.push(`${j.key}/${s.title}:${s.path} 找不到所属分类`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("🔴 Sidebar 真的把这条规则接上了:两个消费者(切页 / 导览当前步)都走同一个函数,本地副本已删", () => {
    const sb = strip(read("components/layout/Sidebar.tsx"));
    const calls = sb.match(/withParentGroupOpen\(menuTree/g) ?? [];
    expect(calls.length, "切页自动展开 + parentKeyOf + 导览步,三处都必须走单一作者").toBe(3);
    expect(sb, "本地又抄了一遍遍历 ⇒ 两处规则必然漂移").not.toMatch(/for \(const n of menuTree\)/);
    // 导览那一支必须真的用**导览步的 path**(用 pathname 就等于没接)
    expect(sb).toContain("tourStepAt(tourJourney, tourIndex)?.path");
    expect(sb).toContain("withParentGroupOpen(menuTree, prev, tourStepPath)");
    // 侧栏收起时菜单只剩图标 ⇒ 锚点不可见,导览开跑必须先展开侧栏
    expect(sb).toMatch(/if \(!tourStepPath\) return;\s*setCollapsed\(false\);/);
  });
});
