// 🔴 **同一 region 可以有多个执行目标** —— 生产形态就是单账号 × 多 region,而一个 region 里允许装多套
// (旧环境 `tgt_usw2_a` / `_b` / `_c` 三个都在 us-west-2)。凡是**只用 region 标识来源**的界面元素,
// 在那种形态下都会变成「几个一模一样的标签」,用户没法回答排障第一个问题:「我到底打到哪了」。
//
// 起因(2026-09-11 逐页深挖):新账号跨区装不出来 ⇒ 第二个执行目标与主控区**同区**,
// 直查「⚖ 对比」的两张 sheet 标签都只写 `us-east-1` ⇒ 判据点中了主控区那张(而它以为点的是另一个目标)。
// 那不是判据的运气问题:**产品在这种形态下确实无法分辨**。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("同区多目标:界面必须能分辨「哪一个执行目标」", () => {
  const FILE = "components/redshift/MultiRegionResults.tsx";

  it("🔴🔴 直查 sheet 的 tab 标签:region 不唯一时必须带 targetId", () => {
    const src = strip(read(FILE));
    // 判据形态:先算「这个 region 在本次提交里是否不唯一」,再据此决定标签
    expect(src, "缺 regionAmbiguous 判定 ⇒ 标签仍只写 region").toMatch(
      /const regionAmbiguous\s*=\s*\(region: string\)\s*=>\s*submissions\.filter\(\(x\)\s*=>\s*x\.region === region\)\.length > 1/
    );
    // 🔴 必须真的用在 tab 标签上(只定义不用 = 白改)
    expect(src, "tab 标签没用 regionAmbiguous").toMatch(/regionAmbiguous\(s\.region\)\s*\?/);
    expect(src, "不唯一分支里没带 targetId").toMatch(/regionAmbiguous\(s\.region\)\s*\?[^:]*s\.targetId/);
  });

  it("🔴 合并表的「来源」列必须按 targetId(只写 region ⇒ 同区两目标的行来源一模一样)", () => {
    const src = strip(read(FILE));
    expect(src, "合并行没带 __targetId").toMatch(/__targetId:\s*s\.targetId/);
    expect(src, "来源列没用 __targetId").toMatch(/dataIndex:\s*"__targetId"/);
    // 反向:不许再退回「来源区域只有 __region」那一列
    expect(src, "来源列又退回只写 __region").not.toMatch(/title:\s*t\("来源区域"\),\s*dataIndex:\s*"__region"/);
  });

  it("🔴 「对比」表本来就对(targetId 是主标)—— 钉住它不许退化", () => {
    const src = strip(read(FILE));
    expect(src).toMatch(/dataIndex:\s*"region"[\s\S]{0,200}r\.targetId/);
  });
});
