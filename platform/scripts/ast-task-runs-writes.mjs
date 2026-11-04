#!/usr/bin/env node
/**
 * 🔴 **`bgp-task-runs` 写入点的 AST 清单**(W2-a 的量具)。
 *
 * 【为什么必须是 AST 而不是 grep】同一个数字在三份文档里有三种写法:
 * 50 ROADMAP 写「13 写入点」、52 DESIGN §11.3 写「27 处」、50 SPEC §5 写「13 建行 + 14 回写 = 27」。
 * 我自己用 `grep -B8 "TableName: TABLES.TASK_RUNS"` 数出来是 26 —— 而那 8 行窗口会把
 * **相邻的别表写入**(实测 `lib/baseline/learn.ts` 的 `TABLES.BASELINES`)算进来。
 * 量具错了两次且从不校准量具,是外部审核 v2 点名的老病(见 `ast-count-callsites.mjs` 抬头)。
 *
 * 判据(写死在这里,免得下次又各说各话):
 *   · 只认 `new (Put|Update|Delete)Command({ … })` 这种**带对象字面量实参**的写调用;
 *   · 该对象字面量里 `TableName` 必须是 `TABLES.TASK_RUNS` 或字面量 `"bgp-task-runs"`;
 *   · 变量间接(`const p = {...}; new UpdateCommand(p)`)**单独列为 indirect**,不混进主计数 ——
 *     它们同样要迁移,但需要人看一眼(这类正是"门禁扫不到"的暗礁)。
 *
 * 用法(在 platform/ 下):
 *   node scripts/ast-task-runs-writes.mjs            # 人读清单
 *   node scripts/ast-task-runs-writes.mjs --json     # 给门禁/脚本吃
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const asJson = process.argv.includes("--json");
const includeTests = process.argv.includes("--include-tests");
const ROOT = join(process.cwd(), "src");
const WRITE_CTORS = new Set(["PutCommand", "UpdateCommand", "DeleteCommand", "PutItemCommand", "UpdateItemCommand", "DeleteItemCommand", "TransactWriteCommand", "BatchWriteCommand"]);

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

/** `TABLES.TASK_RUNS` 或 `"bgp-task-runs"` ⇒ true。 */
function isTaskRunsTable(expr) {
  if (!expr) return false;
  if (ts.isPropertyAccessExpression(expr)) {
    return ts.isIdentifier(expr.name) && expr.name.text === "TASK_RUNS";
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text === "bgp-task-runs";
  }
  return false;
}

function ctorName(node) {
  const e = node.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) return e.name.text;
  return null;
}

const direct = [];
const indirect = [];

for (const file of walk(ROOT)) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const rel = relative(ROOT, file);

  const visit = (node) => {
    if (ts.isNewExpression(node)) {
      const name = ctorName(node);
      if (name && WRITE_CTORS.has(name)) {
        const arg = node.arguments?.[0];
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        if (arg && ts.isObjectLiteralExpression(arg)) {
          const tn = arg.properties.find(
            (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "TableName"
          );
          if (tn && isTaskRunsTable(tn.initializer)) {
            direct.push({ file: rel, line, ctor: name });
          }
        } else if (arg && ts.isIdentifier(arg)) {
          // 间接实参:看该变量在本文件里有没有被赋成 task-runs 的参数对象
          const varName = arg.text;
          if (new RegExp(`${varName}\\s*[:=][^\\n]*TASK_RUNS`).test(src) || /TableName:\s*TABLES\.TASK_RUNS/.test(src)) {
            indirect.push({ file: rel, line, ctor: name, via: varName });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const byFile = {};
for (const d of direct) (byFile[d.file] ||= []).push(d);

if (asJson) {
  console.log(JSON.stringify({ direct, indirect, expressions: direct.length, files: Object.keys(byFile).length }, null, 2));
} else {
  for (const f of Object.keys(byFile).sort()) {
    const rows = byFile[f];
    console.log(`${f}  (${rows.length})`);
    for (const r of rows) console.log(`    ${r.ctor.padEnd(16)} :${r.line}`);
  }
  if (indirect.length) {
    console.log("\n⚠️ 间接实参(需人工确认,门禁扫不到的暗礁):");
    for (const r of indirect) console.log(`    ${r.file}:${r.line}  ${r.ctor}(${r.via})`);
  }
  console.log(`\n表达式数 = ${direct.length};文件数 = ${Object.keys(byFile).length}`);
}
