// 越权面**守卫覆盖**门禁(52 SPEC §2 缺口B 的 13 面 + 缺口A 的 monitor/runs)。
//
// 【为什么是文本级】route 是 Next.js 薄层,仓内没有单测 Next route 的先例(要造 NextRequest /
// app-router 上下文);真实 403 行为归无头页面级验收。但"**某个越权面的守卫被删了/忘了**"
// 这一类可以在文本层机械钉住 —— 而这恰恰是最容易在后续重构里静默丢掉的东西。
//
// 🔴 **本门禁第一步就剥注释**。理由不是洁癖:本批给每个路由都写了长注释,里面**逐字出现**
//    `requireProject(editor)`、`guardResourceAccess` 这些字样。不剥注释的话,一个**只有注释、
//    没有真守卫**的路由会照样通过 —— 那就成了一个"看起来在守、其实什么都没守"的假门禁。
//    仓内已经栽过 5 次同型(见 50 DESIGN §20.16「第三次栽在门禁没先剥注释」)。
//
// 🔴 **门禁自检**:每条判据都配正/负样本,证明它真的会咬(死门禁恒绿是本仓反复出现的问题)。
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = resolve(HERE, "../../../app/api");

/** 🔴 剥掉行注释与块注释 —— 见文件头。只保留可执行文本。 */
function stripComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "") // 块注释
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l)) // 整行 // 注释
    .map((l) => l.replace(/\s\/\/.*$/, "")) // 行尾 // 注释
    .join("\n");
}

/**
 * 期望的守卫种类:
 * · `requireProject`      —— 按**调用方 active project** 判(无 by-id 资源时用)
 * · `guardResourceAccess` —— 按**资源自己的归属项目**判(by-id 路由必须用这个,否则是混淆代理)
 * · `isPlatformAdmin`     —— 平台级资源(无 projectId),项目成员校验≈放行 ⇒ 只能收 admin
 * · `requireQueryHandle`  —— S0 的 queryHandle 归属校验
 */
type Guard = "requireProject" | "guardResourceAccess" | "isPlatformAdmin" | "requireQueryHandle";

interface Face {
  /** 相对 `src/app/api` 的路径 */
  route: string;
  /** 至少要出现的守卫(任一命中即算守住;多数路由是两道) */
  guards: Guard[];
  /** 备注:为什么是这个守卫 */
  why: string;
}

/**
 * 🔴 **13 面 + 1**(SPEC §2 缺口B 13 面;`monitor/runs` 属缺口A,**刻意**,见 §11.3)。
 * 这张表就是"哪些面必须有守卫"的机器可读版本。删一行 = 放弃一个面,必须在这里显式发生。
 */
