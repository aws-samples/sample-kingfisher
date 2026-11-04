// @kf-batch 50-G2R
// G2R —— admin-DDL **结构化请求 + 私有模板**单测(50 SPEC §3.9a v3.3,用户拍板 B)。
//
// 【这是新的真边界,所以测试要盯两件事】
// ① **类型层没有自由 SQL 的口子**:请求里出现 sql/statements/ddl 一律当场拒(不是忽略);
// ② **7 个 operation 一个都不许少、也不许 no-op** —— 建议书 §5 拒绝清单第 5、6 条明确禁止
//    "删入口"与"改成永久 throw / 501 / no-op 冒充 fail-closed"。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  parseAdminDdlRequest,
  AdminDdlRequestInvalid,
  ADMIN_DDL_OPERATIONS,
  type AdminDdlRequest,
  type VerifiedAdminDdlContext,
} from "@/lib/exec-env/admin-ddl-request";
import { buildAdminDdlStatements, registeredOperations } from "@/lib/exec-env/admin-ddl-templates";
import { projectSchema, projectRoleName, projectDbUserName, SHARED_SCHEMA } from "@/lib/exec-env/project-schema";
import { lintGeneratedStatement } from "@/lib/exec-env/admin-ddl-guards";

const PID = "proj-01M1KP594D2E6DJQC8EZ8CRAES"; // 真环境形态(大写 ULID),见 project-schema.ts 的订正说明
const TID = "tgt_home";

// @kf-batch 50-WP11b-shared-writer —— 建模类 operation 的台账对象(真执行器在第 2 步服务端读台账得到;这里给夹具)
const CODE_ROW = { kind: "code-table" as const, codeTableId: "country", code: "country" };
const MODEL_ROW = {
  kind: "model-table" as const,
  modelTableId: "01MODELTABLE",
  schema: "dw",
  physicalTable: "dim_user",
  columns: [
    { name: "id", dataType: "BIGINT", isPrimaryKey: true },
    { name: "name", dataType: "VARCHAR", length: 64, comment: "姓名 'x' -- select" },
  ],
};
function modelingFor(s?: AdminDdlRequest): VerifiedAdminDdlContext["modelingObject"] {
  if (!s) return undefined;
  if (s.operation === "land-code-table" || s.operation === "grant-shared-writer") return { ...CODE_ROW, codeTableId: s.codeTableId };
  if (s.operation === "land-model-table") return { ...MODEL_ROW, modelTableId: s.modelTableId };
  if (s.operation === "drop-landed-table") {
    return s.kind === "code-table" ? { ...CODE_ROW, codeTableId: s.objectId } : { ...MODEL_ROW, modelTableId: s.objectId };
  }
  return undefined;
}

function ctx(projectId?: string, s?: AdminDdlRequest): VerifiedAdminDdlContext {
  const modelingObject = modelingFor(s);
  return {
    targetId: TID,
    projectId,
    projectSchemaName: projectId ? projectSchema(projectId) : undefined,
    credentialEpoch: 0,
    ...(modelingObject ? { modelingObject } : {}),
  };
}

/** 7 个 operation 的最小合法请求(测试与合同同源:少一个这里就编译/断言不过)。 */
const SAMPLES: AdminDdlRequest[] = [
  { operation: "create-project-schema", targetId: TID, projectId: PID },
  { operation: "create-shared-schema", targetId: TID },
  { operation: "create-role", targetId: TID, projectId: PID },
  { operation: "grant", targetId: TID, projectId: PID },
  { operation: "drop-project-schema", targetId: TID, projectId: PID, approvalId: "apr-1" },
  { operation: "dms-ingest-bootstrap", targetId: TID },
  // @kf-batch 50-WP11b-shared-writer —— land-code-table 改成 target 级(码表没有项目维)
  { operation: "land-code-table", targetId: TID, codeTableId: "country" },
  // @kf-batch 52-P52.5a-supply — 🔴 **追加在末尾**:上面用了 `SAMPLES[0]` / `SAMPLES[6]` 这种下标,
  // 插在中间会把别的断言悄悄换成另一个 operation(下标索引的样本表最容易这样出事)。
  { operation: "grant-role-to-login", targetId: TID, projectId: PID },
  // @kf-batch 50-WP11b-shared-writer —— 同样追加在末尾(理由同上)
  { operation: "grant-shared-writer", targetId: TID, codeTableId: "country" },
  { operation: "land-model-table", targetId: TID, modelTableId: "01MODELTABLE" },
  { operation: "drop-landed-table", targetId: TID, kind: "code-table", objectId: "country" },
  { operation: "drop-landed-table", targetId: TID, kind: "model-table", objectId: "01MODELTABLE" },
  // @kf-batch 50-WP9a-durable-jobs —— permission canary 的两条(追加在末尾,理由同上)
  { operation: "create-canary-probes", targetId: TID, projectId: PID },
  { operation: "revoke-public-create", targetId: TID },
];

