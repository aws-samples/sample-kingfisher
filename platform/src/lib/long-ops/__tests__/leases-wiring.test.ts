// 模块 55 — 闸门 ⑬(55 DESIGN §2.8 对象租约)接线判据(「写了」≠「接上了」):
//   a) LONG_OP_RESOURCES 源码字面每种 kind 恰一条,键集 === LONG_OP_KINDS;声明里只经 resourceKey / tableResource 生成键,族字面 ⊆ LONG_OP_RESOURCE_FAMILIES;
//   b) 声明了租约族的实体(codetable / dimension / project / flink / workflow / datasource),其改 / 删路由(闭合清单)每个**直接改写**的方法都有
//      resourceBusyResponse([resourceKey("<族>", …)]) **调用点**且在写动作之前;改走长操作的方法(删项目 / 删 Flink 作业 / 删编排)则 submitLongOp 自己的 kind,
//      该 kind 的资源声明落在同一族(租约由 acquireLeases 占住);并反向:app/api/** 里调服务层改删入口的文件 ⊆ 该清单(没有绕过守卫的第二条路);
//      族清单闭合:每个 LONG_OP_RESOURCE_FAMILIES 要么登记了改删路由,要么明确列在「无改删路由」(table / approval / governance);
//   c) longOpErrorResponse 唯一作者在 http-error.ts,driver 只 re-export;guard.ts 不 import driver(免得改删路由拖进整张执行体注册表);
//   d) submitLongOp 两条路径(异步 / LONG_OPS_ASYNC=0)都先 acquireLeases;两处终态写(finalizeByOwner / forceTimeoutIfExpired)都释放。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { LONG_OP_KINDS, LONG_OP_RESOURCES, LONG_OP_RESOURCE_FAMILIES, resourceKey, type LongOpKind, type LongOpParamsByKind } from "../kinds";

const SRC = resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const noImports = (src: string) => stripComments(src).replace(/^import .*$/gm, "");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== "__tests__" && name !== "node_modules") walk(full, out); }
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

type Method = "PUT" | "DELETE" | "POST";
type LongOpMethod<K extends LongOpKind = LongOpKind> = { kind: K; sample: LongOpParamsByKind[K] };
interface MutationRoute {
  file: string;
  /** 直接在路由里改写的方法:必须有 resourceBusyResponse([resourceKey("<族>", <idExpr>)]) 调用点,且在第一处写动作之前 */
  guarded: Method[];
  /** 守卫里对象 id 的表达式字面(缺省 params.id;非 [id] 路由按请求体字段) */
  idExpr?: string;
  /** 改走长操作的方法:路由 submitLongOp 自己的 kind;该 kind 的资源声明要落在本族(租约由 acquireLeases 占住,不另写守卫) */
  longOps?: Partial<Record<Method, LongOpMethod>>;
  /** 守卫之后的第一处写动作(服务层改删函数或 DynamoDB 写命令) */
  mutation: RegExp;
  /** 服务层长入口 / 改删入口:app/api/** 的调用点必须 ⊆ 本路由(迁进执行体的入口在 app/api 应为 0 处) */
  serviceCalls: RegExp;
}
const DS_CREATE_SAMPLE: LongOpParamsByKind["datasource-create"] = {
  datasourceId: "ds-1", projectId: "proj-1", targetId: "tgt_home", name: "n1", type: "mysql", host: "h", port: 3306, database: "d", username: "u",
  secretArn: "arn:aws:secretsmanager:us-east-1:000000000000:secret:bgp/datasource/ds-1-AbCdEf",
};