const FACES: Face[] = [
  // ── 本批补上的 10 面 ──────────────────────────────────────────
  {
    route: "workflow/airflow/route.ts",
    guards: ["isPlatformAdmin"],
    why: "铸造 MWAA Web 登录凭证;单 MWAA 无 dagId 级授权 ⇒ 任何项目级角色都不足以授权它",
  },
  { route: "redshift/history/route.ts", guards: ["requireProject"], why: "SQL 历史含表名/字段名/业务逻辑,读写两侧都要项目维" },
  { route: "schedule/enable/route.ts", guards: ["guardResourceAccess"], why: "按 workflow / sync task 各自归属项目判;并修盲 Update" },
  { route: "datasources/test/route.ts", guards: ["requireProject", "guardResourceAccess"], why: "表单路径顶层 editor;带 id 路径按数据源归属项目" },
  { route: "datasources/[id]/heartbeat/route.ts", guards: ["guardResourceAccess"], why: "会回写数据源 status ⇒ 跨项目写" },
  { route: "datasources/[id]/schemas/route.ts", guards: ["guardResourceAccess"], why: "库名本身是业务情报" },
  { route: "datasources/[id]/tables/route.ts", guards: ["guardResourceAccess"], why: "表清单/列结构" },
  { route: "monitor/tasks/[id]/logs/route.ts", guards: ["requireProject", "guardResourceAccess"], why: "日志含 SQL/行数/报错栈" },
  { route: "sync/generate-ddl/route.ts", guards: ["requireProject"], why: "information_schema 盲布尔注入 + 生成的 DDL 会被真执行" },
  {
    route: "modeling/model-metrics/[id]/compute/route.ts",
    guards: ["isPlatformAdmin"],
    why: "资源无 projectId ⇒ 成员校验恒真≈放行;同族 metrics/[id]/compute 与 compute-all 早已是 admin",
  },
  // ── 本批之前已关闭的 5 面(🔴 本批只做回归钉,防被误伤或被后续重构删掉)──────
  { route: "redshift/schemas/route.ts", guards: ["requireProject"], why: "已关闭:枚举全库 schema" },
  { route: "redshift/execute/route.ts", guards: ["requireProject"], why: "已关闭:任意 SQL" },
  { route: "sync/execute-ddl/route.ts", guards: ["requireProject"], why: "已关闭:任意 DDL" },
  { route: "redshift/cancel/route.ts", guards: ["requireQueryHandle"], why: "已关闭(S0):handle 无条件必需,legacy 兜底已删" },
  { route: "redshift/result/[id]/route.ts", guards: ["requireQueryHandle"], why: "已关闭(S0):queryHandle 归属校验" },
];

/** 缺口A:刻意**不在本批**的面。这里显式登记,免得被当成"漏了"。 */
const DEFERRED = [
  {
    route: "monitor/runs/route.ts",
    to: "runs-carry-project-id",
    why: "bgp-task-runs 现无 projectId 字段;现在加项目过滤会让非默认项目的存量 run 全部消失(监控页空白)",
  },
];

function guardPresent(src: string, g: Guard): boolean {
  switch (g) {
    case "isPlatformAdmin":
      // 必须是**取反判定后返回**,不是仅仅读了这个字段
      return /!\s*\w+\.isPlatformAdmin/.test(src);
    default:
      return new RegExp(`\\b${g}\\s*\\(`).test(src);
  }
}

describe("🔴 门禁自检(证明判据真会咬,不是死门禁)", () => {
  it("剥注释:注释里写了守卫、代码里没有 ⇒ 判为未守住", () => {
    const commentOnly = `
// 本路由已按 SPEC 补 requireProject(editor) —— 注释这么写而已
/* guardResourceAccess(req, item, "editor") */
export async function POST(req: NextRequest) { return apiOk({}); }
`;
    const stripped = stripComments(commentOnly);
    expect(guardPresent(stripped, "requireProject"), "注释里的守卫被当成真守卫了").toBe(false);
    expect(guardPresent(stripped, "guardResourceAccess")).toBe(false);
  });

  it("真守卫能被识别", () => {
    const real = `const ctx = await requireProject(req, "editor");\nif (ctx instanceof NextResponse) return ctx;`;
    expect(guardPresent(stripComments(real), "requireProject")).toBe(true);
  });

  it("isPlatformAdmin:只读字段不算,必须取反判定", () => {
    expect(guardPresent("const a = identity.isPlatformAdmin;", "isPlatformAdmin")).toBe(false);
    expect(guardPresent("if (!identity.isPlatformAdmin) return apiError(x, 403);", "isPlatformAdmin")).toBe(true);
  });
});

