// @kf-batch 42-ux-feedback —— Next.js 约定文件(page / layout / route …)只许**标准导出**。
//
// 🔴 为什么必须有这条:`next build` 对 app 目录的约定文件做导出面校验,多 `export const X` 一个常量就
//   「Type error: "X" is not a valid Page export field」整包构建失败 —— 而 tsc / vitest 全绿(它们不认识这条规则)。
//   2026-10-15 feat/42 把 `/sync` 的两个常量 export 在 page.tsx 里,本机门禁三绿、重部署 …7698 在 Docker 里 build 失败,白赔一次部署。
//   守卫写成**合法形态清单**(允许什么),不是枚举违规写法;类型导出(`export type / interface`)构建期会被抹掉,不在管辖内。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Next 14 App Router 对 page / layout 等 UI 约定文件允许的导出名(https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config)。 */
const PAGE_EXPORTS = new Set([
  "default", "metadata", "generateMetadata", "viewport", "generateViewport", "generateStaticParams",
  "dynamic", "dynamicParams", "revalidate", "fetchCache", "runtime", "preferredRegion", "maxDuration", "experimental_ppr",
]);
/** route.ts 另加 HTTP 方法。 */
const ROUTE_EXPORTS = new Set([...PAGE_EXPORTS, "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

const UI_FILES = ["page.tsx", "layout.tsx", "loading.tsx", "error.tsx", "not-found.tsx", "template.tsx", "default.tsx", "global-error.tsx"];

/** 取文件里全部**值**导出名(类型导出不算:`export type` / `export interface` 构建期被抹掉)。 */
export function valueExportsOf(src: string): string[] {
  const names: string[] = [];
  const decl = /^export\s+(?:async\s+)?(?:const|let|var|function\*?|class|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of src.matchAll(decl)) names.push(m[1]);
  if (/^export\s+default\b/m.test(src)) names.push("default");
  // `export { a, b as c, type T }` —— 逐项取对外名,带 type 前缀的跳过
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const p = part.trim();
      if (!p || /^type\s/.test(p)) continue;
      names.push(p.split(/\s+as\s+/).pop()!.trim());
    }
  }
  // `export * from` 会把别的模块的导出面整个暴露出来,对约定文件一律不合法
  if (/^export\s*\*\s*from/m.test(src)) names.push("*");
  return names;
}

/** 递归列 app/ 下全部 .ts / .tsx(Node 20 没有 fs.globSync;跳过 __tests__)。 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function listFiles(): Array<{ file: string; allowed: Set<string> }> {
  const out: Array<{ file: string; allowed: Set<string> }> = [];
  for (const abs of walk(APP)) {
    const f = relative(APP, abs);
    const base = f.split("/").pop()!;
    if (UI_FILES.includes(base)) out.push({ file: f, allowed: PAGE_EXPORTS });
    else if (base === "route.ts") out.push({ file: f, allowed: ROUTE_EXPORTS });
  }
  return out;
}

describe("Next.js 约定文件只许标准导出(否则 next build 失败而本机 tsc / vitest 看不见)", () => {
  const files = listFiles();
  it("扫到了全部页面与路由(页面 ≥ 40、路由 ≥ 299;少了说明 glob 坏了)", () => {
    expect(files.filter((x) => x.file.endsWith("page.tsx")).length).toBeGreaterThanOrEqual(40);
    expect(files.filter((x) => x.file.endsWith("route.ts")).length).toBeGreaterThanOrEqual(299);
  });
  it("没有任何 page / layout / route 文件带非标准的值导出", () => {
    const bad: string[] = [];
    for (const { file, allowed } of files) {
      const src = readFileSync(resolve(APP, file), "utf8");
      const extra = valueExportsOf(src).filter((n) => !allowed.has(n));
      if (extra.length) bad.push(`${relative(APP, resolve(APP, file))}: ${extra.join(", ")}`);
    }
    expect(bad, "把常量 / 工具函数搬到 lib/ 或同目录的非约定文件里,页面只 import").toEqual([]);
  });
  it("解析器自检:值导出 / default / 重导出列表都认得,类型导出不算", () => {
    const src = [
      'export const A = 1;', 'export async function GET() {}', 'export default function Page() {}',
      'export type T = string;', 'export interface I {}', 'export { x as Y, type Z, W };',
    ].join("\n");
    expect(valueExportsOf(src).sort()).toEqual(["A", "GET", "W", "Y", "default"]);
  });
});