/** 族 → 该实体的改 / 删路由(闭合;新实体进租约族时在这里登记,并给路由加守卫或把改删方法接成长操作)。 */
const FAMILY_MUTATION_ROUTES: Record<string, MutationRoute[]> = {
  codetable: [{ file: "app/api/modeling/codetables/[id]/route.ts", guarded: ["PUT", "DELETE"], mutation: /\b(?:deleteCodeTable|updateCodeTable)\(/, serviceCalls: /\b(?:deleteCodeTable|updateCodeTable)\(/ }],
  dimension: [{ file: "app/api/modeling/dimensions/[id]/route.ts", guarded: ["PUT", "DELETE"], mutation: /\b(?:deleteModelTable|updateModelTable)\(/, serviceCalls: /\b(?:deleteModelTable|updateModelTable)\(/ }],
  project: [{
    file: "app/api/projects/[id]/route.ts", guarded: ["PUT"],
    longOps: { DELETE: { kind: "project-delete", sample: { projectId: "proj-1" } } },
    mutation: /\bupdateProject\(/, serviceCalls: /\b(?:updateProject|deleteProject|inventoryProject|enqueueProjectCredReclaim)\(/,
  }],
  flink: [{
    file: "app/api/flink/jobs/[id]/route.ts", guarded: ["PUT"],
    longOps: { DELETE: { kind: "flink-delete", sample: { jobId: "job-1", targetId: "tgt_usw2_a" } } },
    mutation: /new UpdateCommand\(/, serviceCalls: /\b(?:startFlinkJob|pauseFlinkJob|requestFlinkDeletion|deleteFlinkApp)\(/,
  }],
  workflow: [
    {
      file: "app/api/workflow/[id]/route.ts", guarded: ["PUT"],
      longOps: { DELETE: { kind: "workflow-delete", sample: { workflowId: "wf-1" } } },
      mutation: /new UpdateCommand\(/, serviceCalls: /\b(?:publishWorkflowDag|unpublishWorkflowDag|startWorkflowRun)\(/,
    },
    // 监控页「启停调度」重新生成 DAG 写的是与发布同一份产物 ⇒ 同族守卫(第二批闸门 ⑬ b 抓到的绕过路径)
    {
      file: "app/api/schedule/enable/route.ts", guarded: ["POST"], idExpr: "taskId",
      mutation: /new UpdateCommand\(/, serviceCalls: /\b(?:publishWorkflowDag|unpublishWorkflowDag|startWorkflowRun)\(/,
    },
  ],
  datasource: [
    {
      file: "app/api/datasources/[id]/route.ts", guarded: ["PUT", "DELETE"],
      mutation: /new (?:UpdateCommand|DeleteCommand)\(/, serviceCalls: /\bensureExternalTable\(/,
    },
    // 序 57 / B-129:建源 provision 段改走长操作(租约 datasource:create:<项目>:<名字>);网络 / Glue 连接的服务层入口在 app/api 再无第二个调用点
    {
      file: "app/api/datasources/route.ts", guarded: [],
      longOps: { POST: { kind: "datasource-create", sample: DS_CREATE_SAMPLE } },
      mutation: /\b(?:detectNetwork|userSpecifiedNetwork|createGlueConnection|ensureGlueRole)\(/,
      serviceCalls: /\b(?:detectNetwork|userSpecifiedNetwork|createGlueConnection|ensureGlueRole)\(/,
    },
  ],
  // 第三批 / B-136:引擎作业「运行」的提交段改走长操作(租约 engine-job:<jobId>,由 run 路由的 submitLongOp 占);改 / 删作业路由加守卫
  "engine-job": [{
    file: "app/api/engines/[engine]/[id]/route.ts", guarded: ["PUT", "DELETE"],
    mutation: /\b(?:offlineEmrFanout|destroyResource)\(|new (?:UpdateCommand|DeleteCommand)\(/, serviceCalls: /\.destroyResource\(/,
  }],
};
/** 没有「改 / 删路由」的族:table(目标表只被长操作本身独占)· approval(审批单只经执行长操作改状态)· governance(schema-sync 单例,只做两次同步互斥)。 */
const FAMILIES_WITHOUT_MUTATION_ROUTES = ["table", "approval", "governance"] as const;

describe("模块 55 闸门 ⑬ a:LONG_OP_RESOURCES 声明闭合", () => {
  const kindsSrc = read("lib/long-ops/kinds.ts");
  const block = /export const LONG_OP_RESOURCES:[\s\S]*?=> string\[\] \} = \{([\s\S]*?)\n\};/.exec(kindsSrc);
  it("源码字面每种 kind 恰一条,键集 === LONG_OP_KINDS", () => {
    expect(block).toBeTruthy();
    const keys = [...block![1].matchAll(/^\s*"([a-z0-9-]+)":/gm)].map((m) => m[1]);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...LONG_OP_KINDS].sort());
  });
  it("键只经 resourceKey / tableResource 生成,族字面 ⊆ LONG_OP_RESOURCE_FAMILIES;运行时每种 kind 的声明是函数且 AI 七种 / 只读三种为空", () => {
    const body = block![1];
    expect(/`[^`]*:[^`]*`/.test(body.replace(/`\$\{schema\}\.\$\{table\}`/g, "")), "不许手拼带冒号的键字面").toBe(false);
    for (const m of body.matchAll(/resourceKey\(\s*"([a-z][a-z-]*)"/g)) expect(LONG_OP_RESOURCE_FAMILIES as readonly string[]).toContain(m[1]);
    expect(/resourceKey\(params\.entity, params\.id\)/.test(body), "modeling-unbind 的族来自 entity(codetable|dimension),与 ModelingEntity 同一组字面").toBe(true);
    for (const kind of LONG_OP_KINDS) expect(typeof LONG_OP_RESOURCES[kind]).toBe("function");
    const empty = [
      "copilot-ask", "net-advise", "param-advise", "codegen-etl", "codegen-emr", "codegen-requirement", "flink-ai-sql", "modeling-unbind-preview", "catalog-read-columns",
      // 第二批只读 / 纯计算三种:生成 DDL 只探测不建;两种指标计算只读聚合 + 写自己的快照
      "sync-generate-ddl", "modeling-metric-compute", "metric-compute",
    ] as const;
    for (const kind of empty) expect((LONG_OP_RESOURCES[kind] as (params: unknown) => string[])({}), `${kind} 应无独占资源`).toEqual([]);
    // 其余每种都占资源(非空),且键的族 ∈ LONG_OP_RESOURCE_FAMILIES
    const sample: { [K in LongOpKind]?: LongOpParamsByKind[K] } = {
      "governance-schema-sync": {},
      "project-delete": { projectId: "proj-1" },
      "sync-execute-ddl": { targetId: "tgt_usw2_a", projectId: "proj-1", spec: { fq: "public.t1", mapped: [] } as never },
      "flink-start": { jobId: "job-1", targetId: "tgt_usw2_a", discardStateConfirmed: false },
      "flink-stop": { jobId: "job-1", targetId: "tgt_usw2_a" },
      "flink-delete": { jobId: "job-1", targetId: "tgt_usw2_a" },
      "workflow-publish": { workflowId: "wf-1" },
      "workflow-unpublish": { workflowId: "wf-1" },
      "workflow-trigger": { workflowId: "wf-1", targets: ["tgt_home"] },
      "workflow-delete": { workflowId: "wf-1" },
      "datasource-s3-external": { datasourceId: "ds-1", projectId: "proj-1" },
      "datasource-create": DS_CREATE_SAMPLE,
      "engine-run": { engine: "emr-serverless", jobId: "job-1", projectId: "proj-1", runTargets: ["tgt_home"] },
    };
    for (const [kind, params] of Object.entries(sample) as Array<[LongOpKind, unknown]>) {
      const keys = (LONG_OP_RESOURCES[kind] as (params: unknown) => string[])(params);
      expect(keys.length, `${kind} 应占资源`).toBeGreaterThan(0);
      for (const key of keys) expect(LONG_OP_RESOURCE_FAMILIES as readonly string[], `${kind} 的键 ${key} 族未登记`).toContain(key.split(":")[0]);
    }
  });
  it("样例键(第二批):同步建表占目标表(与目录建表同键);Flink 三种同键;编排四种同键;删项目占项目;S3 外表占数据源;治理同步列为单例", () => {
    expect(LONG_OP_RESOURCES["sync-execute-ddl"]({ targetId: "tgt_usw2_a", projectId: "proj-1", spec: { fq: "public.t1" } as never })).toEqual(["table:tgt_usw2_a:public.t1"]);
    const flink = { jobId: "job-1", targetId: "tgt_usw2_a" };
    expect(LONG_OP_RESOURCES["flink-start"]({ ...flink, discardStateConfirmed: true })).toEqual(["flink:job-1"]);
    expect(LONG_OP_RESOURCES["flink-stop"](flink)).toEqual(["flink:job-1"]);
    expect(LONG_OP_RESOURCES["flink-delete"](flink)).toEqual(["flink:job-1"]);
    for (const kind of ["workflow-publish", "workflow-unpublish", "workflow-delete"] as const) expect(LONG_OP_RESOURCES[kind]({ workflowId: "wf-1" })).toEqual(["workflow:wf-1"]);
    expect(LONG_OP_RESOURCES["workflow-trigger"]({ workflowId: "wf-1", targets: ["tgt_home", "tgt_usw2_a"], runGroupId: "rg1" })).toEqual(["workflow:wf-1"]);
    expect(LONG_OP_RESOURCES["project-delete"]({ projectId: "proj-1" })).toEqual([resourceKey("project", "proj-1")]);
    expect(LONG_OP_RESOURCES["datasource-s3-external"]({ datasourceId: "ds-1", projectId: "proj-1" })).toEqual(["datasource:ds-1"]);
    expect(LONG_OP_RESOURCES["governance-schema-sync"]({})).toEqual(["governance:schema-sync"]);
    // 序 57 / B-129:建源占「项目 + 名字」(对象还没有 id;同名再点一次 ⇒ 409,不同名 / 不同项目互不阻塞;与 S3 外表的 datasource:<id> 不同键)
    expect(LONG_OP_RESOURCES["datasource-create"](DS_CREATE_SAMPLE)).toEqual(["datasource:create:proj-1:n1"]);
    expect(LONG_OP_RESOURCES["datasource-create"]({ ...DS_CREATE_SAMPLE, name: " n1 " })).toEqual(["datasource:create:proj-1:n1"]);
    expect(LONG_OP_RESOURCES["datasource-create"]({ ...DS_CREATE_SAMPLE, projectId: "proj-2" })).toEqual(["datasource:create:proj-2:n1"]);
    // B-136:运行提交段独占这条引擎作业(与改 / 删路由的守卫同键)
    expect(LONG_OP_RESOURCES["engine-run"]({ engine: "emr-serverless", jobId: "job-1", projectId: "proj-1", runTargets: ["tgt_home", "tgt_usw2_a"], runGroupId: "rg1" })).toEqual(["engine-job:job-1"]);
  });
  it("样例键:落地 ↔ 删码表同键;解绑按 entity 选族;改表 dryRun 不占、execute 占表;审批执行占审批单 + 表", () => {
    expect(LONG_OP_RESOURCES["modeling-land"]({ codeTableId: "ct1", force: false, probeOnly: false })).toEqual([resourceKey("codetable", "ct1")]);
    expect(LONG_OP_RESOURCES["modeling-unbind"]({ entity: "dimension", id: "mt1", targetId: "tgt_usw2_a", cleanup: true })).toEqual(["dimension:mt1"]);
    const alter = { targetId: "tgt_usw2_a", schema: "public", table: "t1", desired: [], env: "dev", projectId: "proj-1" };
    expect(LONG_OP_RESOURCES["catalog-alter-table"]({ ...alter, mode: "dryRun" })).toEqual([]);
    expect(LONG_OP_RESOURCES["catalog-alter-table"]({ ...alter, mode: "execute" })).toEqual(["table:tgt_usw2_a:public.t1"]);
    expect(LONG_OP_RESOURCES["approval-execute-ddl"]({ approvalId: "ap1", decided: {}, payload: { action: "alter", env: "prod", targetId: "tgt_home", schema: "s", table: "t", desired: [] } }))
      .toEqual(["approval:ap1", "table:tgt_home:s.t"]);
  });
});

describe("模块 55 闸门 ⑬ b:声明了租约族的实体,改 / 删路由必须有守卫调用点(或改走长操作),且没有绕过守卫的第二条路", () => {
  const apiFiles = walk(join(SRC, "app/api")).map((f) => [relative(SRC, f), noImports(readFileSync(f, "utf8"))] as const);
  it("族清单闭合:每个 LONG_OP_RESOURCE_FAMILIES 要么登记了改删路由,要么明确列为无改删路由;两边不重叠", () => {
    const withRoutes = Object.keys(FAMILY_MUTATION_ROUTES);
    expect([...withRoutes, ...FAMILIES_WITHOUT_MUTATION_ROUTES].sort()).toEqual([...LONG_OP_RESOURCE_FAMILIES].sort());
  });
  for (const [family, routes] of Object.entries(FAMILY_MUTATION_ROUTES)) {
    it(`${family}:登记路由的直接改写方法先调 resourceBusyResponse([resourceKey("${family}", …)]) 再动手;长操作方法 submitLongOp 本族 kind;服务层入口的 app/api 调用点 ⊆ 登记路由`, () => {
      for (const route of routes) {
        const src = noImports(read(route.file));
        const guardRe = new RegExp(`resourceBusyResponse\\(\\[resourceKey\\("${family}", ${(route.idExpr ?? "params.id").replace(".", "\\.")}\\)\\]\\)`, "g");
        expect([...src.matchAll(guardRe)].length, `${route.file} 守卫调用点数应 === 直接改写方法数`).toBe(route.guarded.length);
        for (const method of route.guarded) {
          const fn = new RegExp(`export async function ${method}\\(([\\s\\S]*?)\\n\\}`).exec(src);
          expect(fn, `${route.file} 缺 ${method}`).toBeTruthy();
          expect(fn![1], `${route.file} ${method} 内要先核租约再动手`).toMatch(guardRe);
          expect(fn![1].search(route.mutation), `${route.file} ${method} 里找不到写动作`).toBeGreaterThan(0);
          expect(fn![1].indexOf("resourceBusyResponse("), `${route.file} ${method} 守卫要在写动作之前`).toBeLessThan(fn![1].search(route.mutation));
        }
        for (const [method, op] of Object.entries(route.longOps ?? {}) as Array<[Method, LongOpMethod]>) {
          const fn = new RegExp(`export async function ${method}\\(([\\s\\S]*?)\\n\\}`).exec(src);
          expect(fn, `${route.file} 缺 ${method}`).toBeTruthy();
          expect(fn![1], `${route.file} ${method} 应经 submitLongOp`).toMatch(/submitLongOp\(/);
          expect(fn![1], `${route.file} ${method} 应提交 ${op.kind}`).toContain(`kind: "${op.kind}"`);
          expect(fn![1], `${route.file} ${method} 走长操作就不该再写守卫(租约由 acquireLeases 占)`).not.toMatch(/resourceBusyResponse\(/);
          expect(fn![1], `${route.file} ${method} 主体不该留在路由`).not.toMatch(route.mutation);
          const keys = (LONG_OP_RESOURCES[op.kind] as (params: unknown) => string[])(op.sample);
          expect(keys.some((k) => k.startsWith(`${family}:`)), `${op.kind} 的资源声明要落在 ${family} 族`).toBe(true);
        }
      }
      const callers = apiFiles.filter(([, src]) => routes.some((route) => route.serviceCalls.test(src))).map(([rel]) => rel);
      const allowed = new Set(routes.map((route) => route.file));
      expect(callers.filter((rel) => !allowed.has(rel)), `${family} 有绕过守卫的服务层调用点`).toEqual([]);
    });
  }
});

describe("模块 55 闸门 ⑬ c / d:单一作者与接线", () => {
  it("longOpErrorResponse 只在 http-error.ts 定义,driver 只 re-export;guard.ts 不 import driver / registry", () => {
    expect(/export function longOpErrorResponse\(/.test(read("lib/long-ops/http-error.ts"))).toBe(true);
    const driver = read("lib/long-ops/driver.ts");
    expect(/export function longOpErrorResponse\(/.test(driver)).toBe(false);
    expect(driver).toContain('export { longOpErrorResponse } from "./http-error";');
    const guard = read("lib/long-ops/guard.ts");
    expect(/from "\.\/driver"|from "\.\/registry"/.test(guard)).toBe(false);
    expect(guard).toMatch(/assertResourcesFree\(resources\)/);
  });
  it("submitLongOp 两条路径都先 acquireLeases;createLongOp 带 taskId + leases;两处终态写都 releaseLeasesOfRow", () => {
    const driver = noImports(read("lib/long-ops/driver.ts"));
    expect([...driver.matchAll(/await acquireLeases\(/g)].length).toBe(2);
    expect(driver).toMatch(/createLongOp\(\{ taskId, leases: resources,/);
    expect(driver).toMatch(/LONG_OP_RESOURCES\[input\.kind\]/);
    const store = noImports(read("lib/long-ops/store.ts"));
    expect([...store.matchAll(/await releaseLeasesOfRow\(taskId, out\.Attributes/g)].length).toBe(2);
    expect([...store.matchAll(/ReturnValues: "ALL_NEW"/g)].length).toBe(2);
  });
});
