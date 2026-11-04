// @kf-batch 70-B138-hydration-safe-initial-state
// 🔴 B-138 棘轮:客户端组件不许在 **渲染期**(useState 初值函数 / 组件体顶层表达式)读 window / localStorage ——
//   服务端首帧与浏览器首帧会不一致,React 19 把水合不一致上报成 window error(页面驱动判据 pageerror 必红),用户看到首帧闪一下。
//   机械规则(宁可多抓,抓到的用 useBrowserInitialState 改写):
//   ① `useState(() => …)` 初值函数体内出现 `typeof window` / `window.` / `localStorage`;
//   ② 组件体顶层 `const x = typeof window !== "undefined" ? … : …`(三目直接读浏览器状态当渲染输入)。
//   useEffect / 事件回调里读是允许的(本测试按行粗判:只看 useState 初值函数与 `const … = typeof window` 三目两种形态)。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { useBrowserInitialState } from "../use-browser-initial-state";

const SRC = join(__dirname, "../../..");
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "__tests__" || n === "node_modules") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("B-138 渲染期不读浏览器状态(水合安全)", () => {
  it("① useState 初值函数里不许出现 typeof window / window. / localStorage", () => {
    const bad: string[] = [];
    for (const f of [...walk(join(SRC, "app")), ...walk(join(SRC, "components"))]) {
      const src = readFileSync(f, "utf8");
      const re = /useState(?:<[^>]*>)?\(\s*\(\)\s*=>\s*\{?([\s\S]{0,400}?)\)\s*;/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        if (/typeof window|window\.|localStorage/.test(m[1])) bad.push(relative(SRC, f));
      }
    }
    expect(bad, "这些组件在 useState 初值函数里读浏览器状态 ⇒ 改用 lib/hydration/useBrowserInitialState(首帧缺省、挂载后读)").toEqual([]);
  });

  it("② 组件体顶层不许 `const x = typeof window !== \"undefined\" ? 读浏览器 : 缺省`", () => {
    const bad: string[] = [];
    for (const f of [...walk(join(SRC, "app")), ...walk(join(SRC, "components"))]) {
      const src = readFileSync(f, "utf8");
      for (const line of src.split("\n")) {
        if (/^\s{2}const [A-Za-z_]\w* = typeof window !== "undefined" \?/.test(line)) bad.push(`${relative(SRC, f)} :: ${line.trim().slice(0, 90)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("③ useBrowserInitialState 的服务端首帧 == serverDefault(与 readOnClient 无关)", () => {
    function Probe() {
      const [v] = useBrowserInitialState("server", () => "client");
      return createElement("span", null, v);
    }
    expect(renderToString(createElement(Probe))).toContain(">server<");
  });
});
