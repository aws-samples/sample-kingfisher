// @kf-batch 50-P50.3b-3-p0e-baseline
// 🔴 源码卫生门禁:生产源码里不许出现**不可见控制字符 / 零宽字符**。
//
// 【为什么加这条(刚被咬过)】P0-E 判据的第一版 TS 文件里混进了 5 个字面 NUL 字节(本该是空格):
//   `tsc` 全绿、单测全绿、肉眼 review 看不出 —— 因为它只改变**字符串字面量的内容**:
//   `canonicalPlanText` 拼出的行里那个空格变成了 NUL,于是 `planHash` 与 build 侧永不相等
//   ⇒ **P0-E 的审批永远匹配不上**(审批闸从"守门"退化成"永远拦死",且只在真环境暴露)。
//   是跨边界 parity 门禁把它逮住的 —— 但那是运气:同类字符落在正则/比较/资源名里未必有 parity 覆盖。
//   ⇒ 用一条最便宜的扫描把整类钉死。
//
// 🔴 本文件自身也要过这条扫描 ⇒ 正则与样本**一律用转义/fromCharCode 构造**,绝不写字面控制字符。
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");

/** 扫描面:平台源码 + infra 的 TS/mjs(两侧都可能被同类字符咬)。 */
const ROOTS = ["platform/src", "infra/lib", "infra/scripts", "infra/lambda", "infra/bin"];

/**
 * 禁止的码点(**收窄到真正没有正当用途的那类**):
 *   · C0 控制字符(除 tab / LF / CR)—— 事故里的 NUL 即在此;
 *   · 零宽字符 U+200B..U+200D / U+2060 / U+FEFF。
 * 🔴 刻意**不禁** U+00A0 / U+3000 这类"有可见宽度的空格":本仓 UI 文案大量是中文,
 *    全角空格在中文排版里是合法字符(第一版把它也禁了,直接误咬既有中文页面)。
 */
const FORBIDDEN = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u200B-\\u200D\\u2060\\uFEFF]");

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e === "cdk.out") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(e)) out.push(p);
  }
  return out;
}

describe("🔴 源码卫生:不许有不可见控制字符 / 零宽字符", () => {
  it("扫描面有效(改目录结构后不许静默扫 0 个文件)", () => {
    const files = ROOTS.flatMap((r) => walk(resolve(REPO, r)));
    expect(files.length, "一个文件都没扫到 = 门禁失效").toBeGreaterThan(200);
  });

  it("平台源码 + infra 的 TS/mjs 全部干净(逐文件逐行报位置与码点)", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const f of walk(resolve(REPO, root))) {
        const src = readFileSync(f, "utf8");
        if (!FORBIDDEN.test(src)) continue;
        const lines = src.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const m = FORBIDDEN.exec(lines[i]);
          if (m) {
            const cp = (m[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
            offenders.push(`${relative(REPO, f)}:${i + 1} 含 U+${cp}(要表达该字符请用转义)`);
          }
        }
      }
    }
    expect(offenders, "🔴 源码含不可见字符 —— tsc 与肉眼都看不出,却会静默改变字符串字面量").toEqual([]);
  });

  it("门禁会咬:对已知坏样本必命中,对正常中文源码不误咬", () => {
    const NUL = String.fromCharCode(0);
    const ZWSP = String.fromCharCode(0x200b);
    const ZWJ = String.fromCharCode(0x200d);
    const BOM = String.fromCharCode(0xfeff);
    const NBSP = String.fromCharCode(0xa0);
    const IDEO = String.fromCharCode(0x3000);

    // 真实事故样本:模板串里的空格被写成了 NUL
    expect(FORBIDDEN.test("rows.push(`${s.stackName}" + NUL + "EMPTY`)")).toBe(true);
    expect(FORBIDDEN.test("const a = 1;" + ZWSP)).toBe(true);
    expect(FORBIDDEN.test("if (a" + ZWJ + "=== b) {}")).toBe(true);
    expect(FORBIDDEN.test("const x = 1;" + BOM)).toBe(true);

    // 合法:制表/换行/回车 + 中文与全角标点 + 全角/不换行空格
    expect(FORBIDDEN.test("const a = 1;\n\tconst b = 2;\r\n")).toBe(false);
    expect(FORBIDDEN.test('const s = "中文与全角标点:、。()「」";')).toBe(false);
    expect(FORBIDDEN.test("说明:" + IDEO + "缩进")).toBe(false);
    expect(FORBIDDEN.test("a" + NBSP + "b")).toBe(false);
  });
});
