/**
 * 门禁 `page-read-coverage` —— **页内每一次取数**都要按执行范围过滤,漏一处就红。
 *
 * 🔴 它补的是页面级棘轮的洞:`scope-wired-guard` 的判据是「页面沿 import 图任一处读了 `useScope(`」,
 * 于是「只接主列表、面板 / 抽屉 / Tab 全不接」也能绿。2026-09-10 实测 20 个 `wired: true` 的页里
 * **18 页**有不带范围的取数 —— 用户当天的原话是「前面你处理的好几个页面都没做完」。
 *
 * 判据(刻意做成可复算的静态推导,而不是人工清单):
 *   ① 从 `MENU_ROUTE_SCOPE` / `EXTRA_ROUTE_SCOPE` 取出所有 `wired: true` 且非 `global-only` 的页;
 *   ② 沿 `@/` import 图有界 BFS(深度 3)收集页面 + 它用到的组件;
 *   ③ 找出每一处 `fetch/authedFetch/apiFetch` 的 **URL 实参**,只看读方法(GET);
 *   ④ URL 里没有 `scope=` / `targetId=`、也没有引用本文件里「携带范围的标识符」⇒ 记一处欠账;
 *   ⑤ 推导结果与 `UNSCOPED_READS` 台账**逐项相等**;`not-wired-yet` 条数 === `UNSCOPED_READ_LIMIT`。
 *
 * 🔴 为什么第 ④ 步只看 URL 实参、不看整个调用文本:本仓 `targetId` 被复用成**表单字段名**
 * (`SlaPanel` 里它指 SLA 绑的任务 id),按整段调用匹配会把那种页面判成「已带范围」——
 * 那正是「没有判别力的判据 = 空断言」这条教训的又一次现形。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { MENU_ROUTE_SCOPE } from "../route-scope";
import { EXTRA_ROUTE_SCOPE } from "../capability";
import { UNSCOPED_READS, UNSCOPED_READ_LIMIT, type UnscopedRead } from "../api-read-ledger";

const REPO = resolve(__dirname, "../../../../..");
const SRC = resolve(REPO, "platform/src");

/** 天然跨范围 / 与执行区无关的基础设施调用(这三条是**机制自身**要用的,不是业务取数)。 */
const INFRA_APIS = [
  "/api/public/config", // 平台引导配置(Cognito 池 id 等)
  "/api/public/version", // 平台版本(镜像构建信息,与执行区无关)
  "/api/exec-targets", // 范围切换器自己的数据源:它就是「有哪些区」的来源
  "/api/scope/counts", // 「其他范围里还有 N 条」提示器,按设计要跨范围数
  "/api/long-ops", // 长操作统一框架的轮询端点:全局 fetch 拦截器按 taskId 取一行(落点在提交时已落在任务行上),不属于任何一页的取数
];

const read = (f: string) => readFileSync(f, "utf8");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 只认**执行范围**的形态。🔴 裸 `scope` 不算:本仓 `scope` 是重载词(预算作用域 / SLA 目标 / 技能全局)。 */
const SCOPE_MARK = /scope=|scopeQs|scopeParam|toScopeParam|targetId=|execTarget|atRegion|\btq\b/;

/** 从 `(` 之后扫出第一个实参(模板串 / 单双引号串),正确处理 `${}` 里嵌套的反引号。 */
function firstArgLiteral(text: string, openParen: number): string | null {
  let i = openParen + 1;
  while (i < text.length && /\s/.test(text[i])) i++;
  const q = text[i];
  if (q === '"' || q === "'") {
    const end = text.indexOf(q, i + 1);
    return end < 0 ? null : text.slice(i, end + 1);
  }
  if (q !== "`") return null;
  let depth = 0;
  for (let k = i + 1; k < text.length; k++) {
    const c = text[k];
    if (c === "\\") { k++; continue; }
    if (c === "$" && text[k + 1] === "{") { depth++; k++; continue; }
    if (c === "}" && depth > 0) { depth--; continue; }
    if (c === "`" && depth === 0) return text.slice(i, k + 1);
  }
  return null;
}

