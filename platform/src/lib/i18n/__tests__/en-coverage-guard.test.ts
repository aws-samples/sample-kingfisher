// 序 49 ⑤ UX ① —— 英文模式覆盖守卫:页面 / 组件里每个 t("中文") 字面键都必须在英文词典有译;
//   title / placeholder 等字符串属性与单行 JSX 文本节点不许再出现没走 t() 的中文。
//
// 【缺陷原形(用户 2026-10-20 走查 …7237 英文模式)】菜单 / 标题英文,大量字段 / 弹窗 / 卡片中文(「执行区域(可多选)」「新建执行环境」
//   「法域标记」「OpenMetadata 接线」…):t() 对未命中的键优雅降级回中文 ⇒ 没人发现词典缺了 685 条。
// 【守卫】只减不增:扫描 app / components / lib 下全部 .tsx(排除 __tests__ 与皮肤预览模块 theme-gallery / theme-preview ——
//   后者是「独立静态预览模块,不影响现有平台主题」的假数据样张,不是产品功能),字面键缺译 ⇒ 红;裸中文属性 / 文本 ⇒ 红。
//   t(变量) / t(`模板`) 这类动态键扫不到,由各处判据自己盯。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { EN } from "@/lib/i18n/messages/en";

const SRC = path.join(process.cwd(), "src");
const CJK = /[一-鿿]/;
const SKIP_DIRS = ["__tests__", "theme-gallery", "theme-preview"];

function* tsxFiles(dir: string): Generator<string> {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.includes(ent.name)) continue;
      yield* tsxFiles(full);
    } else if (ent.name.endsWith(".tsx")) yield full;
  }
}
const files = ["app", "components", "lib"].flatMap((d) => Array.from(tsxFiles(path.join(SRC, d))));
function* allFiles(dir: string): Generator<string> {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.includes(ent.name)) continue;
      yield* allFiles(full);
    } else if (ent.name.endsWith(".tsx") || ent.name.endsWith(".ts")) yield full;
  }
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** t("…") / t('…') 的字面键(含转义引号);模板串与变量键不在此列 */
function literalKeys(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\bt\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g)) {
    const raw = m[1] ?? m[2];
    if (raw === undefined) continue;
    out.push(raw.replace(/\\"/g, '"').replace(/\\'/g, "'"));
  }
  return out;
}

describe("🔴 UX ① 英文词典覆盖守卫", () => {
  it("每个 t(\"中文\") 字面键都在英文词典里(缺一条 = 英文模式那一处显中文)", () => {
    expect(files.length).toBeGreaterThan(100);
    const missing: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      for (const k of literalKeys(src)) {
        if (CJK.test(k) && !(k in EN)) missing.push(`${path.relative(SRC, f)}: ${k}`);
      }
    }
    expect(missing, `英文词典缺 ${missing.length} 条:\n${missing.slice(0, 40).join("\n")}`).toEqual([]);
  });

  it("英文译文自身不含 CJK(词典里不许夹中文)", () => {
    const bad = Object.entries(EN).filter(([zh, en]) => CJK.test(en) && !zh.includes("{{"));
    expect(bad.map(([zh, en]) => `${zh} => ${en}`)).toEqual([]);
  });

  it("客户端文件里对象字面量的中文属性值(label / text / hint / desc …,经 t(x.text) 动态键渲染)也必须在词典里(p49 UX1 真环境抓到 3 条漏网)", () => {
    const clientFiles = ["app", "components"].flatMap((d) => Array.from(allFiles(path.join(SRC, d)))).filter((f) => !f.includes(`${path.sep}app${path.sep}api${path.sep}`));
    const propRe = /\b(label|title|desc|description|hint|tip|placeholder|text|message)\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    const missing: string[] = [];
    for (const f of clientFiles) {
      const src = stripComments(fs.readFileSync(f, "utf8"));
      for (const m of src.matchAll(propRe)) {
        const v = m[2].replace(/\\"/g, '"');
        if (CJK.test(v) && !(v in EN)) missing.push(`${path.relative(SRC, f)}: ${m[1]}: ${v}`);
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("title / placeholder / label 等字符串属性与单行 JSX 文本节点不许有没走 t() 的中文", () => {
    const offenders: string[] = [];
    const propRe = /\b(title|placeholder|label|description|tooltip|extra|okText|cancelText|addonBefore|addonAfter|tip)=\s*"([^"\n]*[一-鿿][^"\n]*)"/g;
    const textRe = />[ \t]*([^<>{}\n]*[一-鿿][^<>{}\n]*)</g;
    for (const f of files) {
      const src = stripComments(fs.readFileSync(f, "utf8"));
      for (const m of src.matchAll(propRe)) offenders.push(`${path.relative(SRC, f)}: ${m[1]}="${m[2]}"`);
      for (const m of src.matchAll(textRe)) offenders.push(`${path.relative(SRC, f)}: >${m[1].trim()}<`);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