describe("🔴 结构化请求:类型层不给自由 SQL 的口子", () => {
  it("出现 sql / statements / statement / ddl 一律当场拒(不是忽略多余字段)", () => {
    for (const f of ["sql", "statements", "statement", "ddl"]) {
      expect(
        () => parseAdminDdlRequest({ operation: "create-shared-schema", targetId: TID, [f]: "DROP DATABASE x" }),
        `字段 ${f} 应被拒`
      ).toThrow(AdminDdlRequestInvalid);
    }
  });

  it("未登记 operation 拒,且报错列出允许集", () => {
    expect(() => parseAdminDdlRequest({ operation: "drop-database", targetId: TID })).toThrow(/create-project-schema/);
  });

  it("非对象 / 缺 targetId / 非法 targetId 拒", () => {
    for (const bad of [null, "x", 1, {}, { operation: "create-shared-schema" }, { operation: "create-shared-schema", targetId: "nope" }]) {
      expect(() => parseAdminDdlRequest(bad as never)).toThrow(AdminDdlRequestInvalid);
    }
  });

  it("有项目维的 operation 缺 projectId 即拒;target 级 operation 带 projectId 也拒", () => {
    expect(() => parseAdminDdlRequest({ operation: "grant", targetId: TID })).toThrow(/projectId/);
    // 不是"忽略多余字段":带上它说明调用方对语义有误解,放过去会让审计出现不参与判定的 projectId。
    expect(() => parseAdminDdlRequest({ operation: "create-shared-schema", targetId: TID, projectId: PID })).toThrow(
      /target 级/
    );
  });

  it("drop-project-schema 必须带合法 approvalId(破坏性操作)", () => {
    expect(() => parseAdminDdlRequest({ operation: "drop-project-schema", targetId: TID, projectId: PID })).toThrow(
      /approvalId/
    );
    expect(() =>
      parseAdminDdlRequest({ operation: "drop-project-schema", targetId: TID, projectId: PID, approvalId: "a b" })
    ).toThrow(/approvalId/);
  });

  it("land-code-table 必须带合法 codeTableId", () => {
    expect(() => parseAdminDdlRequest({ operation: "land-code-table", targetId: TID })).toThrow(/codeTableId/);
    expect(() => parseAdminDdlRequest({ operation: "land-code-table", targetId: TID, codeTableId: "a;b" })).toThrow(
      /codeTableId/
    );
    // @kf-batch 50-WP11b-shared-writer —— 码表是 target 级:带 projectId 说明调用方对语义有误解
    expect(() =>
      parseAdminDdlRequest({ operation: "land-code-table", targetId: TID, projectId: PID, codeTableId: "country" })
    ).toThrow(/target 级/);
  });

  it("7 个最小合法请求全部解析通过", () => {
    for (const s of SAMPLES) {
      expect(parseAdminDdlRequest(s as unknown), `${s.operation} 应通过`).toMatchObject({ operation: s.operation });
    }
  });
});

describe("🔴 模板注册表:7 个 operation 一个都不许少、也不许 no-op", () => {
  it("registeredOperations 与合同枚举完全一致", () => {
    expect(registeredOperations()).toEqual([...ADMIN_DDL_OPERATIONS].sort());
  });

  it("每个 operation 都产出至少一条语句(no-op 不允许冒充 fail-closed)", () => {
    for (const s of SAMPLES) {
      const out = buildAdminDdlStatements(s, ctx("projectId" in s ? (s as { projectId: string }).projectId : undefined, s));
      expect(out.length, `${s.operation} 的模板产出为空`).toBeGreaterThan(0);
      for (const stmt of out) expect(typeof stmt).toBe("string");
    }
  });

  it("🔴 每条模板产物都能过 lint(含归属校验)—— 生成器自检", () => {
    for (const s of SAMPLES) {
      const projectId = "projectId" in s ? (s as { projectId: string }).projectId : undefined;
      for (const stmt of buildAdminDdlStatements(s, ctx(projectId, s))) {
        expect(() => lintGeneratedStatement(stmt, { projectId }), `${s.operation}: ${stmt}`).not.toThrow();
      }
    }
  });
});

