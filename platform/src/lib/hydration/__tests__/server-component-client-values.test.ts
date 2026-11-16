// 🔴 棘轮:服务端组件不许从带 "use client" 的模块导入**值**(只许导入组件、并且只当 JSX 标签用)。
//
// 事实(2026-11-14 两个测试环境页面探针坐实):根布局(服务端组件)从客户端模块导入了一个字符串常量写进 <head> 的内联脚本。
//   服务端组件从客户端模块拿到的不是值本身,而是「客户端引用」:服务端渲染 HTML 时能直接求值,所以 HTML 没毛病;
//   但浏览器端这个引用要等那个客户端模块的全部分片到齐才解析 ⇒ 用到它的那个元素在浏览器端成了延迟解析的元素。
//   它在 <head> 里时,分片恰在水合 <head> 的那一刻到齐,React 会把 <head> 重放一遍,水合游标回不到 <body>
//   ⇒ 页面级报错「水合不一致」,整棵页面树在浏览器重建一次。全新浏览器会话首开任意页面间歇出现,同一会话后续页面不出现。
//
// 机械规则:src/app 下每个服务端组件入口文件(没有 "use client" 的 layout / page / template / loading / error / not-found / default)
//   从客户端模块(含经普通模块转手再导出的)导入的每个名字 —— 必须大写开头,且在文件里只出现在 JSX 标签位置(<Name … / </Name>)。
//   值(字符串 / 对象 / 函数)要给服务端组件用,就定义在普通模块里。
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const SRC = join(__dirname, "../../..");
const ENTRY = /^(layout|page|template|loading|error|global-error|not-found|default)\.tsx$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "__tests__" || n === "node_modules" || n === "api") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (ENTRY.test(n)) out.push(p);
  }
  return out;
}

/** 文件的第一条语句是不是 "use client"(跳过开头的注释与空行)。 */
function isClientModule(src: string): boolean {
  const body = src.replace(/^(?:\s+|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
  return /^["']use client["']/.test(body);
}

/** 把导入说明符解析成 src 内的文件;外部包 / 样式 / 解析不到 ⇒ null。 */
function resolveLocal(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = join(dirname(fromFile), spec);
  else return null;
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(cand) && statSync(cand).isFile() && /\.tsx?$/.test(cand)) return cand;
  }
  return null;
}

interface ImportedName { local: string; imported: string; spec: string }

/** 值导入(不含 `import type …` 与 `{ type X }`)。 */
function valueImports(src: string): ImportedName[] {
  const out: ImportedName[] = [];
  const re = /^import\s+(?!type\s)([^;]*?)\s+from\s+["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const clause = m[1];
    const spec = m[2];
    const named = /\{([\s\S]*?)\}/.exec(clause);
    const head = clause.replace(/\{[\s\S]*?\}/, "").replace(/,/g, " ").trim();
    for (const tok of head.split(/\s+/).filter(Boolean)) {
      if (tok === "*" || tok === "as") continue;
      out.push({ local: tok, imported: head.includes("* as") ? "*" : "default", spec });
    }
    if (named) {
      for (const part of named[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        if (part.startsWith("type ")) continue;
        const [imported, local] = part.split(/\s+as\s+/);
        out.push({ local: (local || imported).trim(), imported: imported.trim(), spec });
      }
    }
  }
  return out;
}

/** 这个名字最终是不是出自客户端模块(普通模块 `export { x } from` / `export * from` 转手也算;最多追 6 层)。 */
function comesFromClientModule(file: string, imported: string, depth = 0): boolean {
  const src = readFileSync(file, "utf8");
  if (isClientModule(src)) return true;
  if (depth >= 6) return false;
  const re = /^export\s+(\*|\{[\s\S]*?\})\s+from\s+["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const target = resolveLocal(file, m[2]);
    if (!target) continue;
    if (m[1] === "*") {
      if (imported !== "default" && comesFromClientModule(target, imported, depth + 1)) return true;
      continue;
    }
    for (const part of m[1].slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean)) {
      const [orig, alias] = part.split(/\s+as\s+/);
      if ((alias || orig).trim() === imported && comesFromClientModule(target, orig.trim(), depth + 1)) return true;
    }
  }
  return false;
}

/** 名字在文件正文(去掉 import 语句)里是否只出现在 JSX 标签位置。 */
function onlyUsedAsJsxTag(src: string, name: string): boolean {
  const body = src.replace(/^import[^;]*;?$/gm, "");
  const all = body.match(new RegExp(`\\b${name}\\b`, "g")) || [];
  const tags = body.match(new RegExp(`</?${name}\\b`, "g")) || [];
  return all.length > 0 && all.length === tags.length;
}

function violations(files: string[]): string[] {
  const bad: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (isClientModule(src)) continue;
    for (const imp of valueImports(src)) {
      const target = resolveLocal(f, imp.spec);
      if (!target || !comesFromClientModule(target, imp.imported)) continue;
      if (/^[A-Z]/.test(imp.local) && onlyUsedAsJsxTag(src, imp.local)) continue;
      bad.push(`${relative(SRC, f)} :: 从客户端模块 ${imp.spec} 导入了值「${imp.local}」`);
    }
  }
  return bad;
}

