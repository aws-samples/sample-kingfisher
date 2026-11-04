// 三道门禁(合同 SPEC v3.34 §2.6.8):
//   · `scope-header-guard`  —— 全仓不得出现 `x-bgp-target-id`;拦截器不许长出第三个注入
//   · `scope-write-guard`   —— 写方法的 handler 不得读 scope
//   · `scope-filter-guard`  —— 全仓不得出现 `contains(targets`;资源登记表与镜像来源不许漂
//
// 文法门 `scope-grammar-guard` 在同目录 `scope-grammar-guard.test.ts`。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { KIND_INDEX, COUNTABLE_KINDS, LEGACY_PARTITION_USER_ID } from "../resource-index";
import { MENU_ROUTE_SCOPE } from "../route-scope";
// 非菜单页那张表也要进「wired 必须真读 scope」的循环
import { EXTRA_ROUTE_SCOPE } from "../capability";
import { BACKFILL_PLAN_BINDING_ATTR } from "@/lib/backfill/types";

const REPO = resolve(__dirname, "../../../../..");
const SRC = resolve(REPO, "platform/src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "core-dist" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}
const FILES = walk(SRC);
const read = (f: string) => readFileSync(f, "utf8");

/**
 * 🔴 负向文本断言前**必须先剥注释**:本仓的合同注释里到处写着「不许出现 X」,
 * 不剥注释就会把「文档写了这条纪律」误判成「违反了这条纪律」(本仓累计踩过多次)。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * 产品代码 = 排除 `__tests__`。测试**可以**合法出现被禁的字面量 ——
 * 负向判据本身就要构造一个带 `x-bgp-target-id` 的请求来证明它被忽略。
 */
const PROD_FILES = FILES.filter((f) => !f.includes("__tests__"));
const codeOf = (f: string) => stripComments(read(f));

describe("scope-header-guard", () => {
  it("🔴 产品代码不得出现 `x-bgp-target-id`(定案:永不引入这个头)", () => {
    const hits = PROD_FILES.filter((f) => codeOf(f).includes("x-bgp-target-id")).map((f) => relative(REPO, f));
    expect(
      hits,
      `出现了 x-bgp-target-id:${hits.join(" / ")}。` +
        `它一旦存在,「浏览器上次选的区」就迟早会变成服务端依据(50 SPEC §2.6.2)`
    ).toEqual([]);
  });

  it("门禁自检:探测器**真能**抓到违规(否则上一条是空断言)", () => {
    // 正向:构造一份「产品代码里读了这个头」的源码,必须命中
    const bad = 'const t = req.headers.get("x-bgp-target-id");';
    expect(stripComments(bad).includes("x-bgp-target-id")).toBe(true);
    // 反向:只在注释里提到它,不算违规(合同注释本来就要写「不许出现它」)
    const doc = '// 🔴 永不引入 x-bgp-target-id\nconst a = 1;';
    expect(stripComments(doc).includes("x-bgp-target-id")).toBe(false);
    // 剥注释不许把真代码剥掉
    expect(stripComments('const u = "https://x/y"; // 注释').trim()).toBe('const u = "https://x/y";');
  });

  it("🔴 全局 fetch 拦截器只许注入 project 与 env 两个头(第三个就是那一步)", () => {
    const src = read(resolve(SRC, "lib/auth/AuthProvider.tsx"));
    const injected = [...src.matchAll(/headers\.set\(\s*"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(injected).toEqual(["Authorization", "x-bgp-env", "x-bgp-project"]);
  });

  it("服务端读取器不得出现任何 `req.headers.get` / `headers.get`(来源只有 URL)", () => {
    const src = read(resolve(SRC, "lib/exec-env/scope.ts"));
    expect(src).not.toMatch(/headers\s*\.\s*get\(/);
  });
});

describe("scope-write-guard", () => {
  /** 从 `export async function NAME(` 起按大括号配平截出函数体。 */
  function bodyOf(src: string, name: string): string | null {
    const at = src.search(new RegExp(`export\\s+async\\s+function\\s+${name}\\s*\\(`));
    if (at < 0) return null;
    const open = src.indexOf("{", at);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) return src.slice(open, i + 1);
      }
    }
    return null;
  }

  it("🔴 POST/PUT/PATCH/DELETE 的 handler 里不得出现 readScope / requireScope", () => {
    const offenders: string[] = [];
    for (const f of FILES.filter((f) => f.endsWith("route.ts") && f.includes("/api/"))) {
      const src = read(f);
      if (!src.includes("readScope") && !src.includes("requireScope")) continue;
      for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
        const body = bodyOf(src, m);
        if (body && /\b(readScope|requireScope)\s*\(/.test(body)) offenders.push(`${relative(REPO, f)}#${m}`);
      }
    }
    expect(
      offenders,
      `写路由在读执行范围:${offenders.join(" / ")}。` +
        `执行目标只能来自 body 显式字段 / 资源自己的绑定 / URL 路径资源身份(50 SPEC §2.6.3)`
    ).toEqual([]);
  });

  it("门禁自检:截函数体的实现真能截出东西(否则上一条是空断言)", () => {
    const src = read(resolve(SRC, "app/api/admin/model-config/route.ts"));
    const put = bodyOf(src, "PUT");
    expect(put).not.toBeNull();
    expect(put!.length).toBeGreaterThan(200);
    expect(bodyOf(src, "GET")).not.toBeNull();
    // 反向:构造一个「写 handler 里调了 readScope」的字符串,截出来必须命中
    const fake = 'export async function POST(req) {\n  const s = readScope(req);\n  return s;\n}\n';
    expect(/\b(readScope|requireScope)\s*\(/.test(bodyOf(fake, "POST")!)).toBe(true);
  });
});

describe("scope-filter-guard", () => {
  it("🔴 产品代码不得出现 `contains(targets` —— 绑定列表类只许经 bindingTargets 内存过滤", () => {
    const hits = PROD_FILES.filter((f) => /contains\(\s*#?targets/.test(codeOf(f))).map((f) => relative(REPO, f));
    expect(
      hits,
      `把 bindingTargets 的三级回落抄成了 DDB 表达式:${hits.join(" / ")}(50 SPEC §2.6.4)`
    ).toEqual([]);
  });

  it("门禁自检:`contains(targets` 探测器真能抓到(含带 # 的写法)", () => {
    expect(/contains\(\s*#?targets/.test("FilterExpression: contains(targets, :t)")).toBe(true);
    expect(/contains\(\s*#?targets/.test("contains(#targets, :t)")).toBe(true);
    expect(/contains\(\s*#?targets/.test("contains(#nm, :nm)")).toBe(false);
  });

  it("B 类过滤只经 bindingTargets(实现里必须引它,且代码区无任何 contains()", () => {
    const code = codeOf(resolve(SRC, "lib/exec-env/scope.ts"));
    expect(code).toContain("bindingTargets");
    expect(code).not.toMatch(/contains\(/);
  });

  it("🔴 资源登记表 ↔ 镜像来源不许漂(项目维 / 环境维 / 表名 / userId 逐条核对)", () => {
    const problems: string[] = [];
    for (const kind of COUNTABLE_KINDS) {
      const spec = KIND_INDEX[kind];
      if (spec.read !== "scan-user") continue;
      const p = resolve(SRC, spec.mirrorOf);
      const src = read(p);
      if (!src.includes(`const USER_ID = "${LEGACY_PARTITION_USER_ID}"`)) {
        problems.push(`${kind}: ${spec.mirrorOf} 的 USER_ID 不再是 ${LEGACY_PARTITION_USER_ID}`);
      }
      if (spec.hasProject !== src.includes("projectFilter(")) {
        problems.push(`${kind}: 项目维登记为 ${spec.hasProject},但 ${spec.mirrorOf} 里相反`);
      }
      if (spec.hasEnv !== src.includes("envFilter(")) {
        problems.push(`${kind}: 环境维登记为 ${spec.hasEnv},但 ${spec.mirrorOf} 里相反`);
      }
    }
    expect(problems, problems.join(" | ")).toEqual([]);
  });

  it("🔴 `bindingAttr` 只许引各模块自己导出的常量,登记表里不许写字面量", () => {
    expect(KIND_INDEX["backfill-plan"].bindingAttr).toBe(BACKFILL_PLAN_BINDING_ATTR);
    const src = codeOf(resolve(SRC, "lib/scope/resource-index.ts"));
    // 写成字面量的后患:那个模块哪天改了字段名,这里悄悄不动 ⇒ 计数全部堆到 home,而界面看着像在工作。
    expect(src).not.toMatch(/["']execTargets["']/);
  });

  it("门禁自检:字面量探测器真能抓到", () => {
    expect(/["']execTargets["']/.test('bindingAttr: "execTargets",')).toBe(true);
    expect(/["']execTargets["']/.test("bindingAttr: BACKFILL_PLAN_BINDING_ATTR,")).toBe(false);
  });

  it("登记表覆盖全部可计数种类,且 scalar 类必须给出属性名", () => {
    expect(Object.keys(KIND_INDEX).sort()).toEqual([...COUNTABLE_KINDS].sort());
    for (const kind of COUNTABLE_KINDS) {
      const spec = KIND_INDEX[kind];
      if (spec.attribution === "scalar") expect(spec.scalarKind, kind).toBeTruthy();
    }
  });
});

describe("scope-wired-guard", () => {
  /** 菜单 key → 页面文件(`/` = `app/page.tsx`;`/admin/users` = `app/admin/users/page.tsx`)。 */
  function pageFileOf(key: string): string {
    return resolve(SRC, "app", key === "/" ? "page.tsx" : `${key.replace(/^\//, "")}/page.tsx`);
  }

  /**
   * 页面读没读 scope,**不能只看 page.tsx** —— 好几页(`/finops` 四个 Tab、`/bi` 工作台)
   * 只是个壳,真读数据的是它 import 的组件。只看壳会得出「没接入」的**假红**,
   * 而假红逼人放宽判据,最后连真红也不看了(台账 V-13 的同一课)。
   * ⇒ 沿 `@/` import 图做**有界 BFS**(深度 3、只走 src 内、只认 .ts/.tsx),任一处读了就算接入。
   */
  function readsScopeDeep(entry: string, depth = 3, seen = new Set<string>()): boolean {
    if (depth < 0 || seen.has(entry)) return false;
    seen.add(entry);
    let src = "";
    try {
      src = read(entry);
    } catch {
      return false;
    }
    const clean = stripComments(src);
    if (clean.includes("useScope(")) return true;
    for (const m of Array.from(clean.matchAll(/from\s+["'](@\/[^"']+)["']/g))) {
      const rel = m[1].replace(/^@\//, "");
      for (const cand of [`${rel}.tsx`, `${rel}.ts`, `${rel}/index.tsx`, `${rel}/index.ts`]) {
        const f = resolve(SRC, cand);
        if (readsScopeDeep(f, depth - 1, seen)) return true;
      }
    }
    return false;
  }

  /**
   * 🔴 `wired: true` 是**对用户的一句承诺**:「这一页的数据已经按你选的执行范围过滤了」。
   * 翻了这个开关却没在页面上真读 scope,后果不是少个功能,而是**界面在撒谎** ——
   * 「未按执行范围过滤」的提示条被撤掉了(ScopeGate 按这个开关决定要不要挂),
   * 而列表仍然是全部区域的数据。这种谎话没有任何报错、单测也照绿。
   */
  it("🔴 声明 `wired: true` 的非全局页,页面文件必须真的读了 `useScope(`", () => {
    const bad: string[] = [];
    // 🔴 原来这里**只遍历 MENU_ROUTE_SCOPE**:
    //   `EXTRA_ROUTE_SCOPE` 里的非菜单页(`/metrics` `/sla` …)声明 `wired: true` 却从没被查过。
    //   实测后果:`/sla` 是个 19 行跳转页、压根不读 scope,照样"已接入"了好几刀
    //   ⇒ 棘轮可以被一个什么都没做的页面满足。两张表**必须一起遍历**。
    const ALL: Record<string, unknown> = { ...MENU_ROUTE_SCOPE, ...EXTRA_ROUTE_SCOPE };
    for (const [key, dRaw] of Object.entries(ALL)) {
      const d = dRaw as { scope?: string; wired?: boolean; follows?: unknown; noGate?: unknown };
      if (d.follows || d.noGate) continue;
      if (d.scope === "global-only" || (d as { wired?: boolean }).wired !== true) continue;
      const f = pageFileOf(key);
      let src = "";
      try {
        src = read(f);
      } catch {
        bad.push(`${key}: 找不到页面文件 ${relative(REPO, f)}`);
        continue;
      }
      if (!readsScopeDeep(f)) bad.push(`${key}: ${relative(REPO, f)}(含它 import 的组件)没有读 useScope(`);
    }
    expect(
      bad,
      `这些页声明了「已按执行范围过滤」但没真读 scope ⇒ 提示条被撤掉、数据却是全部区域的:${bad.join(" / ")}`
    ).toEqual([]);
  });

  it("门禁自检:路径推导与探测器都真能工作", () => {
    // 路径推导:两种形态都要指到真实存在的文件
    expect(readFileSync(pageFileOf("/etl-jobs"), "utf8").length).toBeGreaterThan(100);
    expect(readFileSync(pageFileOf("/admin/users"), "utf8").length).toBeGreaterThan(100);
    // 反向:只在注释里写 useScope( 不算接入
    expect(stripComments("// 这里应该 useScope(\nconst a = 1;").includes("useScope(")).toBe(false);
    // BFS 探测器自检:壳页要能靠子组件算接入,不认识的文件必须回 false
    expect(readsScopeDeep(pageFileOf("/finops"))).toBe(true);
    expect(readsScopeDeep(resolve(SRC, "app/not-a-real-page/page.tsx"))).toBe(false);
    // 至少要有一页真被检查到(否则上一条是空断言)
    const checked = Object.entries(MENU_ROUTE_SCOPE).filter(
      ([, d]) => d.scope !== "global-only" && (d as { wired?: boolean }).wired === true
    );
    expect(checked.length).toBeGreaterThanOrEqual(5);
  });
});
