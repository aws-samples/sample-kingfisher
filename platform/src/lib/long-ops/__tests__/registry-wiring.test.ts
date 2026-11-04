// 接线判据(「写了」≠「接上了」;55 DESIGN §2.7 ① ④ ⑧ ⑨ ⑩ ⑪):
//   ① kind 闭合清单 ↔ 各域执行体文件(清单从 registry.ts 的 import + 展开字面推出,第一批 3 个域、第二批 9 个)的对象字面键集 ↔ 标签 ↔ 参数类型一一对应;
//   ④ 每条已接入路由 submitLongOp 自己的 kind、longOpResponse / longOpErrorResponse、主体不再留在路由(第一批 17 条 + 第二批 14 条);
//   ⑧ 全局 fetch 拦截器接了 followLongOp;壳层挂了 LongOpIndicator;英文词典含每个标签;
//   ⑨ 两侧表名一致(TABLES.LONG_OPS ↔ infra 建表),仓内再无 bgp-ai-tasks / AI_TASKS 字面;
//   ⑪ 读取级台账无 /api/ai/tasks 条目,/api/long-ops 在 INFRA_APIS。
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { LONG_OP_KINDS, LONG_OP_LABELS } from "../kinds";
import { TABLES } from "@/lib/aws/dynamodb";
import { UNSCOPED_READS } from "@/lib/scope/api-read-ledger";
import { EN } from "@/lib/i18n/messages/en";

const SRC = resolve(__dirname, "../../..");
const REPO = resolve(SRC, "../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function literalKeys(file: string, objectName: string): string[] {
  const src = read(file);
  const block = new RegExp(`export const ${objectName}[^=]*= \\{([\\s\\S]*?)\\n\\};`).exec(src);
  expect(block, `${file} 找不到 ${objectName} 对象字面`).toBeTruthy();
  return [...block![1].matchAll(/^\s*"([a-z0-9-]+)":/gm)].map((m) => m[1]);
}

/** 域执行体文件清单**不手写**:从 registry.ts 的 `import { X_LONG_OP_EXECUTORS } from "@/lib/…"` 推出(「写了」≠「接上了」:import 了没展开 / 展开了没 import 都红)。 */
function executorDomains(): Array<{ name: string; file: string }> {
  const reg = stripComments(read("lib/long-ops/registry.ts"));
  const imported = [...reg.matchAll(/^import \{ (\w+_LONG_OP_EXECUTORS) \} from "@\/(lib\/[\w/-]+)";/gm)].map((m) => ({ name: m[1], file: `${m[2]}.ts` }));
  const spread = [...reg.matchAll(/^\s*\.\.\.(\w+),/gm)].map((m) => m[1]);
  expect(spread.sort(), "registry.ts 展开的域 === import 的域").toEqual(imported.map((x) => x.name).sort());
  expect(imported.length, "第一批 3 个域 + 第二批 6 个域 + 第三批 1 个域(engines)").toBe(10);
  return imported;
}

