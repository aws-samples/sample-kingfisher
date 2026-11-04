#!/usr/bin/env node
/**
 * 🔴 **基于 AST 的调用点计数**(照 `i18n-extract.mjs` 的独立脚本范式放在 platform/scripts)。
 *
 * 【为什么需要它】外部审核 v2 的五个"我为什么看不出"里,第 ④ 条是**量具错了两次且从不校准量具**:
 * 我用 `grep -c` 数调用点,把**注释行**和**自引用**也数了进去;更糟的是我专门发了一笔"订正口径"
 * 的提交,**订正后仍然算错**(17/15 → 真实 16/14)。审核员用的是 AST。
 * ⇒ 以后凡是要把"有多少处调用"写进注释 / 提交信息 / 台账的,一律跑这个脚本,不许用 grep 目测。
 *
 * 用法(在 platform/ 下):
 *   node scripts/ast-count-callsites.mjs getRedshiftSecretArn getZeroEtlSecretArn
 *   node scripts/ast-count-callsites.mjs --include-tests getPrivilegedCred
 *
 * 计数口径(与审核员一致,写死在这里免得下次又各说各话):
 *   · 只数**调用表达式**(`CallExpression` 的被调者标识符),不数 import、类型引用、注释、字符串;
 *   · 默认**排除** `__tests__` 与 `*.test.ts`(它们不是生产调用面);`--include-tests` 可打开;
 *   · 默认**排除函数自身的定义文件**(自引用会把"还有多少处要迁移"算大);`--include-self` 可打开;
 *   · 输出"表达式数"与"文件数"两个口径 —— 报告里必须写清是哪一个(混用是上次算错的原因之一)。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const args = process.argv.slice(2);
const includeTests = args.includes("--include-tests");
const includeSelf = args.includes("--include-self");
const names = args.filter((a) => !a.startsWith("--"));
if (!names.length) {
  console.error("用法:node scripts/ast-count-callsites.mjs <函数名> [更多函数名] [--include-tests] [--include-self]");
  process.exit(2);
}

const ROOT = join(process.cwd(), "src");

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!includeTests && e === "__tests__") continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(p)) {
      if (!includeTests && /\.test\.tsx?$/.test(p)) continue;
      out.push(p);
    }
  }
  return out;
}

/** 被调者的"名字":`f()` → f;`obj.f()` → f。取最末一段,与审核口径一致。 */
function calleeName(node) {
  const e = node.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) return e.name.text;
  return null;
}

const files = walk(ROOT);
const result = new Map(names.map((n) => [n, { calls: 0, files: new Map(), declaredIn: [] }]));

for (const file of files) {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const rel = relative(process.cwd(), file);
  const visit = (node) => {
    // 记录声明处,用于 --include-self 的判断
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      result.has(node.name.text)
    ) {
      result.get(node.name.text).declaredIn.push(rel);
    }
    if (ts.isCallExpression(node)) {
      const n = calleeName(node);
      if (n && result.has(n)) {
        const r = result.get(n);
        const line = src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1;
        if (!r.files.has(rel)) r.files.set(rel, []);
        r.files.get(rel).push(line);
        r.calls++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
}

let exit = 0;
for (const [name, r] of result) {
  const own = new Set(r.declaredIn);
  const entries = [...r.files.entries()].filter(([f]) => includeSelf || !own.has(f));
  const calls = entries.reduce((a, [, lines]) => a + lines.length, 0);
  console.log(`\n=== ${name} ===`);
  console.log(`调用表达式 ${calls} 处,分布 ${entries.length} 个文件` + (includeTests ? "(含测试)" : "(不含测试)"));
  if (own.size && !includeSelf) console.log(`(已排除定义文件自引用:${[...own].join(", ")})`);
  for (const [f, lines] of entries.sort()) console.log(`  ${f}:${lines.join(",")}`);
  if (!calls) exit = 0;
}
process.exit(exit);
