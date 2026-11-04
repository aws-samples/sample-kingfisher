// 模块 55 — 闸门 ② ③ ⑤(55 DESIGN §2.7):三条只减不增的棘轮。
//   ② 「循环等外部终态」的本地原语只许出现在基线文件里(基线 = 2026-10-21 盘点 §10 的 30 个文件减去已迁出的 landing.ts、再减去扫描词表不计的两处有界重试 / 内联短轮询 = 27;
//      第二批迁出 6 个 ⇒ 21;序 58 B-130 把 datasource-service 的内存重试迁为泵作业 ⇒ 20;迁到 awaitTerminal / 泵一个就从基线删一个;新文件出现即红);
//   ③ 后台等待者上下文 runAsBackgroundWaiter( 只许在登记的循环入口文件里建,app/api/** 出现即红;owner 字面 ∈ BACKGROUND_WAITERS(第二批首个:flink-service 的删除收尾);
//   ⑤ app/api/** 直接调用长服务入口(LONG_SERVICE_ENTRYPOINTS)的路由文件 ⊆ 基线(第一批把建模 / 目录 / 审批十条迁出;第二批再迁出 14 条路由 / 9 个基线文件)。
// 🔴 两张基线都**只许删行**。想加一行 = 想在请求路径里再写一条同步等终态 = 正是本模块要根治的那一类缺陷。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { BACKGROUND_WAITERS } from "../context";

const SRC = resolve(__dirname, "../../..");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== "__tests__" && name !== "node_modules") walk(full, out); }
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}
const FILES = walk(SRC).map((f) => [relative(SRC, f), stripComments(readFileSync(f, "utf8"))] as const);

/** 「本地 sleep 循环」:自己定义 / 调用一个 sleep 类辅助,或裸写 setTimeout-Promise;且同文件里有等外部状态的 SDK 命令 / 读状态函数。 */
const SLEEP_LIKE = /\b(?:sleep|delay|pause|backoff|wait(?:Ms|For|Until)?)\w*\s*\(\s*[\w.*+\-/() ]*\)|new Promise\s*(?:<[^>]*>)?\s*\(\s*\(?\s*(?:r|res|resolve|_?done)\b[^)]*\)?\s*=>\s*setTimeout/;
const STATUS_PROBE = /\b(?:DescribeStatementCommand|GetStatementResultCommand|GetQueryExecutionCommand|GetJobRunCommand|GetJobRunsCommand|DescribeReplicationTasksCommand|DescribeReplicationInstancesCommand|DescribeApplicationCommand|GetApplicationCommand|DescribeStreamSummaryCommand|DescribeIntegrationsCommand|ListWorkflowRunsCommand|GetWorkflowRunCommand|DescribeStacksCommand|GetCrawlerCommand|DescribeSecurityGroupsCommand|describeStatementState|getExecution|getIntegrationStatus|getJobRun|waitUntil[A-Z]\w*|dags list|testEndpoints|GetTableCommand)\b/;

/** ② 基线:2026-10-21 盘点(55 DESIGN §10)时仍在自己写 sleep 循环等外部终态的文件。只许删。 */
const AWAIT_TERMINAL_BASELINE = new Set<string>([
  "lib/exec-env/target-clients.ts",
  "lib/redshift/direct-query.ts",
  // 🔴 第二批刻意不迁(迁了会在运行第一步抛 LongOpContextMissing;调用方理由见 55 DESIGN §6):
  //   target-table-guard(probeTables ← overwritePreflight ← 同步建改任务路由,20s 预算)· mwaa-endpoint(unpauseWhenLoaded ← schedule 路由 fire-and-forget)·
  //   serverless/workflow-client(← action-schedules / trigger.ts / dependency.ts 内部请求路径)⇒ 第三批
  "lib/sync/target-table-guard.ts",
  "lib/sync/start-run.ts",
  "lib/etl/job-service.ts",
  "lib/backfill/execute.ts",
  "lib/engines/emr/provider.ts",
  "lib/engines/emr/application.ts",
  "lib/genbi/athena.ts",
  "lib/realtime/zeroetl-service.ts",
  "lib/realtime/redshift-target.ts",
  "lib/realtime/dms-service.ts",
  "app/api/sync/[id]/start-realtime/route.ts",
  "app/api/sync/[id]/start/route.ts",
  "lib/exec-env/public-create-readback.ts",
  "lib/seed/run-once.ts",
  "lib/datasource/glue-reach.ts",
  "lib/datasource-spi/stream/kinesis.ts",
  // 序 58 B-130:datasource-service 的 deletePlatformSecurityGroupWithRetry(内存 sleep 循环等网卡释放)已迁为泵作业 sg-cleanup ⇒ 从基线删掉
  "lib/scheduler/mwaa-endpoint.ts",
  "lib/scheduler/serverless/workflow-client.ts",
]);
/** ② 第二批迁出(反向钉:这些文件再出现本地 sleep 循环即红)。 */
const SECOND_BATCH_AWAIT_TERMINAL_MIGRATED = [
  "lib/modeling/redshift.ts", "lib/projects/project-resources.ts", "app/api/sync/execute-ddl/route.ts",
  "lib/datasource-spi/object-store/athena-external.ts", "lib/realtime/flink-service.ts", "app/api/workflow/[id]/trigger/route.ts",
];