describe("服务端组件不从客户端模块取值(水合安全)", () => {
  const entries = walk(join(SRC, "app"));

  it("src/app 下确有服务端组件入口(根布局),规则不是空转", () => {
    const server = entries.filter((f) => !isClientModule(readFileSync(f, "utf8"))).map((f) => relative(SRC, f));
    expect(server).toContain("app/layout.tsx");
  });

  it("每个服务端组件入口:从客户端模块导入的名字只许是当 JSX 标签用的组件", () => {
    expect(violations(entries), "值要给服务端组件用就定义在普通模块里(不带 \"use client\");客户端模块只导出组件给服务端组件当标签用").toEqual([]);
  });

  it("规则有判别力:把根布局的早期脚本改回从换肤提供者(客户端模块)导入 ⇒ 被抓到;经普通模块转手再导出也被抓到", () => {
    const layout = join(SRC, "app/layout.tsx");
    const real = readFileSync(layout, "utf8");
    expect(isClientModule(readFileSync(join(SRC, "lib/skins/ThemeProvider.tsx"), "utf8"))).toBe(true);
    expect(isClientModule(real)).toBe(false);
    // 直接导入:名字出自客户端模块 ⇒ 违规
    expect(comesFromClientModule(join(SRC, "lib/skins/ThemeProvider.tsx"), "earlySkinScript")).toBe(true);
    // 现状:名字出自普通模块 ⇒ 不违规
    expect(comesFromClientModule(join(SRC, "lib/skins/early-skin-script.ts"), "earlySkinScript")).toBe(false);
    // 根布局里的客户端组件只当标签用 ⇒ 放行;同一个名字当值用(传给属性)⇒ 不放行
    expect(onlyUsedAsJsxTag(real, "RootLayoutClient")).toBe(true);
    expect(onlyUsedAsJsxTag(`${real}\nconst leaked = { __html: RootLayoutClient };`, "RootLayoutClient")).toBe(false);
    // 夹具(与真文件同形的一组小模块):直接取值 / 经具名与别名转手 / 经整体再导出转手 ⇒ 三处都抓到;组件当标签用、普通模块的值 ⇒ 不抓
    const fx = join(__dirname, "fixtures/server-client-values");
    expect(comesFromClientModule(join(fx, "barrel.ts"), "clientValue")).toBe(true);
    expect(comesFromClientModule(join(fx, "barrel.ts"), "renamedValue")).toBe(true);
    expect(comesFromClientModule(join(fx, "barrel.ts"), "plainValue")).toBe(false);
    expect(comesFromClientModule(join(fx, "star-barrel.ts"), "clientValue")).toBe(true);
    expect(violations([join(fx, "bad-layout.tsx")]).map((v) => v.replace(/^.*:: /, ""))).toEqual([
      "从客户端模块 ./client-module 导入了值「clientValue」",
      "从客户端模块 ./barrel 导入了值「renamedValue」",
      "从客户端模块 ./star-barrel 导入了值「viaStar」",
    ]);
    expect(violations([join(fx, "good-layout.tsx")])).toEqual([]);
    // 导入解析:默认 / 具名 / 别名都认,`import type` 与 `{ type X }` 不算
    expect(valueImports('import A, { b, c as d, type E } from "./x";\nimport type { F } from "./y";\nimport * as G from "./z";').map((i) => `${i.local}<-${i.imported}@${i.spec}`))
      .toEqual(["A<-default@./x", "b<-b@./x", "d<-c@./x", "G<-*@./z"]);
  });
});