describe("🔴 模板内容的关键不变量", () => {
  // 🔴 标题刻意不写成"那条禁令的形状":L1 扫描门禁(l1-no-grant-to-public.test.ts)禁止全仓出现,
  //    而豁免名单只留给"禁令自身的定义与它的 payload 测试"。本处改口径即可,不必加豁免。
  //    另订正一处旧数:实测是 **8 处**(6 处源码 + 2 处被 git 跟踪的 core-dist 编译副本),原写 6 处。
  it("模板产物绝不把对象授权给 PUBLIC(52 P52.1 L1 已撤的那 8 处存量授权的形状)", () => {
    for (const s of SAMPLES) {
      const projectId = "projectId" in s ? (s as { projectId: string }).projectId : undefined;
      for (const stmt of buildAdminDdlStatements(s, ctx(projectId, s))) {
        expect(stmt.toLowerCase(), `${s.operation} 出现 TO PUBLIC`).not.toMatch(/to\s+public/);
      }
    }
  });

  it("schema / role / 登录用户名一律来自 SSOT,不是调用方给的", () => {
    // @kf-batch 52-P52.5a-supply
    // 🔴🔴 **本条原来在钉一个真 bug**:它断 `create-project-schema` 的产物里必须出现 **role 名**,
    // 而那个 role 名来自 `ALTER SCHEMA … OWNER TO "role_proj_…"` —— 真环境第一次执行就报
    // `ERROR: user "role_proj_proj_01m1…" does not exist`:**Redshift 的 schema 属主必须是 user,
    // role 不能当属主**。本条当时是"绿的",因为它只检查字符串里有没有那个名字,而 mock 不跑 Redshift。
    // ⇒ 改成分 operation 断:schema 类的属主必须是**登录用户**;role 名只该出现在 role/grant 类里。
    const schemaOut = buildAdminDdlStatements(SAMPLES[0], ctx(PID)).join(" "); // create-project-schema
    expect(schemaOut).toContain(projectSchema(PID));
    expect(schemaOut, "属主必须是登录用户(user_proj_*)").toContain(projectDbUserName(PID));
    expect(schemaOut, "属主写成 role ⇒ Redshift 报 user does not exist").not.toContain(projectRoleName(PID));
    // role 名的正当出处:create-role / grant / grant-role-to-login
    const roleOps = SAMPLES.filter((x) => ["create-role", "grant", "grant-role-to-login"].includes(x.operation));
    expect(roleOps.length, "样本里少了 role 类 operation ⇒ 下面这条会变成空断言").toBeGreaterThanOrEqual(2);
    for (const s2 of roleOps) {
      const pid2 = "projectId" in s2 ? (s2 as { projectId: string }).projectId : undefined;
      expect(buildAdminDdlStatements(s2, ctx(pid2)).join(" ")).toContain(projectRoleName(PID));
    }
  });

  it("🔴 land-code-table 的 admin 模板里**没有 INSERT/DELETE** —— 数据写入已移出 admin 通道(§4.6)", () => {
    // 这一条直接对应"接线即废功能"那个坑:真实的码表落地含受控 DML,
    // 但那部分走窄权 shared-writer,不该出现在 admin 模板里。
    const out = buildAdminDdlStatements(SAMPLES[6], ctx(undefined, SAMPLES[6])).join(" ").toLowerCase();
    expect(out).not.toMatch(/\binsert\b/);
    expect(out).not.toMatch(/\bdelete\b/);
    expect(out, "但结构必须建出来,否则就是 no-op").toMatch(/create table/);
    // @kf-batch 50-WP11b-shared-writer —— 落点改经 SSOT(过渡期 = 现网 public.dim_code_<code>,不再是 shared.code_<id>)
    expect(out).toContain(`"public"."dim_code_country"`);
    expect(out, "旧模板自己拼的第二个落点名不许回来").not.toContain(SHARED_SCHEMA);
  });

  it("🔴 跨项目污染反测:模板产物只引用本项目 schema", () => {
    const other = "proj-" + "1".repeat(26);
    for (const s of SAMPLES) {
      if (!("projectId" in s)) continue;
      for (const stmt of buildAdminDdlStatements(s, ctx(PID, s))) {
        // 用**另一个** projectId 去做归属校验:若模板真的只引用本项目对象,这里必然被拒
        // (证明归属校验不是恒真)。
        if (/\bproj_/i.test(stmt)) {
          // 注:toThrow(regex) 匹配的是 **message**,不是 rule 字段 —— 第一版我写错了 rule。
          let rule = "";
          try { lintGeneratedStatement(stmt, { projectId: other }); } catch (e) { rule = (e as { rule?: string }).rule ?? ""; }
          expect(rule, `${stmt} 应被判跨项目`).toBe("cross-project-object");
        }
      }
    }
  });

  it("非法标识符进不了模板(SSOT 被绕过时宁可炸)", () => {
    // 直接喂一个不合法 projectId 给模板路径 → 应在 assertProjectId / ident 处炸,而不是拼出奇怪 SQL。
    expect(() =>
      buildAdminDdlStatements(
        { operation: "create-role", targetId: TID, projectId: "bad id" } as unknown as AdminDdlRequest,
        ctx("bad id")
      )
    ).toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 G8(外部审核 v3 P0-B 整改):mint 函数私有化的**机械门禁**
//
// 报告实测:`brandStatement` 原先**公开导出** ⇒ 任何生产模块都能
// `brandStatement("DROP DATABASE victim")` 铸出 branded 语句,"类型层构造不出来"这句话不成立。
// 现在 mint 函数是 `admin-ddl-templates.ts` 私有的。但 TS 的 brand **挡不住显式 cast**,
// 所以再加这道扫全仓的门禁 —— 让越界铸造变成"必须写一行会被测试抓到的代码"。
// ⚠️ 它是**可 grep 的约束**,不是不可绕过的边界;真边界是 §3.9a 的闭合执行器(P0-B 仍未关闭)。
// ══════════════════════════════════════════════════════════════════════════════
describe("🔴 GeneratedAdminStatement 的铸造面必须封闭(v3 P0-B)", () => {
  const HERE2 = dirname(fileURLToPath(import.meta.url));
  const SRC = resolve(HERE2, "../../..");
  const OWNER = "lib/exec-env/admin-ddl-templates.ts"; // 唯一允许铸造的文件

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }

  // 🔴 第二个维度(变异测试要求 ≥2 条):不看**源码文本**,看**运行时导出面**。
  // 只扫源码的门禁能被"换个写法导出"绕过(如 `export { brandStatement }`);
  // 而运行时导出面是它到底能不能被 import 到手,这才是私有化的真语义。
  it("🔴 运行时导出面:两个模块都不得暴露 mint 函数", async () => {
    const templates = await import("@/lib/exec-env/admin-ddl-templates");
    const request = await import("@/lib/exec-env/admin-ddl-request");
    expect(
      Object.keys(templates),
      "模板模块导出了 brandStatement ⇒ 任何模块 import 之后都能铸任意 admin SQL"
    ).not.toContain("brandStatement");
    expect(Object.keys(request)).not.toContain("brandStatement");
    // 正向:唯一合法出口仍要在(别把订正做过头,把模板本身也藏了)。
    expect(Object.keys(templates)).toContain("buildAdminDdlStatements");
  });

  it("🔴 全仓**任何文件**都不得 export mint 函数(含模板模块自己)", () => {
    // 门禁洞实录:第一版只查 `admin-ddl-request.ts`,于是"把 export 加回**模板模块**"这个变异
    // (M18)**全绿通过** —— 私有化的意义就在于"谁都不能导出它",查一个文件等于没查。
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const rel = f.slice(SRC.length + 1);
      if (rel.includes("__tests__")) continue;
      if (/export\s+(async\s+)?function\s+brandStatement/.test(stripComments(readFileSync(f, "utf8")))) {
        offenders.push(rel);
      }
    }
    expect(offenders, `${offenders.join(", ")} 导出了 mint 函数 ⇒ 任何模块都能铸任意 admin SQL`).toEqual([]);
  });

  it("`admin-ddl-request.ts` 不得再导出任何 mint 函数(brandStatement 已移入模板模块)", () => {
    const src = readFileSync(resolve(SRC, "lib/exec-env/admin-ddl-request.ts"), "utf8");
    expect(src, "request 模块又导出了 brandStatement ⇒ 公开 mint 面回来了").not.toMatch(
      /export\s+function\s+brandStatement/
    );
    expect(src, "不得导出 brand symbol(导出了就能在外部构造该类型)").not.toMatch(
      /export\s+(declare\s+)?const\s+ADMIN_DDL_BRAND/
    );
  });

  /**
   * 🔴 **扫描前必须剥注释**。
   * 第一版没剥,于是它抓到的第一个"违规文件"是 `admin-ddl-request.ts` —— 因为我在**注释里**
   * 举了 `brandStatement("DROP DATABASE victim")` 这个反例说明为什么要私有化。
   * 这与 `admin-ddl-guards.sqlSkeleton` 必须"先 mask 字面量再删注释"是同一个教训:
   * **检测器不剥掉非代码文本,就会把说明文字当成违规、把真违规淹没在噪声里。**
   */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  }

  it("🔴 全仓只有模板模块可以铸造 GeneratedAdminStatement(扫越界 cast)", () => {
    const files = walk(SRC);
    expect(files.length, "一个源文件都没扫到 ⇒ 路径解析错了,这条门禁等于没跑").toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.slice(SRC.length + 1);
      if (rel === OWNER) continue;
      if (rel.includes("__tests__")) continue; // 测试可以造反例,那是它的职责
      const src = stripComments(readFileSync(f, "utf8"));
      if (/as\s+(unknown\s+as\s+)?GeneratedAdminStatement/.test(src)) offenders.push(rel);
      if (/\bbrandStatement\s*\(/.test(src)) offenders.push(`${rel}(调用 brandStatement)`);
    }
    expect(
      offenders,
      `这些文件在模板模块之外铸造 admin-DDL 语句:${offenders.join(", ")}。` +
        `SQL 只能由 admin-ddl-templates.ts 的私有模板产出(50 SPEC §3.9a)`
    ).toEqual([]);
  });
});

// @kf-batch 50-WP9a-durable-jobs
describe("🔴 permission canary 的两条模板(WP-9 ④-3 / ⑨-7)", () => {
  const build = (s: AdminDdlRequest) =>
    buildAdminDdlStatements(s, ctx("projectId" in s ? (s as { projectId: string }).projectId : undefined, s)).map(String);

  it("create-canary-probes:三张探针表;只授本项目 role **SELECT**,deny schema 不授任何人;没有任何写数据 / DROP", () => {
    const sqls = build({ operation: "create-canary-probes", targetId: TID, projectId: PID });
    const grants = sqls.filter((q) => /^GRANT/.test(q));
    expect(grants).toHaveLength(2);
    for (const g of grants) {
      expect(g).toMatch(/^GRANT SELECT ON /);
      expect(g).toContain(`TO ROLE "${projectRoleName(PID)}"`);
      expect(g, "deny 探针被授权了 ⇒ C-3 永远测不出跨项目越权").not.toContain("bgp_canary_deny");
    }
    expect(sqls.some((q) => q.includes(`"${projectSchema(PID)}"."bgp_canary"`))).toBe(true);
    expect(sqls.some((q) => q.includes(`"shared"."bgp_canary"`))).toBe(true);
    expect(sqls.some((q) => q.includes(`"bgp_canary_deny"."bgp_canary"`))).toBe(true);
    for (const q of sqls) expect(q).not.toMatch(/\b(INSERT|DELETE|UPDATE|DROP|TRUNCATE)\b/i);
  });

  it("revoke-public-create:只有一条 REVOKE CREATE ON SCHEMA public FROM PUBLIC(收紧,不放开任何东西)", () => {
    expect(build({ operation: "revoke-public-create", targetId: TID })).toEqual(['REVOKE CREATE ON SCHEMA "public" FROM PUBLIC']);
  });

  it("两条都只由平台管理员发起(target 级的 revoke 不接受 projectId)", () => {
    expect(() => parseAdminDdlRequest({ operation: "revoke-public-create", targetId: TID, projectId: PID })).toThrow(/target 级/);
    expect(() => parseAdminDdlRequest({ operation: "create-canary-probes", targetId: TID })).toThrow(/projectId/);
  });
});
