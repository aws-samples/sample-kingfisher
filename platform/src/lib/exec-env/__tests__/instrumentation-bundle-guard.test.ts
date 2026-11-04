// 🔴🔴 **instrumentation 可达面门禁** —— 这条是被一次真部署失败咬出来的,不是预防性洁癖。
//
// ── 事故经过 ────────────────────────────────────────────────────────────────
// W3-e 把元数据镜像挂到周期 reconciler 上(`reconciler-loop` 里 `await import("metadata-mirror")`),
// 本地 `tsc` 全绿、`vitest` 2054 全绿、synth-gate 全绿 —— 然后 `npm run build` 在 docker 里**直接失败**:
//     Module not found: Can't resolve 'crypto'
//     import trace: instrumentation → reconciler-loop → metadata-mirror → data-plane-target
//                   → privileged-cred → project-schema
// 根因:`instrumentation.ts` 会被 Next **同时**编进 nodejs 与 **edge** 两个 bundle,
// 而 edge 那个编译**没有 node 内置模块**。
//
// 🔴 三个反直觉的点(每一个我都实测撞过):
//   ① **`await import()` 不构成边界** —— 动态 import 只是拆 chunk,webpack 照样要 build 那个模块。
//      `instrumentation.ts` 里那句"动态 import 避免拉进 edge bundle"的注释是**运行期**成立、编译期不成立。
//   ② **`NEXT_RUNTIME !== "nodejs"` 的 early return 也不构成边界** —— 那是运行期判断,编译期照样编。
//   ③ **把 `node:crypto` 改成 `crypto` 没用** —— 两种写法在 edge 编译里都解析不了
//      (错误只是从 `UnhandledSchemeError` 变成 `Module not found`)。
//
// ⇒ 唯一稳的办法是**切断可达性**,并把它做成机械断言:本文件从 `instrumentation.ts` 出发
//   走一遍 import 图(静态 + 动态都算),命中 node 内置就红。**红在 3 秒内,而不是 5 分钟的 docker build 之后。**
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");
const REPO = resolve(SRC, "../..");

/** node 内置模块(带不带 `node:` 前缀都算)。edge 编译解析不了它们。 */
const NODE_BUILTINS = new Set([
  "crypto", "fs", "path", "os", "child_process", "http", "https", "net", "tls", "dns",
  "zlib", "stream", "buffer", "util", "url", "worker_threads", "perf_hooks", "readline",
  "cluster", "dgram", "v8", "vm", "module", "process", "timers", "assert", "querystring",
]);

/** 把 import 说明符解析成 `src/` 下的真实文件;不是本仓文件就回 null。 */
function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = resolve(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(c) && !c.endsWith("/")) {
      try {
        if (readFileSync(c, "utf8") !== undefined) return c;
      } catch {
        /* 目录:继续试下一个候选 */
      }
    }
  }
  return null;
}

/** 抽出一个文件里的全部 import 说明符:`import … from "x"` / `import("x")` / `export … from "x"`。 */
function importsOf(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) out.push(m[1]);
  return out;
}

/** 从入口走 import 图,返回 {可达文件, 命中的 node 内置(带引用链)}。 */
function walkGraph(entry: string): { files: Set<string>; hits: string[] } {
  const files = new Set<string>();
  const hits: string[] = [];
  const parent = new Map<string, string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    const src = readFileSync(f, "utf8");
    for (const spec of importsOf(src)) {
      const bare = spec.replace(/^node:/, "");
      if (NODE_BUILTINS.has(bare)) {
        // 把引用链拼出来 —— 光说"有个文件用了 crypto"没法定位,链条才是可操作的信息
        const chain: string[] = [relative(SRC, f)];
        let cur = f;
        while (parent.has(cur)) {
          cur = parent.get(cur)!;
          chain.push(relative(SRC, cur));
        }
        hits.push(`${chain.reverse().join(" → ")} 用了 ${spec}`);
        continue;
      }
      const next = resolveLocal(spec, f);
      if (next && !files.has(next)) {
        parent.set(next, f);
        stack.push(next);
      }
    }
  }
  return { files, hits };
}

