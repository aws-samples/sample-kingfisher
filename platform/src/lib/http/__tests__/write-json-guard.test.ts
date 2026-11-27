// 页面 / 组件里「发了写请求却把应答丢掉」的调用点 —— **棘轮**(只减不增)+ 已修的三个文件必须经 `writeJson`。
//
// 认法:一条语句以 `await fetch(` / `await authedFetch(` 开头 = 应答没有被接住(没有赋值、没有 `.then`)。
//   读请求没有人这样写(丢掉应答的读没有意义),所以命中的都是写。
// 为什么是棘轮:剩下的两处是「停止查询 / 取消查询」—— 它们不向用户宣称结果(界面状态由随后的轮询决定),本批不动;
//   新页面再写一处「发完不看」⇒ 这里红。迁一处就从名单删一行。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "node_modules" || name === "api") continue;
      walk(p, out);
    } else if (/\.(tsx?|jsx?)$/.test(name)) out.push(p);
  }
  return out;
}

/** 这份文件里「应答被丢掉」的请求语句数。 */
function discardedResponses(file: string): number {
  const src = readFileSync(file, "utf8");
  return (src.match(/^[ \t]*await[ \t]+(?:authedFetch|fetch)\(/gm) ?? []).length;
}

/** 2026-11-26 基线(路径 ⇒ 处数)。只许减少。 */
const BASELINE: Record<string, number> = {
  "app/athena/page.tsx": 1, // 「停止」正在跑的查询
  "app/redshift/page.tsx": 1, // 「取消」正在跑的查询
};

/** 本批已修:保存类动作必须经 writeJson,失败分支把服务端原话呈现出来。 */
const FIXED = ["app/workflow/[id]/page.tsx", "app/redshift/page.tsx", "components/monitor/SchedulePanel.tsx"];

describe("🔴 页面发了写请求不许不看应答", () => {
  const files = [...walk(resolve(SRC, "app")), ...walk(resolve(SRC, "components"))];
  const found: Record<string, number> = {};
  for (const f of files) {
    const n = discardedResponses(f);
    if (n > 0) found[relative(SRC, f)] = n;
  }

  it("扫得到东西(判别力):基线里的两处都在被扫的文件里命中", () => {
    expect(files.length).toBeGreaterThan(50);
    for (const p of Object.keys(BASELINE)) expect(found[p], p).toBeGreaterThan(0);
  });

  it("丢掉应答的调用点只减不增(逐文件不超过基线,基线外的文件为 0)", () => {
    const over = Object.entries(found).filter(([p, n]) => n > (BASELINE[p] ?? 0));
    expect(over, `新增了「发完不看应答」的写请求:${JSON.stringify(over)} —— 用 lib/http/write-json.ts 的 writeJson`).toEqual([]);
  });

  it("基线不留虚数:名单里的处数与实际相同(迁走一处就把名单同步减掉)", () => {
    for (const [p, n] of Object.entries(BASELINE)) expect(found[p] ?? 0, p).toBe(n);
  });

  it("已修的三个文件:经 writeJson 保存,并且有把服务端原话呈现出来的失败分支", () => {
    for (const p of FIXED) {
      const src = readFileSync(resolve(SRC, p), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      const calls = src.match(/\bawait writeJson\(/g) ?? [];
      expect(calls.length, `${p} 没有 writeJson 调用点`).toBeGreaterThan(0);
      expect(src, `${p} 没有把拒因呈现给用户的分支`).toMatch(/message\.error\(\(e as Error\)\.message/);
    }
  });

  it("编排画布:「保存」与「发布」前的静默保存走同一个写法,存上了才清掉未保存标记", () => {
    const src = readFileSync(resolve(SRC, "app/workflow/[id]/page.tsx"), "utf8");
    const body = src.slice(src.indexOf("const saveCanvas"), src.indexOf("const handleSave"));
    expect(body, "找不到 saveCanvas").toContain("writeJson(");
    // 失败分支在清标记之前返回
    expect(body.indexOf("return false")).toBeGreaterThan(-1);
    expect(body.indexOf("return false")).toBeLessThan(body.indexOf("setDirty(false)"));
    // 两个调用点
    expect((src.match(/await saveCanvas\(\)/g) ?? []).length).toBe(2);
    expect(src).toMatch(/if \(dirty && !\(await saveCanvas\(\)\)\) return;/);
  });
});