const ROUTES: Array<[file: string, kind: (typeof LONG_OP_KINDS)[number], bodyCall: RegExp]> = [
  ["app/api/copilot/ask/route.ts", "copilot-ask", /\brunCopilot\(|invokeCopilotAgent\(/],
  ["app/api/network-advisor/advise/route.ts", "net-advise", /\badvise\(/],
  ["app/api/param-advisor/advise/route.ts", "param-advise", /\badvise\(/],
  ["app/api/etl-jobs/generate/route.ts", "codegen-etl", /generateEtlCode\(/],
  ["app/api/engines/generate/route.ts", "codegen-emr", /generateEtlCode\(/],
  ["app/api/requirements/[id]/generate/route.ts", "codegen-requirement", /generateImplementation\(/],
  ["app/api/flink/ai-sql/route.ts", "flink-ai-sql", /generateFlinkSql\(/],
  ["app/api/modeling/codetables/[id]/land/route.ts", "modeling-land", /landCodeTableById\(/],
  ["app/api/modeling/dimensions/[id]/apply/route.ts", "modeling-apply", /applyModelTableById\(/],
  ["app/api/modeling/codetables/[id]/unbind/route.ts", "modeling-unbind", /unbindCodeTable\(/],
  ["app/api/modeling/dimensions/[id]/unbind/route.ts", "modeling-unbind", /unbindModelTable\(/],
  ["app/api/modeling/codetables/[id]/unbind-preview/route.ts", "modeling-unbind-preview", /previewUnbindCodeTable\(/],
  ["app/api/modeling/dimensions/[id]/unbind-preview/route.ts", "modeling-unbind-preview", /previewUnbindModelTable\(/],
  ["app/api/governance/tables/route.ts", "catalog-create-table", /createRedshiftCatalogTable\(|createS3Table\(/],
  ["app/api/governance/tables/alter/route.ts", "catalog-alter-table", /planCatalogAlter\(|alterCatalogTable\(/],
  ["app/api/governance/tables/columns/route.ts", "catalog-read-columns", /readLiveColumns\(/],
  ["app/api/approvals/[id]/route.ts", "approval-execute-ddl", /executeApprovedDdl\(/],
  // ── 第二批(55 DESIGN §2.6a) ──
  ["app/api/governance/sync-redshift-schema/route.ts", "governance-schema-sync", /startOrJoinSchemaSync\(|runSchemaSyncRecorded\(|pushRedshiftSchemaToOpenMetadata\(/],
  ["app/api/projects/[id]/route.ts", "project-delete", /inventoryProject\(|deleteProject\(|enqueueProjectCredReclaim\(/],
  ["app/api/sync/execute-ddl/route.ts", "sync-execute-ddl", /probeTables\(|new ExecuteStatementCommand\(|DescribeStatementCommand/],
  ["app/api/sync/generate-ddl/route.ts", "sync-generate-ddl", /probeTables\(/],
  ["app/api/flink/jobs/[id]/start/route.ts", "flink-start", /startFlinkJob\(/],
  ["app/api/flink/jobs/[id]/stop/route.ts", "flink-stop", /pauseFlinkJob\(/],
  ["app/api/flink/jobs/[id]/route.ts", "flink-delete", /requestFlinkDeletion\(|deleteFlinkApp\(/],
  ["app/api/workflow/[id]/publish/route.ts", "workflow-publish", /publishWorkflowDag\(|ensureDagUnpaused\(/],
  ["app/api/workflow/[id]/unpublish/route.ts", "workflow-unpublish", /unpublishWorkflowDag\(/],
  ["app/api/workflow/[id]/trigger/route.ts", "workflow-trigger", /startWorkflowRun\(|CreateCliTokenCommand|dags list|putRunRecord\(/],
  ["app/api/workflow/[id]/route.ts", "workflow-delete", /unpublishWorkflowDag\(/],
  ["app/api/datasources/[id]/s3-external/route.ts", "datasource-s3-external", /ensureExternalTable\(|\.introspect\(/],
  ["app/api/modeling/model-metrics/[id]/compute/route.ts", "modeling-metric-compute", /computeModelMetric\(/],
  ["app/api/metrics/[id]/compute/route.ts", "metric-compute", /computeMetric\(/],
  // ── 第三批首条:建源 provision 段;密钥仍在路由里建(口令不落任务行),其余四步进执行体 ──
  //   (非 JDBC 范式的 `provider.testConnection(` 是真探测、合法留在路由,只盯裸调用的 JDBC 配置核对)
  ["app/api/datasources/route.ts", "datasource-create", /ensureGlueRole\(|detectNetwork\(|userSpecifiedNetwork\(|createGlueConnection\(|(?<!\.)\btestConnection\(|readSourceSchema\(/],
  // 第三批第二条:提交段(逐区 submit / 运行组逐 target 记账 / 扇出循环)全在执行体,路由里一个都不许留
  ["app/api/engines/[engine]/[id]/run/route.ts", "engine-run", /\.submit\(|forEachTargetPlace\(|noteFanoutResult\(|recordAudit\(/],
];

describe("接线 ①:kind 闭合清单 ↔ 执行体 ↔ 标签 ↔ 参数类型", () => {
  it("registry.ts 接入的各域执行体文件的对象字面键集之并 === LONG_OP_KINDS(无重叠、无遗漏);九个域文件齐", () => {
    const domains = executorDomains();
    expect(domains.map((x) => x.file).sort()).toEqual([
      "lib/ai/long-op-executors.ts", "lib/modeling/long-ops.ts", "lib/governance/long-ops.ts",
      "lib/projects/long-ops.ts", "lib/sync/long-ops.ts", "lib/realtime/long-ops.ts", "lib/workflow/long-ops.ts", "lib/datasource/long-ops.ts", "lib/metrics/long-ops.ts",
      "lib/engines/long-ops.ts",
    ].sort());
    const all = domains.flatMap((x) => literalKeys(x.file, x.name));
    expect(new Set(all).size, "各域之间不许重复登记同一 kind").toBe(all.length);
    expect([...all].sort()).toEqual([...LONG_OP_KINDS].sort());
    // 第二批 14 种确实在它们该在的域(不是塞进别的域凑数)
    expect(literalKeys("lib/projects/long-ops.ts", "PROJECT_LONG_OP_EXECUTORS")).toEqual(["project-delete"]);
    expect(literalKeys("lib/sync/long-ops.ts", "SYNC_LONG_OP_EXECUTORS").sort()).toEqual(["sync-execute-ddl", "sync-generate-ddl"]);
    expect(literalKeys("lib/realtime/long-ops.ts", "REALTIME_LONG_OP_EXECUTORS").sort()).toEqual(["flink-delete", "flink-start", "flink-stop"]);
    expect(literalKeys("lib/workflow/long-ops.ts", "WORKFLOW_LONG_OP_EXECUTORS").sort()).toEqual(["workflow-delete", "workflow-publish", "workflow-trigger", "workflow-unpublish"]);
    expect(literalKeys("lib/datasource/long-ops.ts", "DATASOURCE_LONG_OP_EXECUTORS").sort()).toEqual(["datasource-create", "datasource-s3-external"]);
    expect(literalKeys("lib/metrics/long-ops.ts", "METRICS_LONG_OP_EXECUTORS")).toEqual(["metric-compute"]);
    expect(literalKeys("lib/governance/long-ops.ts", "GOVERNANCE_LONG_OP_EXECUTORS")).toContain("governance-schema-sync");
    expect(literalKeys("lib/modeling/long-ops.ts", "MODELING_LONG_OP_EXECUTORS")).toContain("modeling-metric-compute");
  });

  it("LONG_OP_LABELS 键集 === LONG_OP_KINDS,标签非空且互异;LongOpParamsByKind 源码字面每种 kind 一条", () => {
    expect(Object.keys(LONG_OP_LABELS).sort()).toEqual([...LONG_OP_KINDS].sort());
    const labels = Object.values(LONG_OP_LABELS);
    expect(labels.every((l) => l.trim().length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
    const kinds = read("lib/long-ops/kinds.ts");
    const iface = /export interface LongOpParamsByKind \{([\s\S]*?)\n\}/.exec(kinds)!;
    for (const kind of LONG_OP_KINDS) expect(iface[1], `LongOpParamsByKind 缺 ${kind}`).toMatch(new RegExp(`^\\s*"${kind}":`, "m"));
    expect(stripComments(kinds)).not.toMatch(/token/i);
  });

  it("🔴 copilot-ask 的参数类型没有 token 字段;执行体从承载请求的 Authorization 取(铁律沿用)", () => {
    const iface = /"copilot-ask": \{([^}]*)\}/.exec(read("lib/long-ops/kinds.ts"))!;
    expect(iface[1]).not.toMatch(/token/i);
    expect(read("lib/ai/long-op-executors.ts")).toMatch(/headers\.get\("authorization"\)/);
  });
});

describe("接线 ④:已接入路由 ↔ submitLongOp ↔ 自己的 kind", () => {
  it("每条路由 submitLongOp 自己的 kind(只此一种)、longOpResponse(req, result)、longOpErrorResponse(、主体不再留在路由里", () => {
    for (const [file, kind, bodyCall] of ROUTES) {
      const src = stripComments(read(file)).replace(/^import .*$/gm, "");
      expect(src, file).toMatch(/submitLongOp\(/);
      expect(src, file).toContain(`kind: "${kind}"`);
      expect(src, `${file} 只许提交自己的 kind`).not.toMatch(new RegExp(`kind: "(?!${kind}")[a-z0-9-]+"`));
      expect(src, file).toMatch(/longOpResponse\(req, result\)/);
      expect(src, file).toMatch(/longOpErrorResponse\(/);
      expect(src, `${file} 的主体应已搬进执行体`).not.toMatch(bodyCall);
    }
  });

  it("每个执行体都记审计 / 记忆(主体没有被搬丢):建模四条的审计动作名 + 目录四条 + AI 七条", () => {
    const modeling = read("lib/modeling/long-ops.ts");
    for (const mark of ['"modeling.codetable.land"', '"modeling.codetable.probe"', '"modeling.dimension.apply"', '"modeling.codetable.unbind"', '"modeling.dimension.unbind"', "UnbindRejected", "落地产物未清理、记录与绑定保留"]) expect(modeling, mark).toContain(mark);
    const governance = read("lib/governance/long-ops.ts");
    for (const mark of ['"governance.table.create"', '"governance.table.alter"', '"governance.table.alter.request"', '"approval.decide"', "resultStatus: 201", "resultStatus: 202", "DECISION_REQUIRED", "ALTER_REJECTED"]) expect(governance, mark).toContain(mark);
    const ai = read("lib/ai/long-op-executors.ts");
    for (const mark of ['"copilot.ask"', "netAppendTurn(", "paramAppendTurn(", '"etl-job.ai-generate"', '"engine.ai-generate"', '"requirement.generate"', '"flink.ai_sql"', "new LongOpHttpError(422,"]) expect(ai, mark).toContain(mark);
  });

  it("第二批执行体的主体没有被搬丢:审计动作名 / 原口径状态码 / rawBody / 单一作者调用", () => {
    const marks: Record<string, string[]> = {
      "lib/governance/long-ops.ts": ["runSchemaSyncRecorded(", "work: schemaSyncWork", "schemaSyncMessage(", '"governance-schema-sync":'],
      "lib/projects/long-ops.ts": ["inventoryProject(", "enqueueProjectCredReclaim(", "deleteProject(", '"project.delete.cred-reclaim-refused"', '"project.delete"', 'code: "VALIDATION_FAILED"', 'code: "UPSTREAM_ERROR"'],
      "lib/sync/long-ops.ts": ["probeTables(", "resolveRedshiftBinding(", '"sync.execute-ddl"', "new ExecuteStatementCommand(", "TargetBindingRejected", "awaitTerminal", "SYNC_DDL_WAIT_POLLS"],
      "lib/realtime/long-ops.ts": ["startFlinkJob(", "pauseFlinkJob(", "requestFlinkDeletion(", '"flink.start"', '"flink.stop"', '"flink.delete"', '"flink.delete.accepted"', 'code: "DECISION_REQUIRED"', "resultStatus: 202", 'code: "UPSTREAM_ERROR"'],
      "lib/workflow/long-ops.ts": ["publishWorkflowDag(", "await ensureDagUnpaused(", "unpublishWorkflowDag(", "startWorkflowRun(", "putRunRecord(", "fanoutRunBody(", '"workflow.publish"', '"workflow.unpublish"', '"workflow.trigger"', '"workflow.delete"', "rawBody: true", 'code: "DAG_CLEANUP_FAILED"', '"SCHEDULER_ARTIFACT_MISSING"'],
      "lib/datasource/long-ops.ts": [
        "ensureExternalTable(", ".introspect(", '"datasource.s3-external"', "sampleQuery",
        // 建源主体(核角色 / 网络 / Glue 连接 / 落库 / 两段收口)+ 失败清理 + 原口径文案
        "ensureGlueRole(", "detectNetwork(", "userSpecifiedNetwork(", "createGlueConnection(", "settleAfterConfigCheck(", "pushDataSourceToOpenMetadata(",
        '"datasource.create"', "resultStatus: 201", "cleanupProvisioned(", "`创建数据源失败: ${", "Glue 作业角色未就位", 'code: "UPSTREAM_ERROR"',
      ],
      "lib/metrics/long-ops.ts": ["computeMetric(", '"metric.compute"', '"capability" in out'],
      "lib/modeling/long-ops.ts": ["computeModelMetric(", '"model-metric.compute"'],
      // 第三批:路由循环体逐字搬入 —— 逐区顺序 submit、逐 target 记账、失败三分类、三种原口径状态码、审计动作名、响应摊平
      "lib/engines/long-ops.ts": [
        "forEachTargetPlace(", ").submit(", "noteFanoutResult(", "sequential: true", 'via: "engine-job.run"',
        "RunLockBusy", "TargetBindingRejected", "ResidencyAckRequired", "AuditUnavailable",
        "new LongOpHttpError(503,", "new LongOpHttpError(409,", "new LongOpHttpError(500,", 'code: "UPSTREAM_ERROR"', 'code: "CONFLICT"',
        "`engine.${engine}.run`", "partial: true", "groupLedgerIncomplete",
      ],
    };
    for (const [file, list] of Object.entries(marks)) {
      const src = read(file);
      for (const mark of list) expect(src, `${file} 缺 ${mark}`).toContain(mark);
    }
    // 编排四种全部 rawBody(历史响应是摊平形状);其它域一处都不许用(信封口径不变)
    expect(stripComments(read("lib/workflow/long-ops.ts")).match(/rawBody: true/g)?.length).toBe(4);
    for (const file of ["lib/governance/long-ops.ts", "lib/projects/long-ops.ts", "lib/sync/long-ops.ts", "lib/realtime/long-ops.ts", "lib/datasource/long-ops.ts", "lib/metrics/long-ops.ts", "lib/modeling/long-ops.ts", "lib/ai/long-op-executors.ts"]) {
      expect(stripComments(read(file)), `${file} 不该用 rawBody`).not.toMatch(/rawBody/);
    }
  });

  it("rawBody 贯通:执行体 rawBody ⇒ 驱动器 longOpResponse 不包信封 ⇒ 行 resultRaw ⇒ GET 路由回显 ⇒ 客户端 terminalToResponse 原样", () => {
    expect(read("lib/long-ops/executor-types.ts")).toMatch(/rawBody\?: boolean/);
    const driver = stripComments(read("lib/long-ops/driver.ts"));
    expect(driver).toMatch(/if \(result\.rawBody\) return NextResponse\.json\(result\.data, \{ status: result\.resultStatus \?\? 200 \}\)/);
    expect(driver.match(/out\.rawBody/g)?.length).toBeGreaterThanOrEqual(2);
    const store = stripComments(read("lib/long-ops/store.ts"));
    expect(store).toMatch(/resultRaw\?: boolean/);
    expect(store).toMatch(/sets\.push\("resultRaw = :raw"\)/);
    expect(stripComments(read("app/api/long-ops/[taskId]/route.ts"))).toMatch(/task\.resultRaw \? \{ resultRaw: true \}/);
    expect(stripComments(read("lib/long-ops/protocol.ts"))).toMatch(/resultRaw\?: boolean/);
    expect(stripComments(read("lib/long-ops/client/follow.ts"))).toMatch(/if \(state\.resultRaw\) return jsonResponse\(state\.result, state\.resultStatus \?\? 200, state\.taskId\)/);
  });

  it("landing.ts 的两处 Redshift Data 轮询已改经 awaitTerminal(基线首批迁出),文件里不再有本地 sleep 循环", () => {
    const src = stripComments(read("lib/modeling/landing.ts"));
    expect(src.match(/awaitTerminal</g)?.length).toBe(2);
    expect(src).toMatch(/what: "观测语句"/);
    expect(src).toMatch(/what: "Redshift 语句执行"/);
    expect(src).not.toMatch(/\bsleep\(/);
    expect(src).not.toMatch(/for \(let i = 0; i < (60|80); i\+\+\)/);
  });
});

describe("接线 ⑧:客户端传输层", () => {
  it("AuthProvider 拦截器:对 /api/* 响应先 peekLongOpAccepted 再 followLongOp(orig + 同一 headers),normalizeApiResponse 仍在;壳层挂 LongOpIndicator", () => {
    const auth = stripComments(read("lib/auth/AuthProvider.tsx"));
    expect(auth).toMatch(/import \{ peekLongOpAccepted, followLongOp \} from "@\/lib\/long-ops\/client\/follow"/);
    expect(auth).toMatch(/const accepted = await peekLongOpAccepted\(res\);\s*if \(accepted\) return followLongOp\(accepted, \{ fetchImpl: orig, headers \}\);\s*return normalizeApiResponse\(res\);/);
    const shell = stripComments(read("app/layoutClient.tsx"));
    expect(shell).toMatch(/import LongOpIndicator from "@\/components\/long-ops\/LongOpIndicator"/);
    expect(shell).toMatch(/<LongOpIndicator \/>/);
    const indicator = read("components/long-ops/LongOpIndicator.tsx");
    expect(indicator).toContain('data-testid="long-op-indicator"');
    expect(indicator).toContain("LONG_OP_EVENT");
  });

  it("aiFetchJson 退成薄壳:不再轮询 /api/ai/tasks、不再有 async 分支;七个 AI 页面调用点仍经 aiFetchJson", () => {
    const src = stripComments(read("lib/ai/client/ai-fetch.ts"));
    expect(src).not.toMatch(/\/api\/ai\/tasks|\/api\/long-ops/);
    expect(src).not.toMatch(/async !== true|pollMs|budgetMs/);
    for (const file of ["components/copilot/CopilotLauncher.tsx", "components/network-advisor/NetworkAdvisorPanel.tsx", "components/param-advisor/ParamAdvisorPanel.tsx", "app/etl-jobs/page.tsx", "components/engines/EmrJobPanel.tsx", "app/requirements/page.tsx", "app/realtime-compute/page.tsx"]) {
      expect(stripComments(read(file)), file).toMatch(/aiFetchJson\(/);
    }
  });

  it("英文词典含全部 kind 标签与全局提示文案(P50-9 英文模式)", () => {
    for (const label of Object.values(LONG_OP_LABELS)) expect(EN[label], `en.ts 缺标签「${label}」`).toBeTruthy();
    expect(EN["正在后台执行:{label}(已 {n} 秒)"]).toBeTruthy();
  });
});

describe("接线 ⑨ ⑪:两侧表名 / 台账", () => {
  it("TABLES.LONG_OPS === 'bgp-long-ops' 且 infra database-stack 建同名表(pk taskId + ttl + 加固选项);仓内再无 bgp-ai-tasks / AI_TASKS 字面", () => {
    expect(TABLES.LONG_OPS).toBe("bgp-long-ops");
    expect((TABLES as Record<string, string>).AI_TASKS).toBeUndefined();
    const infra = readFileSync(resolve(REPO, "infra/lib/database-stack.ts"), "utf8");
    const block = /new dynamodb\.Table\(this, "bgp-long-ops", \{([\s\S]*?)\}\);/.exec(infra);
    expect(block, "infra 没建 bgp-long-ops").toBeTruthy();
    expect(block![1]).toContain('tableName: "bgp-long-ops"');
    expect(block![1]).toContain('partitionKey: { name: "taskId"');
    expect(block![1]).toContain("...hardened");
    expect(block![1]).toContain('timeToLiveAttribute: "ttl"');
    expect(infra).not.toMatch(/"bgp-ai-tasks"/);
    expect(stripComments(read("lib/aws/dynamodb.ts"))).not.toMatch(/AI_TASKS|bgp-ai-tasks/);
    expect(existsSync(join(SRC, "lib/ai/long-call.ts"))).toBe(false);
    expect(existsSync(join(SRC, "lib/ai/long-call-driver.ts"))).toBe(false);
  });

  it("读取级台账没有 /api/ai/tasks 条目(拦截器轮询不属于任何一页);平台栈 env 有 LONG_OPS_SYNC_WAIT_MS(缺省 45000,context long-ops-sync-wait-ms)", () => {
    expect(UNSCOPED_READS.filter((r) => r.api === "/api/ai/tasks" || r.api === "/api/long-ops")).toEqual([]);
    const coverage = read("lib/scope/__tests__/page-read-coverage.test.ts");
    expect(coverage).toMatch(/"\/api\/long-ops",/);
    const stack = readFileSync(resolve(REPO, "infra/lib/platform-stack.ts"), "utf8");
    expect(stack).toMatch(/LONG_OPS_SYNC_WAIT_MS: .*tryGetContext\("long-ops-sync-wait-ms"\)/);
    expect(stack).toMatch(/LONG_OPS_SYNC_WAIT_MS: .*"45000"/);
    expect(stack).not.toMatch(/AI_SYNC_WAIT_MS|AI_ASYNC/);
  });
});