describe("🔴🔴 instrumentation(周期 reconciler)的 import 图不许碰 node 内置", () => {
  const entry = resolve(SRC, "instrumentation.ts");

  it("入口存在、且图能走到 reconciler(锚点失效就该红,不许静默扫 0 个文件)", () => {
    expect(existsSync(entry), "找不到 src/instrumentation.ts —— 挂载点被改名了?请同步本门禁").toBe(true);
    const { files } = walkGraph(entry);
    const rels = Array.from(files).map((f) => relative(SRC, f));
    expect(rels, "图里没有 reconciler-loop ⇒ 本门禁形同不存在").toContain("lib/exec-env/reconciler-loop.ts");
    expect(rels.length, "只走到一两个文件 = 说明符解析写错了").toBeGreaterThan(5);
  });

  it("🔴 图里没有任何文件 import node 内置(edge 编译解析不了 ⇒ `next build` 直接失败)", () => {
    const { hits } = walkGraph(entry);
    expect(
      hits,
      "🔴 instrumentation 可达面碰到了 node 内置模块 —— `npm run build` 会在 edge 那个编译上失败" +
        "(动态 import / NEXT_RUNTIME early-return **都不构成边界**)。" +
        "处置:把周期任务需要的那一小块**搬到轻量层**(见 `target-region.ts` 文件头)," +
        "或把需要请求上下文的采集器改成由路由**注入**(见 `metadata-mirror-warehouse.ts`)"
    ).toEqual([]);
  });

  it("🔴 具体钉住这次的两条边:镜像层不许再 import 数据面绑定层 / 数仓采集层", () => {
    // 🔴 **先剥注释**(同一教训第 9 次):镜像层的注释里就写着这两个被禁的模块名
    //    (「实现在 metadata-mirror-warehouse.ts」「data-plane-target 会经 privileged-cred…」),
    //    不剥的话负向断言会咬自己的解释文字 —— 本条第一版就是这么当场红的。
    const strip = (raw: string) =>
      raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const mirror = strip(readFileSync(resolve(SRC, "lib/exec-env/metadata-mirror.ts"), "utf8"));
    // 允许 import 轻量层;禁止 import 那两个会把 privileged-cred/project-schema 拖进来的模块
    expect(mirror, "镜像层又 import 了 data-plane-target ⇒ edge 编译会再炸一次").not.toMatch(
      /from\s+"@\/lib\/exec-env\/data-plane-target"|import\(\s*"@\/lib\/exec-env\/data-plane-target"/
    );
    expect(mirror, "镜像层 import 了数仓采集层 ⇒ 同上;它必须由路由注入").not.toMatch(
      /metadata-mirror-warehouse/
    );
    expect(mirror, "region 解析没走轻量层").toContain('from "@/lib/exec-env/target-region"');
    // 🔴 注入口必须还在(没有它,数仓采集就只能被搬回来)
    expect(mirror, "注入式采集器的类型出口没了 ⇒ 数仓采集会被搬回镜像层").toContain(
      "export type MirrorSourcePuller"
    );
    const route = readFileSync(resolve(SRC, "app/api/admin/metadata-mirror/route.ts"), "utf8");
    expect(route, "路由没注入数仓采集器 ⇒ 手动采集数仓这条路会 500").toContain("warehousePuller(");
  });

  it("门禁会咬:对已知坏样本(直接 import crypto 的模块)必命中", () => {
    // 用**真文件**做正样本:`project-schema.ts` 就是这次那条链的末端
    const bad = resolve(SRC, "lib/exec-env/project-schema.ts");
    const { hits } = walkGraph(bad);
    expect(hits.length, "拿一个真的用 crypto 的文件当入口都咬不到 ⇒ 本门禁的检测逻辑坏了").toBeGreaterThan(0);
    expect(hits.join(" ")).toMatch(/crypto/);
    expect(REPO.length).toBeGreaterThan(0);
  });

  // 🔴 数据面长作业的推进泵挂在 reconciler 旁:钉住「泵在图里、执行侧不在图里」
  it("🔴 推进泵在可达面里,而作业模型 / store / runner / 执行器**不在**(泵侧零执行器 import)", () => {
    const { files } = walkGraph(resolve(SRC, "instrumentation.ts"));
    const rels = new Set(Array.from(files).map((f) => relative(SRC, f)));
    expect(rels.has("lib/dataplane-jobs/pump.ts"), "泵没接上 reconciler ⇒ 作业永远没人推").toBe(true);
    for (const banned of [
      "lib/dataplane-jobs/model.ts",
      "lib/dataplane-jobs/store.ts",
      "lib/dataplane-jobs/runner.ts",
      "lib/exec-env/admin-ddl-executor.ts",
      "lib/exec-env/project-cred-supply.ts",
      "lib/exec-env/permission-canary.ts",
      "lib/scheduler/internal-guard.ts",
    ]) {
      expect(rels.has(banned), `${banned} 进了 instrumentation 可达面 ⇒ edge 编译迟早炸(泵只许回环调内部端点)`).toBe(false);
    }
  });
});