/** ③ 后台等待者的循环入口文件(闭合)。第二批首个:flink-service 的 ensureFlinkDeletion(删除受理后在后台等 MSAF 停稳再销毁);runJobStep / runForTarget 等第三批再登记。 */
const BACKGROUND_WAITER_ENTRYPOINTS = new Set<string>(["lib/realtime/flink-service.ts"]);

/** ⑤ 路由层直接调用的长服务入口(闭合清单;第一批把建模 / 目录 / 审批十条迁出,第二批再迁出 9 个基线文件,剩下的在基线里只减不增)。 */
const LONG_SERVICE_ENTRYPOINTS = [
  "landCodeTableById", "applyModelTableById", "unbindCodeTable", "unbindModelTable", "previewUnbindCodeTable", "previewUnbindModelTable",
  "createRedshiftCatalogTable", "createS3Table", "planCatalogAlter", "alterCatalogTable", "readLiveColumns", "executeApprovedDdl",
  "startOrJoinSchemaSync", "runSchemaSyncRecorded", "inventoryProject", "deleteProject", "probeTables", "directQueryRaw", "runSelectAthena", "introspectS3Tables", "ensureExternalTable",
  "startFlinkJob", "pauseFlinkJob", "requestFlinkDeletion", "deleteFlinkApp", "unpauseWhenLoaded", "ensureWorkflow", "deleteWorkflow", "startWorkflowRun",
  "publishWorkflowDag", "unpublishWorkflowDag", "computeModelMetric", "computeMetric",
  "ensureApplication", "ensureStarted", "destroyApplication", "teardownReplicationTask", "classifyRegionsByOrgPolicy",
];
const ROUTE_DIRECT_CALL_BASELINE = new Set<string>([
  "app/api/etl-jobs/[id]/schedule/route.ts",
  "app/api/engines/[engine]/[id]/schedule/route.ts",
  // schedule/enable 重新生成 DAG 直接 await publishWorkflowDag(与编排发布同一份实现)⇒ 第三批接成长操作
  "app/api/schedule/enable/route.ts",
  "app/api/governance/catalog/route.ts",
  "app/api/redshift/schemas/route.ts",
  "app/api/bi/schema/route.ts",
  "app/api/admin/exec-envs/candidate-regions/route.ts",
]);
const FIRST_BATCH_MIGRATED = [
  "app/api/modeling/codetables/[id]/land/route.ts", "app/api/modeling/dimensions/[id]/apply/route.ts",
  "app/api/modeling/codetables/[id]/unbind/route.ts", "app/api/modeling/dimensions/[id]/unbind/route.ts",
  "app/api/modeling/codetables/[id]/unbind-preview/route.ts", "app/api/modeling/dimensions/[id]/unbind-preview/route.ts",
  "app/api/governance/tables/route.ts", "app/api/governance/tables/alter/route.ts", "app/api/governance/tables/columns/route.ts", "app/api/approvals/[id]/route.ts",
];
const SECOND_BATCH_MIGRATED = [
  "app/api/governance/sync-redshift-schema/route.ts", "app/api/projects/[id]/route.ts",
  "app/api/sync/execute-ddl/route.ts", "app/api/sync/generate-ddl/route.ts",
  "app/api/flink/jobs/[id]/start/route.ts", "app/api/flink/jobs/[id]/stop/route.ts", "app/api/flink/jobs/[id]/route.ts",
  "app/api/workflow/[id]/publish/route.ts", "app/api/workflow/[id]/unpublish/route.ts", "app/api/workflow/[id]/trigger/route.ts", "app/api/workflow/[id]/route.ts",
  "app/api/datasources/[id]/s3-external/route.ts", "app/api/modeling/model-metrics/[id]/compute/route.ts", "app/api/metrics/[id]/compute/route.ts",
];