describe("🔴 越权面守卫覆盖", () => {
  it("面数与台账一致(改动这个数字必须同步改 52 DESIGN §11)", () => {
    // 13 面(SPEC §2 缺口B)= 本批 10 + 此前已关闭 5 ⇒ 15?不:已关闭的 5 面里
    // `redshift/schemas` 是 SPEC v1.2 补的第 13 面,`result/[id]` 归 S0 ⇒ 表里共 15 行,
    // 其中 10 行是本批新补。这里钉总行数,防"悄悄删掉一行 = 放弃一个面"。
    expect(FACES.length).toBe(15);
    expect(DEFERRED.length).toBe(1);
  });

  for (const f of FACES) {
    it(`${f.route}:有守卫(${f.guards.join(" 或 ")})—— ${f.why}`, () => {
      const p = resolve(API, f.route);
      expect(existsSync(p), `路由文件不存在(路径变了就要同步改本门禁):${f.route}`).toBe(true);
      const src = stripComments(readFileSync(p, "utf8"));
      const hit = f.guards.filter((g) => guardPresent(src, g));
      expect(hit.length, `${f.route} 剥注释后找不到任何期望守卫(期望 ${f.guards.join("/")})`).toBeGreaterThan(0);
      // 守卫必须把拒绝**返回出去**(拿到 ctx 却不 return = 守了个空气)
      if (f.guards.some((g) => g === "requireProject" || g === "guardResourceAccess" || g === "requireQueryHandle")) {
        expect(src, `${f.route} 没有把守卫的拒绝返回(缺 instanceof NextResponse 早返回)`).toContain("instanceof NextResponse");
      }
    });
  }

  it("🔴 负向:这些面不许**只有** resolveIdentity(那是认证,不是授权)", () => {
    const offenders: string[] = [];
    for (const f of FACES) {
      const src = stripComments(readFileSync(resolve(API, f.route), "utf8"));
      const hasAuthn = /resolveIdentity\s*\(/.test(src);
      const hasAuthz = f.guards.some((g) => guardPresent(src, g));
      if (hasAuthn && !hasAuthz) offenders.push(f.route);
    }
    expect(offenders, "只验了身份没做授权 —— 这正是 model-metrics/compute 原来的形态").toEqual([]);
  });

  it("🔴 by-id 路由必须用 guardResourceAccess(按资源归属项目),不能只用 requireProject", () => {
    // 【为什么】只用 requireProject = 按**调用方 active project** 判 ⇒ A 项目 editor 换个
    // `x-bgp-project` header 就能操作 B 项目的资源:典型**混淆代理**。
    const byId = FACES.filter((f) => f.route.includes("[id]") && !f.guards.includes("isPlatformAdmin") && !f.guards.includes("requireQueryHandle"));
    expect(byId.length, "by-id 面一个都没识别到 ⇒ 本条判据形同不存在").toBeGreaterThanOrEqual(4);
    for (const f of byId) {
      expect(f.guards, `${f.route} 是 by-id 路由,必须登记 guardResourceAccess`).toContain("guardResourceAccess");
      const src = stripComments(readFileSync(resolve(API, f.route), "utf8"));
      expect(guardPresent(src, "guardResourceAccess"), `${f.route} 代码里没有 guardResourceAccess`).toBe(true);
    }
  });

  it("🔴 schedule/enable 的 sync 分支不许再有盲 Update(不存在的 taskId 会被 upsert 成幽灵任务)", () => {
    const src = stripComments(readFileSync(resolve(API, "schedule/enable/route.ts"), "utf8"));
    expect(src, "缺 attribute_exists 条件写 ⇒ 盲 Update 又回来了").toContain("attribute_exists(taskId)");
  });

  it("🔴 sync/generate-ddl 的标识符必须过 safeIdent(注入面;且 DDL 标识符无法参数化)", () => {
    const src = stripComments(readFileSync(resolve(API, "sync/generate-ddl/route.ts"), "utf8"));
    expect(src, "缺 safeIdent ⇒ schema/tableName 又能拼进 SQL 与生成的 DDL").toContain("safeIdent(");
    // 负向:不许再出现"直接把请求体里的 tableName 拼进 SQL"
    expect(src).not.toMatch(/table_name='\$\{tableName\}'/);
  });

  it("刻意推迟的面显式登记(不许静默消失)", () => {
    for (const d of DEFERRED) {
      expect(existsSync(resolve(API, d.route)), `${d.route} 不存在`).toBe(true);
      expect(d.to).toBe("runs-carry-project-id");
      expect(d.why.length).toBeGreaterThan(10);
    }
  });
});