/** 括号配平,取整段调用文本(用来判 method)。 */
function balancedCall(text: string, openParen: number): string {
  let depth = 0;
  for (let k = openParen; k < text.length && k < openParen + 4000; k++) {
    if (text[k] === "(") depth++;
    else if (text[k] === ")") {
      depth--;
      if (depth === 0) return text.slice(openParen, k + 1);
    }
  }
  return text.slice(openParen, openParen + 400);
}

/** 本文件里「携带执行范围」的标识符(赋值里出现范围记号,或被 `.set("scope"…)` 塞过)。 */
function scopeCarriers(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*(?:set|append)\(\s*["'](?:scope|targetId)["']/g)) {
    names.add(m[1]);
  }
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
    const start = m.index! + m[0].length;
    let depth = 0;
    let end = start;
    for (let k = start; k < Math.min(text.length, start + 1500); k++) {
      const c = text[k];
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") depth--;
      else if ((c === ";" || c === "\n") && depth <= 0) break;
      end = k;
    }
    if (SCOPE_MARK.test(text.slice(start, end + 1))) names.add(m[1]);
  }
  // 传播:`const qs = params.toString()` 这种要靠 `params` 已被标记
  for (let round = 0; round < 3; round++) {
    for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=([^\n;]*)/g)) {
      if (names.has(m[1])) continue;
      for (const n of names) {
        if (new RegExp(`\\b${n.replace(/\$/g, "\\$")}\\b`).test(m[2])) { names.add(m[1]); break; }
      }
    }
  }
  return names;
}

interface Site { file: string; api: string }

