#!/usr/bin/env node
// i18n 缺失检查器 —— 根治"加了中文 UI 文案却忘补英文字典"这类反复出现的疏漏。
//
// 背景:平台"中文即 key",英文查 EN[zh] 字典,缺条目则英文环境回退显示中文(见 lib/i18n/translate.ts)。
// 反复踩坑:开发者(含 AI)加 t("中文")/label:"中文" 却忘往 messages/en.ts 补英文 → 英文界面露出中文。
// 本脚本扫描 src 下所有 t()/label 的中文串,报出 EN 字典缺失的,退出码非0 便于 CI/提交前门禁。
//
// 用法: node scripts/i18n-check-missing.mjs [--json]
// 局限:静态正则提取,只覆盖 t("字面量") 与 label:"字面量";动态拼接的 key 需人工留意。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const EN_FILE = path.join(SRC, "lib/i18n/messages/en.ts");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/node_modules|__tests__/.test(p)) walk(p, out); }
    else if (/\.(tsx|ts)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const en = fs.readFileSync(EN_FILE, "utf8");
const hasCJK = (s) => /[一-鿿]/.test(s);
// 提取 t("...") 与 label:"..."(处理转义引号)。
const T_RE = /\bt\(\s*"((?:[^"\\]|\\.)*)"/g;
const LABEL_RE = /\blabel:\s*"((?:[^"\\]|\\.)*)"/g;

const missing = new Map(); // key -> Set(files)
for (const f of walk(SRC)) {
  if (f === EN_FILE) continue;
  const txt = fs.readFileSync(f, "utf8");
  for (const re of [T_RE, LABEL_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(txt)) !== null) {
      const key = m[1];
      if (!hasCJK(key)) continue;
      // EN 字典是否有该 key(作为 "key": 出现)。
      if (!en.includes(`"${key}"`)) {
        if (!missing.has(key)) missing.set(key, new Set());
        missing.get(key).add(path.relpath ? path.relpath(SRC, f) : f.replace(SRC + "/", ""));
      }
    }
  }
}

const asJson = process.argv.includes("--json");
if (asJson) {
  const obj = {};
  for (const [k, v] of missing) obj[k] = [...v];
  console.log(JSON.stringify({ missingCount: missing.size, missing: obj }, null, 2));
} else {
  if (missing.size === 0) {
    console.log("✅ i18n 无缺失:所有 t()/label 的中文文案在 EN 字典均有英文条目。");
  } else {
    console.log(`❌ i18n 缺失 ${missing.size} 条(英文环境会回退显示中文):\n`);
    for (const [k, files] of [...missing].sort()) {
      console.log(`  ${JSON.stringify(k)}  <- ${[...files].join(", ")}`);
    }
    console.log(`\n修复:往 src/lib/i18n/messages/en.ts 补这些 key 的英文条目(key 须逐字匹配)。`);
  }
}
process.exit(missing.size === 0 ? 0 : 1);