describe("模块 55 闸门 ②:等待终态的轮询原语只许一个作者", () => {
  it("自己写 sleep 循环等外部状态的文件 ⊆ 基线(只减不增);lib/modeling/landing.ts 已迁出不在其中", () => {
    const offenders = FILES.filter(([rel, src]) => rel !== "lib/long-ops/await-terminal.ts" && SLEEP_LIKE.test(src) && STATUS_PROBE.test(src)).map(([rel]) => rel);
    const fresh = offenders.filter((rel) => !AWAIT_TERMINAL_BASELINE.has(rel));
    expect(fresh, `新出现了自己写 sleep 循环等外部终态的文件(请改经 lib/long-ops/await-terminal.ts,并在该路由接入 submitLongOp):\n${fresh.join("\n")}`).toEqual([]);
    expect(offenders).not.toContain("lib/modeling/landing.ts");
    for (const rel of SECOND_BATCH_AWAIT_TERMINAL_MIGRATED) expect(offenders, `${rel} 第二批已迁出,不许再写本地轮询`).not.toContain(rel);
    expect(AWAIT_TERMINAL_BASELINE.size).toBe(20); // 序 58 B-130:datasource-service 迁为泵作业 ⇒ 21 → 20
    // 基线里已经干净的文件要从基线删掉(棘轮只减不增的另一半:不许留着已修好的名额)
    const stale = [...AWAIT_TERMINAL_BASELINE].filter((rel) => !offenders.includes(rel));
    expect(stale, `这些基线文件已不再自己写轮询循环,请从 AWAIT_TERMINAL_BASELINE 删掉:\n${stale.join("\n")}`).toEqual([]);
  });
});

describe("模块 55 闸门 ③:后台等待者上下文只许在登记的循环入口建", () => {
  it("runAsBackgroundWaiter( 调用点文件 === BACKGROUND_WAITER_ENTRYPOINTS;app/api/** 不许出现;owner 字面 ∈ BACKGROUND_WAITERS", () => {
    const sites = FILES.filter(([rel, src]) => rel !== "lib/long-ops/context.ts" && /\brunAsBackgroundWaiter\(/.test(src));
    expect(sites.map(([rel]) => rel).sort()).toEqual([...BACKGROUND_WAITER_ENTRYPOINTS].sort());
    for (const [rel, src] of sites) {
      expect(rel.startsWith("app/api/"), `${rel}:请求路径不许建后台等待者上下文`).toBe(false);
      for (const m of src.matchAll(/runAsBackgroundWaiter\(\s*"([^"]+)"/g)) expect(BACKGROUND_WAITERS as readonly string[], `${rel} owner「${m[1]}」未登记`).toContain(m[1]);
    }
  });
});

describe("模块 55 闸门 ⑤:路由层直接 await 长服务的文件只减不增", () => {
  it("app/api/** 直接调用 LONG_SERVICE_ENTRYPOINTS 的文件 ⊆ 基线;第一批十条路由已不在其中", () => {
    const re = new RegExp(`\\b(?:${LONG_SERVICE_ENTRYPOINTS.join("|")})\\(`);
    const direct = FILES.filter(([rel, src]) => rel.startsWith("app/api/") && re.test(src.replace(/^import .*$/gm, ""))).map(([rel]) => rel);
    const fresh = direct.filter((rel) => !ROUTE_DIRECT_CALL_BASELINE.has(rel));
    expect(fresh, `新路由直接 await 长服务入口(请改经 submitLongOp):\n${fresh.join("\n")}`).toEqual([]);
    for (const rel of FIRST_BATCH_MIGRATED) expect(direct, `${rel} 应已迁出`).not.toContain(rel);
    for (const rel of SECOND_BATCH_MIGRATED) expect(direct, `${rel} 第二批应已迁出`).not.toContain(rel);
    // 第二批 14 条路由都经 submitLongOp(不是把直接调用改了个名字绕过词表)
    for (const rel of SECOND_BATCH_MIGRATED) {
      const src = FILES.find(([f]) => f === rel)?.[1] ?? "";
      expect(src, `${rel} 应经 submitLongOp`).toMatch(/submitLongOp\(/);
    }
    const stale = [...ROUTE_DIRECT_CALL_BASELINE].filter((rel) => !direct.includes(rel));
    expect(stale, `这些基线路由已不再直接调长服务,请从 ROUTE_DIRECT_CALL_BASELINE 删掉:\n${stale.join("\n")}`).toEqual([]);
  });
});