function collectUnscopedReads(files: Map<string, string>): Site[] {
  const out: Site[] = [];
  for (const [file, raw] of files) {
    const text = stripComments(raw);
    const carriers = scopeCarriers(text);
    for (const m of text.matchAll(/\b(?:authedFetch|fetch|apiFetch)\s*\(/g)) {
      const open = m.index! + m[0].length - 1;
      const url = firstArgLiteral(text, open);
      if (!url || !url.includes("/api/")) continue;
      if (INFRA_APIS.some((x) => url.includes(x))) continue;
      const call = balancedCall(text, open);
      const method = /method:\s*["'](\w+)["']/.exec(call)?.[1]?.toUpperCase()
        ?? (/method:\s*\w/.test(call) ? "VAR" : "GET");
      if (method !== "GET") continue; // 写与执行走 body.targetId,由 `scope-write-guard` 管
      const scoped = SCOPE_MARK.test(url)
        || Array.from(carriers).some((n) => new RegExp(`\\b${n.replace(/\$/g, "\\$")}\\b`).test(url));
      if (scoped) continue;
      const api = url.replace(/^[`"']|[`"']$/g, "").split("?")[0].split("${")[0].replace(/\/$/, "");
      out.push({ file, api });
    }
  }
  return out;
}

function importClosure(entry: string, depth = 3, seen = new Map<string, string>()): Map<string, string> {
  if (depth < 0 || seen.has(entry) || !existsSync(entry)) return seen;
  const raw = read(entry);
  seen.set(entry, raw);
  for (const m of stripComments(raw).matchAll(/from\s+["'](@\/[^"']+)["']/g)) {
    const rel = m[1].slice(2);
    for (const cand of [`${rel}.tsx`, `${rel}.ts`, `${rel}/index.tsx`, `${rel}/index.ts`]) {
      const f = resolve(SRC, cand);
      if (existsSync(f)) { importClosure(f, depth - 1, seen); break; }
    }
  }
  return seen;
}

/** `/api/a/b` → 路由文件路径(动态段用目录里的 `[x]` 兜);定位不到回 null(不假红)。 */
function routeFileOf(api: string): string | null {
  const segs = api.split("/").filter(Boolean);
  if (segs[0] !== "api") return null;
  let dir = resolve(SRC, "app", "api");
  for (const seg of segs.slice(1)) {
    const direct = resolve(dir, seg);
    if (existsSync(direct)) { dir = direct; continue; }
    const dyn = readdirSync(dir).find((n) => n.startsWith("[") && n.endsWith("]"));
    if (!dyn) return null;
    dir = resolve(dir, dyn);
  }
  const f = resolve(dir, "route.ts");
  return existsSync(f) ? f : null;
}

function pageFileOf(key: string): string {
  return resolve(SRC, "app", key === "/" ? "page.tsx" : `${key.replace(/^\//, "")}/page.tsx`);
}

/** 推导:每个 `wired: true` 的页 → 它的无范围读取(按 (页, 文件, 接口) 去重)。 */
function derive(): Array<{ page: string; file: string; api: string }> {
  const decls: Record<string, unknown> = { ...MENU_ROUTE_SCOPE, ...EXTRA_ROUTE_SCOPE };
  const rows: Array<{ page: string; file: string; api: string }> = [];
  for (const [page, d] of Object.entries(decls)) {
    const dd = d as { scope?: string; wired?: boolean };
    if (dd.scope === "global-only" || dd.wired !== true) continue;
    const pf = pageFileOf(page);
    if (!existsSync(pf)) continue;
    const files = importClosure(pf);
    const seen = new Set<string>();
    for (const s of collectUnscopedReads(files)) {
      const rel = s.file.startsWith(SRC) ? s.file.slice(SRC.length + 1) : s.file;
      const k = `${rel}|${s.api}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ page, file: rel, api: s.api });
    }
  }
  return rows;
}

const key = (r: { page: string; file: string; api: string }) => `${r.page} :: ${r.file} :: ${r.api}`;

describe("page-read-coverage", () => {
  const derived = derive();

  it("🔴🔴 推导出的「无执行范围读取」必须与台账逐项相等(新长出一处 = 红;修好一处必须删条目)", () => {
    const got = new Set(derived.map(key));
    const want = new Set(UNSCOPED_READS.map(key));
    const missing = [...got].filter((x) => !want.has(x)).sort(); // 代码里有、台账里没有
    const stale = [...want].filter((x) => !got.has(x)).sort(); // 台账里有、代码里已经没有
    expect(
      { 未登记的欠账: missing, 已修好却还留在台账里的: stale },
      "读取级台账与代码不一致 —— 详见 lib/scope/api-read-ledger.ts 顶部说明"
    ).toEqual({ 未登记的欠账: [], 已修好却还留在台账里的: [] });
  });

  it("🔴 `not-wired-yet` 的条数必须恰好等于棘轮 `UNSCOPED_READ_LIMIT`(只许改小)", () => {
    const owed = UNSCOPED_READS.filter((r) => r.reason === "not-wired-yet");
    expect(owed.length, `实数 ${owed.length} ≠ 棘轮 ${UNSCOPED_READ_LIMIT};接好一处就把棘轮减 1`).toBe(
      UNSCOPED_READ_LIMIT
    );
    expect(UNSCOPED_READ_LIMIT, "棘轮只许改小,开工基线是 31").toBeLessThanOrEqual(31);
  });

  it("🔴 理由不许同义反复:每条 note 至少 12 字,且不得只是把接口名重复一遍", () => {
    const bad: string[] = [];
    for (const r of UNSCOPED_READS) {
      if (r.note.replace(/\s/g, "").length < 12) bad.push(`${key(r)}: note 太短`);
      if (/^(待接入|暂未支持|后续处理|TODO)/.test(r.note.trim())) bad.push(`${key(r)}: note 是同义反复`);
    }
    expect(bad, bad.join(" / ")).toEqual([]);
  });


  it("🔴🔴 反刷分:前端传了范围,服务端必须真用它(否则棘轮可以被「传了参但服务端不理」骗过)", () => {
    // 这条判据的来由:2026-09-10 接治理侧时,我把 8 条前端请求都加上了 `&scope=`,
    // 推导器立刻认为「已修好」—— 但其中 5 条的**服务端根本没读那个参数**。
    // 读取级棘轮只看 URL,看不见服务端有没有理它 ⇒ 那就是一个可以刷分的洞。
    // ⇒ 凡是**不在台账里**(即被认定「已按范围过滤」)的 `/api/` 读取,其路由文件必须出现
    //   至少一处「真读范围」的调用。
    // 🔴 「真读范围」的形态在本仓有很多种写法(实测):`sp.get("targetId")` 这种把
    // `searchParams` 先存进局部变量的、`resolveAthenaPlace(...)` 这种把取参包进解析器的……
    // 判据要认全,否则会把已经做对的路由判成假红 —— 而假红会逼人放宽判据,最后连真红也不看了。
    const USE_SCOPE =
      /readScope\(|requireScope\(|governanceTargetFrom\(|scopedFqn\(|scopeFilter\(|filterRowsBy|listActiveTargetsForScope\(/.source +
      "|" +
      /\bget\("(?:targetId|scope)"\)/.source +
      "|" +
      /resolve(?:Athena|S3Tables|Flink|Ds|Glue|Emr|Redshift)(?:Place|Binding)\(|resolveFlinkPlace\(|schedulerEndpointFor\(|resolveDirectQueryPlace/.source;
    const usesScope = (src: string) => new RegExp(USE_SCOPE).test(src);
    const declared = new Set(UNSCOPED_READS.map((r) => `${r.page} :: ${r.file} :: ${r.api}`));
    const bad: string[] = [];
    for (const [page, d] of Object.entries({ ...MENU_ROUTE_SCOPE, ...EXTRA_ROUTE_SCOPE } as Record<string, { scope?: string; wired?: boolean }>)) {
      if (d.scope === "global-only" || d.wired !== true) continue;
      const pf = pageFileOf(page);
      if (!existsSync(pf)) continue;
      for (const [file, raw] of importClosure(pf)) {
        const rel = file.startsWith(SRC) ? file.slice(SRC.length + 1) : file;
        const text = stripComments(raw);
        for (const m of text.matchAll(/\b(?:authedFetch|fetch|apiFetch)\s*\(/g)) {
          const open = m.index! + m[0].length - 1;
          const url = firstArgLiteral(text, open);
          if (!url || !url.includes("/api/")) continue;
          if (INFRA_APIS.some((x) => url.includes(x))) continue;
          const call = balancedCall(text, open);
          const method = /method:\s*["'](\w+)["']/.exec(call)?.[1]?.toUpperCase() ?? (/method:\s*\w/.test(call) ? "VAR" : "GET");
          if (method !== "GET") continue;
          if (!SCOPE_MARK.test(url)) continue; // 没带范围的由上面那条「与台账相等」管
          const api = url.replace(/^[`"']|[`"']$/g, "").split("?")[0].split("${")[0].replace(/\/$/, "");
          if (declared.has(`${page} :: ${rel} :: ${api}`)) continue; // 台账里已登记(欠账/合法),不在此列
          const route = routeFileOf(api);
          if (!route) continue; // 定位不到路由文件(动态段太深)⇒ 交给人工,不在这里假红
          const src = stripComments(read(route));
          // 🔴 api 归一会把 `/api/athena/query/${id}` 折成 `/api/athena/query` ⇒ 定位到父路由。
          // 所以父路由不满足时,再看它下面的动态子路由(那才是真正处理这次 GET 的文件)。
          let ok = usesScope(src);
          if (!ok) {
            const dir = resolve(route, "..");
            for (const child of readdirSync(dir)) {
              if (!child.startsWith("[")) continue;
              const cf = resolve(dir, child, "route.ts");
              if (existsSync(cf) && usesScope(stripComments(read(cf)))) { ok = true; break; }
            }
          }
          if (!ok) bad.push(`${api}(${relative(REPO, route)})`);
        }
      }
    }
    expect(
      Array.from(new Set(bad)).sort(),
      "这些接口收到了范围参数,但路由里没有任何「真读范围」的调用 ⇒ 前端白传、数据仍是全部区域"
    ).toEqual([]);
  });

  it("门禁自检:推导器真能从一段样例代码里认出「带范围」与「不带范围」", () => {
    const sample = new Map<string, string>([
      [
        "sample.tsx",
        [
          'const scopeQs = scopeParam ? `?scope=${scopeParam}` : "";',
          "fetch(`/api/aaa${scopeQs}`);",
          'fetch("/api/bbb");',
          'fetch("/api/ccc", { method: "POST" });',
          'fetch(`/api/ddd?targetId=${x}`);',
          "const p = new URLSearchParams(); p.set(\"scope\", s); const qs = p.toString();",
          "fetch(`/api/eee?${qs}`);",
          'fetch("/api/public/config");',
        ].join("\n"),
      ],
    ]);
    // 只有 /api/bbb 该被抓出来:aaa 带 scopeQs、ccc 是写、ddd 带 targetId=、eee 靠 params.set 传播、config 是基础设施
    expect(collectUnscopedReads(sample).map((s) => s.api)).toEqual(["/api/bbb"]);
  });
});
