// @kf-batch 50-W5-seg2-WP1
// 🔴 「数据服务」下线门禁(50 SPEC §3.9c 已下线能力登记 / WORK-PACKAGES WP-1 v1.6 / ACCEPTANCE §8tervicies 单测门 (a)–(e))。
//
// 为什么必须是门禁而不是一次性删除:模块 30 的 lib / 管理 API / 页面 / TABLES 常量 2026-09-05 已删,但
//   · 一次 `git revert` / 一次「顺手恢复」就能把 `@/lib/data-service` 的 import 带回来;
//   · 有人会想「表都没人用了,顺手删掉」—— 三张表按 RETAIN 纪律必须留在 infra(删表另过破坏性变更门);
//   · BI 的 dataapi 分支若有人改回「去取数」,410 同一句就没了。
// ⇒ 用可执行断言钉住「下线后的形状」。判据全部对着真值源:源码(剥注释)/ 模块导出 / 真调 410 handler / infra 源 / naming.json。
// 写法与 lib/exec-env/__tests__/residency-negative-guard.test.ts 同风格(walk + strip 注释)。
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TABLES } from "@/lib/aws/dynamodb";
import { PROJECT_RESOURCE_KINDS } from "@/lib/projects/project-resources";
import * as paramRender from "@/lib/sql/param-render";
import namingConfig from "../../../naming.json";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../.."); // platform/src
const REPO = resolve(SRC, "../.."); // 仓根
const ROUTE_410 = "app/api/public/data/[...slug]/route.ts";
const GONE_MESSAGE = "数据服务能力已于 2026-09 下线";
const GONE_SINCE = "2026-09-05";
const RETAINED_TABLES = ["bgp-data-apis", "bgp-data-api-keys", "bgp-data-api-usage"];

const walk = (dir: string, acc: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "__tests__" || e === ".next") continue;
    const fp = resolve(dir, e);
    if (statSync(fp).isDirectory()) walk(fp, acc);
    else if (/\.(ts|tsx)$/.test(e)) acc.push(fp);
  }
  return acc;
};
// 剥注释:整行注释(// / * / /*)不算活代码。判据按剥完的文本,注释里写「已下线」不算命中。
const strip = (raw: string) => raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const rel = (fp: string) => fp.slice(SRC.length + 1);
const src = (relPath: string) => readFileSync(resolve(SRC, relPath), "utf8");

// (a) 禁用 token —— 🔴 全部带边界:`RedshiftDataApi` 这类 IAM 动作名、`dataapi` 这个仍保留的类型字面都**不**是命中。
const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/@\/lib\/data-service/, "import 已删除的 lib/data-service"],
  [/\bdata-service\b/, "页面 / 目录 / 路径名"],
  [/\bdata-apis\b/, "管理 API 路径 / 表名 bgp-data-apis"],
  [/\bdata-api-keys\b/, "管理 API 路径 / 表名 bgp-data-api-keys"],
  [/\bdata-api-usage\b/, "表名 bgp-data-api-usage"],
  [/\b(DATA_APIS|DATA_API_KEYS|DATA_API_USAGE)\b/, "TABLES 三常量"],
  [/\bexecuteDataApi\b/, "数据服务执行器(executeBiDataApi 不算:它是 BI 的 410 出口)"],
  [/"data-api"/, "删项目盘点 / 审计的资源类 data-api"],
];
// 白名单(合同 ACCEPTANCE §8tervicies 单测门 (a)):410 路由本身 + i18n 词典(英文词条允许残留)。
// lib/bi/types.ts / reports.ts 保留的是 `dataapi` 类型字面 —— 它本就不在禁用 token 里,不必豁免整文件(豁免整文件会让那里的回流漏网)。
const WHITELIST_PREFIX = [ROUTE_410, "lib/i18n/messages/"];

describe("🔴 WP-1 (a) platform/src 活代码里数据服务零引用(剥注释;pattern 带边界)", () => {
  const files = walk(SRC);
  it("扫描面合理(扫空 = 假绿)", () => {
    expect(files.length).toBeGreaterThan(200);
  });
  it.each(FORBIDDEN.map(([re, why]) => [re.source, why, re] as const))("`%s` 零命中(%s)", (_s, _why, re) => {
    const hits = files
      .filter((fp) => !WHITELIST_PREFIX.some((w) => rel(fp).startsWith(w)))
      .filter((fp) => re.test(strip(readFileSync(fp, "utf8"))))
      .map(rel);
    expect(hits, "仍有活代码引用已下线的数据服务").toEqual([]);
  });
  it("可执行版:TABLES 不再有三常量;删项目盘点不再有 data-api 类;四个目录已不存在", () => {
    for (const k of ["DATA_APIS", "DATA_API_KEYS", "DATA_API_USAGE"]) expect(k in TABLES, `TABLES.${k} 仍在`).toBe(false);
    for (const v of RETAINED_TABLES) expect(Object.values(TABLES) as string[], `TABLES 里仍有 ${v}`).not.toContain(v);
    expect(PROJECT_RESOURCE_KINDS).not.toContain("data-api");
    for (const d of ["app/data-service", "app/api/data-apis", "app/api/data-api-keys", "lib/data-service"]) {
      expect(existsSync(resolve(SRC, d)), `${d} 仍存在`).toBe(false);
    }
  });
});

