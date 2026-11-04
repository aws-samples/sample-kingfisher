// i18n 词条抽取器 —— 扫描全站 t("...") / t('...') 调用,提取中文 key,与 en.ts 比对。
// 用法:node scripts/i18n-extract.mjs [--missing]
//   默认:打印统计(总去重 key 数 / 已覆盖 / 缺失)
//   --missing:把缺失的中文 key 每行一个打印(可重定向给翻译流程)
//   --json:输出缺失 key 的 JSON 数组
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(process.cwd(), "src");
const EN_PATH = path.resolve(SRC, "lib/i18n/messages/en.ts");

// 递归收集 .tsx/.ts(排除测试与 i18n 模块自身的字典)
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(tsx|ts)$/.test(e.name) && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

// 从源码里提取 t("...") / t('...') 的第一个字符串参数(含中文的才算 i18n key)。
// 支持转义引号;跳过模板串(反引号)——项目约定模板串必须写成 t("...{x}", {x})。
const CJK = /[一-鿿]/;
function extractKeys(code) {
  const keys = new Set();
  // 匹配 t(" ... ") 或 t(' ... '),允许前面是非标识符字符(避免匹配 xxxt( )
  const re = /(?<![A-Za-z0-9_$])t\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  let m;
  while ((m = re.exec(code))) {
    const raw = m[1];
    // 去掉外层引号并还原转义
    const inner = raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
    if (CJK.test(inner)) keys.add(inner);
  }
  return keys;
}

// 读取 en.ts 已有的 key(行首 "key": "val")
function existingKeys() {
  const txt = fs.readFileSync(EN_PATH, "utf8");
  const set = new Set();
  const re = /^\s*"((?:[^"\\]|\\.)*)":\s*"/gm;
  let m;
  while ((m = re.exec(txt))) {
    set.add(m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\"));
  }
  return set;
}

const files = walk(SRC);
const all = new Set();
for (const f of files) {
  if (f === EN_PATH) continue;
  for (const k of extractKeys(fs.readFileSync(f, "utf8"))) all.add(k);
}
const have = existingKeys();
const missing = [...all].filter((k) => !have.has(k)).sort();

const arg = process.argv[2];
if (arg === "--missing") {
  console.log(missing.join("\n"));
} else if (arg === "--json") {
  console.log(JSON.stringify(missing, null, 2));
} else {
  console.log(`[i18n] 全站去重中文 key: ${all.size}`);
  console.log(`[i18n] 字典已覆盖:       ${all.size - missing.length}`);
  console.log(`[i18n] 缺失待翻译:       ${missing.length}`);
}
