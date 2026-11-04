// 2026-11-04 用户:「所有文档都没有换行,都堆到一起」—— 台账 / 排期把一条缺陷 / 一个功能包的整部历史塞进一个
// 表格单元格(最长行 17003 / 14910 字符)。`scripts/lib/docs_restructure.py` 把两份文件机械无损地改成
// 「索引表 + 每条一个小节」之后,这里守住它**不许回退**:
//   · 非表格行 ≤ 300 字符;表格**单元格** ≤ 200 字符(表格行本身不按 300 判:4 列 × 合法的 200 字符必然 > 300);
//   · 围栏代码块(``` / ~~~)与 HTML 块行不判(重构规则 ①:它们原样不动)。
// 🔴 口径与 `docs_restructure.py check` 是同一份(改一处要同步另一处;自检用同一组合成样例交叉验证)。
// 🔴 允许名单是**闭合**的:只有列在这里的文件才被守;新文件按 generic 模式重构过之后再加进来(只增不减)。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const PLATFORM = process.cwd();
const REPO = path.resolve(PLATFORM, "..");

export const LINE_LIMIT = 300;
export const CELL_LIMIT = 200;

/** 受守的文件 = 仓库里**全部**被 git 跟踪的 .md(2026-11-04 用户:所有 .md 都要有格式)。
 *  新增一份 .md 先用 `scripts/lib/docs_restructure.py check` 自查。
 *  唯一例外 README.md(2026-11-04 用户:README 保持完整句子与完整单元格,不为长度拆句、不截单元格;GitHub 会自动折行)。 */
export const MACHINE_READ_CONTRACTS: readonly string[] = ["README.md"];
export const GUARDED_DOCS: readonly string[] = (() => {
  const { execSync } = require("node:child_process") as typeof import("node:child_process");
  const out = execSync("git ls-files -z -- '*.md'", { cwd: REPO, encoding: "utf8" });
  return out.split("\0").filter(Boolean).filter((f) => !MACHINE_READ_CONTRACTS.some((m) => f === m || f.startsWith(m))).sort();
})();

const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const TABLE_RE = /^(\s*(?:>\s*)?)\|/;
const DELIM_RE = /^\s*(?:>\s*)?\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const HTML_RE = /^\s*<[A-Za-z!/]/;

/** 字符数按 code point 数(与 Python `len()` 一致;emoji 不算两个)。 */
const cp = (s: string) => Array.from(s).length;

export function splitRow(line: string): string[] {
  let s = line.trim().replace(/^>\s*/, "");
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}

export interface Offender { line: number; why: string }

export function checkText(text: string, lineLimit = LINE_LIMIT, cellLimit = CELL_LIMIT): Offender[] {
  const bad: Offender[] = [];
  let inCode: { ch: string; len: number } | null = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const fm = FENCE_RE.exec(ln);
    if (inCode) {
      if (fm && fm[2][0] === inCode.ch && fm[2].length >= inCode.len && !fm[3].trim()) inCode = null;
      continue;
    }
    if (fm) {
      inCode = { ch: fm[2][0], len: fm[2].length };
      continue;
    }
    if (HTML_RE.test(ln)) continue;
    if (TABLE_RE.test(ln)) {
      if (DELIM_RE.test(ln)) continue;
      splitRow(ln).forEach((c, j) => {
        if (cp(c) > cellLimit) bad.push({ line: i + 1, why: `单元格(第 ${j + 1} 列)${cp(c)} 字符 > ${cellLimit}:${c.slice(0, 60)}…` });
      });
      continue;
    }
    if (cp(ln) > lineLimit) bad.push({ line: i + 1, why: `行 ${cp(ln)} 字符 > ${lineLimit}:${ln.trim().slice(0, 60)}…` });
  }
  return bad;
}

describe("🔴 文档格式守卫:台账 / 排期不许再把整部历史堆进一行 / 一格", () => {
  it("允许名单闭合且每份文件都存在", () => {
    expect(GUARDED_DOCS.length).toBeGreaterThanOrEqual(2);
    for (const rel of GUARDED_DOCS) expect(fs.existsSync(path.join(REPO, rel)), `${rel} 不存在`).toBe(true);
  });

  for (const rel of GUARDED_DOCS) {
    it(`${rel}:非表格行 ≤ ${LINE_LIMIT} 字符、表格单元格 ≤ ${CELL_LIMIT} 字符(代码块 / HTML 块除外)`, () => {
      const text = fs.readFileSync(path.join(REPO, rel), "utf8");
      const bad = checkText(text);
      expect(
        bad.map((b) => `${rel}:${b.line}: ${b.why}`).slice(0, 20),
        `${rel} 有 ${bad.length} 处超限 ⇒ 用 \`python3 -I scripts/lib/docs_restructure.py check ${rel}\` 看全部;新内容按小节写,长句按「;」「。」切成 \`- \` 项`
      ).toEqual([]);
    });
  }


  it("判据自身有判别力:301 字符行红 / 201 字符单元格红 / 代码块与 HTML 块里不判 / 合法样例绿", () => {
    expect(checkText("x".repeat(301) + "\n").length).toBe(1);
    expect(checkText(`| a | ${"y".repeat(201)} |\n|---|---|\n`).length).toBe(1);
    expect(checkText(`| a | ${"y".repeat(200)} | ${"z".repeat(200)} |\n|---|---|---|\n`)).toEqual([]); // 行 > 300 但每格合法
    expect(checkText("```\n" + "x".repeat(500) + "\n```\n")).toEqual([]);
    expect(checkText("<div>" + "z".repeat(500) + "</div>\n")).toEqual([]);
    expect(checkText("```\n| a | " + "y".repeat(300) + " |\n```\n")).toEqual([]); // 代码块里的伪表格行不判
    expect(checkText("- 一句;\n  - 第二句。\n> 引用\n### 标题\n")).toEqual([]);
    // emoji 按 code point 数:150 个 🔴 = 150 字符,不是 300
    expect(checkText("🔴".repeat(150) + "\n")).toEqual([]);
  });
});