describe("🔴 WP-1 (b) 对外端点 /api/public/data/[...slug]:五个方法都在、都 410 + 三字段、不 import 任何 @/lib", () => {
  const text = src(ROUTE_410);
  const code = strip(text);
  it("源码:GET / POST / PUT / DELETE / PATCH 五个 handler 都导出", () => {
    for (const m of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
      expect(code, `缺 ${m}`).toMatch(new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\s*\\(`));
    }
  });
  it("源码:唯一 import 是 next/server —— 不 import @/lib、不读表、不鉴权(没有数据面就没有泄露面)", () => {
    const specs = Array.from(code.matchAll(/from\s+"([^"]+)"/g)).map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.filter((s) => s !== "next/server"), "410 路由只许 import next/server").toEqual([]);
    expect(code).not.toContain('from "@/lib');
    expect(code).not.toMatch(/docClient|TableName|x-api-key|requireProject|recordAudit/);
  });
  it("真调:五个 handler 各返回 410 + { code:GONE, message, since } 恰好三字段(ACCEPTANCE E-134)", async () => {
    const mod = (await import(resolve(SRC, ROUTE_410))) as Record<string, () => Promise<Response>>;
    for (const m of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
      const res = await mod[m]();
      expect(res.status, `${m} 状态码`).toBe(410);
      expect(await res.json(), `${m} 响应体`).toEqual({ code: "GONE", message: GONE_MESSAGE, since: GONE_SINCE });
    }
  });
});

describe("🔴 WP-1 (c) 三张表 infra 仍在(RETAIN 纪律;防有人顺手删表)且在 naming.json 登记为已下线 RETAIN", () => {
  const infra = strip(readFileSync(resolve(REPO, "infra/lib/database-stack.ts"), "utf8"));
  it.each(RETAINED_TABLES)("infra/lib/database-stack.ts 仍定义 tableName %s", (name) => {
    const hits = infra.match(new RegExp(`tableName:\\s*"${name}"`, "g")) || [];
    expect(hits.length, `${name} 的表定义应恰好一处`).toBe(1);
  });
  it("naming.json notCovered.retired 登记的正是这三张(反向覆盖门禁据此放行 infra 字面量)", () => {
    const retired = (namingConfig as unknown as { notCovered: { retired: { names: string[]; retiredOn: string } } }).notCovered.retired;
    expect([...retired.names].sort()).toEqual([...RETAINED_TABLES].sort());
    expect(retired.retiredOn).toBe(GONE_SINCE);
  });
});

describe("🔴 WP-1 (d) 菜单 routes.tsx 无「数据服务」leaf,「数据开发」组其余项原样(ACCEPTANCE E-132)", () => {
  const routes = strip(src("components/layout/routes.tsx"));
  it("无 /data-service 与「数据服务」", () => {
    expect(routes).not.toContain("/data-service");
    expect(routes).not.toContain("数据服务");
  });
  it("数据开发组其余 5 项原样(防止顺手删错)", () => {
    for (const label of ["离线计算", "ETL 编排", "Redshift 查询", "Athena 查询", "实时计算"]) {
      expect(routes, `菜单缺「${label}」`).toContain(`label: "${label}"`);
    }
  });
});

describe("🔴 WP-1 (e) 共享件搬家:lib/sql/param-render 存在,BI 只从它 import renderSql / coerceParams", () => {
  it("lib/sql/param-render.ts 导出 renderSql / coerceParams(可执行)", () => {
    expect(existsSync(resolve(SRC, "lib/sql/param-render.ts"))).toBe(true);
    expect(typeof paramRender.renderSql).toBe("function");
    expect(typeof paramRender.coerceParams).toBe("function");
    // 搬家零行为变化的最小回归:值位置转义 + 白名单代入
    expect(paramRender.renderSql("SELECT * FROM t WHERE name = {{kw}}", [{ name: "kw", type: "string" }], { kw: "O'Brien" })).toBe(
      "SELECT * FROM t WHERE name = 'O''Brien'"
    );
  });
  it("lib/bi/query.ts 从 @/lib/sql/param-render import renderSql 与 coerceParams,且不再含 @/lib/data-service", () => {
    const q = strip(src("lib/bi/query.ts"));
    const imp = q.match(/import\s*\{([^}]*)\}\s*from\s*"@\/lib\/sql\/param-render"/);
    expect(imp, "缺 param-render import").not.toBeNull();
    expect(imp![1]).toMatch(/\brenderSql\b/);
    expect(imp![1]).toMatch(/\bcoerceParams\b/);
    expect(q).not.toContain("@/lib/data-service");
  });
  it("BI dataapi 出口:DATA_SERVICE_GONE 单一真值源(410 + GONE + 同一句),三条路由透传 e.code / e.status", () => {
    const q = strip(src("lib/bi/query.ts"));
    expect(q).toMatch(/export const DATA_SERVICE_GONE: BiQueryError = \{\s*status: 410,\s*code: "GONE",\s*error: "数据服务能力已于 2026-09 下线,该视觉对象请改为 SQL 或 GenBI 来源",\s*\}/);
    // executeBiDataApi 不许再取数:函数体只剩 throw
    expect(q).toMatch(/export async function executeBiDataApi\([^)]*\): Promise<BiQueryResult> \{\s*throw DATA_SERVICE_GONE;\s*\}/);
    for (const r of ["app/api/bi/query/route.ts", "app/api/bi/analysis-query/route.ts", "app/api/bi/export/route.ts"]) {
      const s = strip(src(r));
      expect(s, `${r} 不再走 executeBiDataApi`).toContain("executeBiDataApi(");
      expect(s, `${r} 没把 BiQueryError.code 透传`).toContain("e.code ??");
      expect(s, `${r} 没把 status 透传`).toContain("apiError(e.error, e.status, { code, correlationId: cid })");
    }
    // 前端:按错误信封渲染「数据服务已下线」占位(不白屏、不当成取数失败)
    const wb = strip(src("components/bi/AnalysisWorkbench.tsx"));
    expect(wb).toContain('=== "GONE"');
    expect(wb).toContain('t("数据服务已下线")');
  });
});
