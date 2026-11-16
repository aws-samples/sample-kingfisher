// 换肤早期脚本(<head> 内联脚本)的判据。
//
// 钉四件事实:
//   ① 这段脚本真执行的结果:已存皮肤 ⇒ body 背景 / 背景尺寸 / 文字色与 data-skin 刷成该皮肤的值;没存 / 存了不认识的 id ⇒ 什么都不动;
//      读 localStorage 抛错(隐私模式)⇒ 不抛出页面。
//   ② 它定义在普通模块里:本模块与它依赖的本地模块都不带 "use client" —— 根布局是服务端组件,从客户端模块取值拿到的是
//      「客户端引用」,<head> 里的脚本在浏览器端会变成延迟解析的元素,首开页面间歇报水合不一致(2026-11-14 页面探针坐实)。
//   ③ 存储键只有一个定义处,换肤提供者读写用的就是它。
//   ④ 根布局确实把它写进 <head>(调用点,不是只有 import)。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import vm from "node:vm";
import { earlySkinScript, SKIN_STORAGE_KEY } from "../early-skin-script";
import { SKINS, skinBodyBackground, skinBodyBackgroundSize } from "../skins";

const SRC = join(__dirname, "../../..");

/** 在假的浏览器全局里真执行脚本,回 body / 根节点被写成了什么。 */
function run(saved: string | null | Error) {
  const bodyStyle: Record<string, string> = {};
  const rootAttrs: Record<string, string> = {};
  const sandbox = {
    localStorage: {
      getItem: (k: string) => {
        if (saved instanceof Error) throw saved;
        return k === SKIN_STORAGE_KEY ? saved : null;
      },
    },
    document: {
      body: { style: bodyStyle },
      documentElement: { setAttribute: (k: string, v: string) => { rootAttrs[k] = v; } },
    },
  };
  vm.runInNewContext(earlySkinScript, sandbox);
  return { bodyStyle, rootAttrs };
}

describe("换肤早期脚本:真执行", () => {
  it("每一款皮肤:已存它的 id ⇒ body 背景 / 尺寸 / 文字色刷成它的值,根节点标 data-skin", () => {
    expect(SKINS.length).toBeGreaterThan(1);
    for (const s of SKINS) {
      const { bodyStyle, rootAttrs } = run(s.id);
      expect(bodyStyle, s.id).toEqual({ background: skinBodyBackground(s), backgroundSize: skinBodyBackgroundSize(s), backgroundAttachment: "fixed", color: s.text });
      expect(rootAttrs, s.id).toEqual({ "data-skin": s.id });
    }
  });

  it("没存 / 存了不认识的 id ⇒ 什么都不动;读存储抛错 ⇒ 不抛出页面", () => {
    expect(run(null)).toEqual({ bodyStyle: {}, rootAttrs: {} });
    expect(run("no-such-skin")).toEqual({ bodyStyle: {}, rootAttrs: {} });
    expect(run(new Error("SecurityError"))).toEqual({ bodyStyle: {}, rootAttrs: {} });
  });
});

describe("换肤早期脚本:定义在普通模块,服务端组件能直接拿到文本", () => {
  const isClient = (src: string) => /^["']use client["']/.test(src.replace(/^(?:\s+|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, ""));

  it("本模块与它依赖的本地模块(逐层)都不带 \"use client\"", () => {
    const seen = new Set<string>();
    const queue = [join(SRC, "lib/skins/early-skin-script.ts")];
    while (queue.length) {
      const f = queue.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      const src = readFileSync(f, "utf8");
      expect(isClient(src), `${relative(SRC, f)} 带 "use client" ⇒ 服务端组件从这条链上拿到的是客户端引用`).toBe(false);
      for (const m of src.matchAll(/^import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm)) {
        const spec = m[1];
        const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? join(dirname(f), spec) : null;
        if (!base) continue;
        const hit = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find((c) => { try { return statSync(c).isFile(); } catch { return false; } });
        expect(hit, `${relative(SRC, f)} 的本地导入 ${spec} 解析不到文件`).toBeTruthy();
        queue.push(hit!);
      }
    }
    expect([...seen].map((f) => relative(SRC, f)).sort()).toEqual(["lib/skins/early-skin-script.ts", "lib/skins/skins.ts"]);
  });

  it("换肤提供者是客户端模块,且不再导出这段脚本(从它导入就是客户端引用)", () => {
    const provider = readFileSync(join(SRC, "lib/skins/ThemeProvider.tsx"), "utf8");
    expect(isClient(provider)).toBe(true);
    expect(provider).not.toMatch(/earlySkinScript/);
  });
});

describe("皮肤存储键:单一定义处", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const n of readdirSync(dir)) {
      if (n === "__tests__" || n === "node_modules") continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(p)) out.push(p);
    }
    return out;
  }

  it("键的字面量只出现在早期脚本模块;换肤提供者读写都用它", () => {
    const literal = JSON.stringify(SKIN_STORAGE_KEY);
    const holders = walk(SRC).filter((f) => readFileSync(f, "utf8").includes(literal)).map((f) => relative(SRC, f));
    expect(holders).toEqual(["lib/skins/early-skin-script.ts"]);
    const provider = readFileSync(join(SRC, "lib/skins/ThemeProvider.tsx"), "utf8");
    expect(provider).toContain('import { SKIN_STORAGE_KEY } from "./early-skin-script";');
    expect(provider).toContain("localStorage.getItem(SKIN_STORAGE_KEY)");
    expect(provider).toContain("localStorage.setItem(SKIN_STORAGE_KEY, id)");
    expect(earlySkinScript).toContain(`localStorage.getItem(${literal})`);
  });
});

describe("根布局调用点", () => {
  it("根布局从早期脚本模块导入,并把它写进 <head> 的内联脚本", () => {
    const layout = readFileSync(join(SRC, "app/layout.tsx"), "utf8");
    expect(layout).toContain('import { earlySkinScript } from "@/lib/skins/early-skin-script";');
    expect(layout).toMatch(/<head>[\s\S]*<script dangerouslySetInnerHTML=\{\{ __html: earlySkinScript \}\} \/>[\s\S]*<\/head>/);
  });
});
