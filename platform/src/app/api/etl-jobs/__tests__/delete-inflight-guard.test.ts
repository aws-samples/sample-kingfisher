// 2026-11-04 —— 两条 DELETE 路由(离线计算 / EMR 引擎作业)删前核在途运行:run 行未终态 / 作业行运行锁刚续租 ⇒ 409 JOB_RUN_IN_PROGRESS,
//   作业行 / Glue 作业定义 / application 一个都不动;全终态 ⇒ 原 200 路径逐字不变。
// 【缺陷原形(2026-11-03 p72 首跑)】「立即运行」提交后 20 秒内页面「删除」⇒ 200 删成、Glue 作业定义随删 ⇒ run 行永远「运行中」(任务监控孤儿)。
// 🔴 只 mock 真外部(DDB / S3 / 调度器服务 / 落点解析 / 引擎 provider 的 AWS 动作 / 项目守卫);job-inflight ↔ run-records ↔ run-groups ↔ run-lock ↔ 路由真跑。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const h = vi.hoisted(() => ({
  ddb: [] as Array<{ ctor: string; input: Record<string, any> }>,
  job: {} as Record<string, unknown>,
  runs: [] as Record<string, unknown>[],
  destroyed: 0,
  glueDeleted: 0,
  /** 模拟「核完到删之间刚好有一次运行抢到锁」:DeleteCommand 的条件写被拒,随后重读到的作业行带上那把刚抢到的锁 */
  deleteRaces: false,
  /** DeleteCommand 已被拒过一次(之后重读的作业行才带那把刚抢到的锁;首次 GET 必须是干净行,否则删前核就 409、根本走不到条件删) */
  deleteRejected: false,
  /** 模拟 EMR 说 application 还有作业在跑(destroyResource 抛 EmrApplicationBusy) */
  appBusy: false,
}));

vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand { constructor(public input: any) {} }
  class DeleteObjectCommand { constructor(public input: any) {} }
  class S3Client { async send() { return {}; } }
  return { S3Client, PutObjectCommand, DeleteObjectCommand };
});
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { ETL_JOBS: "bgp-etl-jobs", ENGINE_JOBS: "bgp-engine-jobs", LONG_OPS: "bgp-long-ops", TASK_RUNS: "bgp-task-runs", WORKFLOWS: "bgp-workflows" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      h.ddb.push({ ctor: cmd.constructor.name, input: cmd.input });
      const t = cmd.input?.TableName;
      if (t === "bgp-long-ops") return {}; // 没有长操作租约
      if (cmd.constructor.name === "QueryCommand" && t === "bgp-task-runs") return { Items: h.runs };
      if (cmd.constructor.name === "ScanCommand") return { Items: [] }; // 没有工作流引用
      if (cmd.constructor.name === "DeleteCommand" && h.deleteRaces) {
        h.deleteRejected = true;
        const e = new Error("The conditional request failed"); e.name = "ConditionalCheckFailedException"; throw e;
      }
      if (cmd.constructor.name === "GetCommand") {
        return { Item: h.deleteRaces && h.deleteRejected ? { ...h.job, runLockToken: "tok-race", runLockExpiresAt: Date.now() + RUN_LOCK_LEASE_MS } : h.job };
      }
      return {};
    }),
  },
}));
vi.mock("@/lib/projects/guard", () => ({
  guardResourceAccess: vi.fn(async () => ({ identity: { username: "admin" }, projectId: "p1" })),
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/versions/version-service", () => ({ snapshotVersion: vi.fn(async () => {}) }));
vi.mock("@/lib/openmetadata/om-push", () => ({ pushSqlLineageToOpenMetadata: vi.fn(async () => {}) }));
vi.mock("@/lib/governance/lineage-service", () => ({ recordComputeLineage: vi.fn(async () => {}) }));
vi.mock("@/lib/etl/job-service", () => ({ deleteGlueJobs: vi.fn(async () => { h.glueDeleted++; return []; }) }));
vi.mock("@/lib/engines/registry", async () => {
  const { EmrApplicationBusy } = await import("@/lib/engines/emr/application");
  return {
    isEngineType: (v: unknown) => v === "emr-serverless",
    getProvider: () => ({ destroyResource: vi.fn(async () => { if (h.appBusy) throw new EmrApplicationBusy("app-b142", "STARTED"); h.destroyed++; }) }),
  };
});
vi.mock("@/lib/scheduler/mwaa-offline", () => ({
  offlineDag: vi.fn(async (dagId: string, targetId: string) => ({ dagId, targetId, paused: true, dagFileDeleted: true })),
}));
vi.mock("@/lib/scheduler/serverless/publish", () => ({
  publishServerlessWorkflow: vi.fn(),
  offlineServerlessWorkflow: vi.fn(async ({ dagId }: { dagId: string }) => ({ deleted: true, dagFileDeleted: true, stoppedRuns: 0, dagId })),
}));
vi.mock("@/lib/scheduler/mwaa-endpoint", () => ({
  serverlessEndpointFor: vi.fn(async (t: string) => ({ targetId: t, region: "us-west-2", kind: "serverless", workflowBucket: "b" })),
  schedulerEndpointFor: vi.fn(async (t: string) => ({ targetId: t, region: "us-west-2", kind: "serverless", workflowBucket: "b" })),
  isServerlessEndpoint: vi.fn(() => true),
  MwaaNotInstalled: class extends Error {},
  mwaaErrorResponse: vi.fn(),
  mwaaDagBucketOfHome: vi.fn(() => "home-bucket"),
  unpauseWhenLoaded: vi.fn(async () => {}),
}));
vi.mock("@/lib/exec-env/data-plane-target", () => ({
  bindingTargets: (j: { targets?: string[] }) => j.targets ?? [],
  resolveRedshiftBinding: vi.fn(async () => ({ home: true, workgroup: "wg", database: "db", secretArn: "arn:s" })),
  assertBindableTargetsForEngine: vi.fn(async (_engine: string, targets: string[]) => targets),
  assertBindableTargets: vi.fn(async (targets: string[]) => targets),
  TargetBindingRejected: class extends Error {},
}));
vi.mock("@/lib/exec-env/target-region", () => ({ regionOfTarget: vi.fn(async () => "us-west-2") }));
vi.mock("@/lib/exec-env/target-clients", () => ({ s3ClientFor: vi.fn(async () => ({ send: async () => ({}) })) }));

const { RUN_LOCK_LEASE_MS, RUN_LOCK_LIVE_WINDOW_MS } = await import("@/lib/etl/run-lock");
const { isConditionalCheckFailed } = await import("@/lib/aws/ddb-errors");
void isConditionalCheckFailed;

// 🔴 夹具 id 末 12 位必含字母
const JOB_ID = "01JOBB142DELETEXXXXXXXXAB";
const RUN_ID = "01RUNB142RUNNINGXXXXXXXAB";
const STARTED = "2026-11-04T08:00:00.000Z";
const glueJob = (extra: Record<string, unknown> = {}) => ({ userId: "default-user", jobId: JOB_ID, name: "b142-glue", type: "glue", projectId: "p1", targets: ["tgt_home"], ...extra });
const emrJob = (extra: Record<string, unknown> = {}) => ({ userId: "default-user", jobId: JOB_ID, name: "b142-emr", engine: "emr-serverless", projectId: "p1", targets: ["tgt_home"], ...extra });
const runningRun = { taskId: JOB_ID, runId: RUN_ID, status: "running", startedAt: STARTED, targetId: "tgt_home", taskType: "etl-glue", glueJobRunId: "jr_b142" };
const terminalRuns = [
  { taskId: JOB_ID, runId: "01RUNB142OKXXXXXXXXXXXXAB", status: "succeeded", startedAt: STARTED, targetId: "tgt_home" },
  { taskId: JOB_ID, runId: "01RUNB142FAILXXXXXXXXXXAB", status: "failed", startedAt: STARTED, targetId: "tgt_home" },
  { taskId: JOB_ID, runId: "01RUNB142STOPXXXXXXXXXXAB", status: "stopped", startedAt: STARTED, targetId: "tgt_home" },
];
const deletes = () => h.ddb.filter((x) => x.ctor === "DeleteCommand");
const workflowScans = () => h.ddb.filter((x) => x.ctor === "ScanCommand" && x.input.TableName === "bgp-workflows");
const body = async (r: Response) => (await r.json()) as { success: boolean; error: { code: string; message: string; detail: { runs: unknown[]; locks: unknown[] } } };
const etlDelete = async () => {
  const { DELETE } = await import("../[id]/route");
  return DELETE(new Request(`http://x/api/etl-jobs/${JOB_ID}`, { method: "DELETE" }) as never, { params: Promise.resolve({ id: JOB_ID }) });
};
const emrDelete = async () => {
  const { DELETE } = await import("../../engines/[engine]/[id]/route");
  return DELETE(new Request(`http://x/api/engines/emr-serverless/${JOB_ID}`, { method: "DELETE" }) as never, { params: Promise.resolve({ engine: "emr-serverless", id: JOB_ID }) });
};

beforeEach(() => { h.ddb.length = 0; h.runs = []; h.destroyed = 0; h.glueDeleted = 0; h.deleteRaces = false; h.deleteRejected = false; h.appBusy = false; vi.resetModules(); });
/** 条件删行的输入形状(S1):主键 + 每把锁「不存在或没人刚续租」;只断事实,不钉属性顺序 */
const expectGuardedDelete = (input: Record<string, any>, table: string) => {
  expect(input.TableName).toBe(table);
  expect(input.Key).toEqual({ userId: "default-user", jobId: JOB_ID });
  expect(input.ConditionExpression).toContain("(attribute_not_exists(#lk0) OR #le0 < :liveCutoff)");
  expect(input.ExpressionAttributeNames["#lk0"]).toBe("runLockToken");
  expect(typeof input.ExpressionAttributeValues[":liveCutoff"]).toBe("number");
};

describe("🔴 ETL 删作业(DELETE /api/etl-jobs/[id])", () => {
  it("有 running 的 run 行 ⇒ 409 JOB_RUN_IN_PROGRESS 原话点名 runId;不删行、不删 Glue 定义、连工作流引用都不去扫(在途核排在最前)", async () => {
    h.job = glueJob(); h.runs = [runningRun, ...terminalRuns];
    const res = await etlDelete();
    expect(res.status).toBe(409);
    const b = await body(res);
    expect(b.success).toBe(false);
    expect(b.error.code).toBe("JOB_RUN_IN_PROGRESS");
    expect(b.error.message).toBe(
      `这个作业仍有 1 条运行未结束:「${RUN_ID}」(运行中 · tgt_home · ${STARTED} 开始) —— 已拒绝删除。` +
        "请等待这些运行结束后再删除;现在删掉会让它们的运行记录永远停在「运行中」,也无法再被跟踪。"
    );
    expect(b.error.detail.runs).toEqual([{ runId: RUN_ID, status: "running", startedAt: STARTED, targetId: "tgt_home" }]);
    expect(b.error.detail.locks).toEqual([]);
    expect(deletes(), "409 却删了行").toHaveLength(0);
    expect(h.glueDeleted, "409 却删了 Glue 作业定义").toBe(0);
    expect(workflowScans(), "在途核应排在工作流引用核之前").toHaveLength(0);
    // 读 run 行走的是按 taskId 的 Query(不是全表 Scan)
    const q = h.ddb.find((x) => x.ctor === "QueryCommand" && x.input.TableName === "bgp-task-runs");
    expect(q?.input.ExpressionAttributeValues).toEqual({ ":t": JOB_ID });
  });

  it("作业行上刚续租的运行锁(TS 提交窗,run 行还没写出来)⇒ 409 用户语言一句话(S7),锁细节只在 detail;一样不删", async () => {
    const now = Date.now();
    h.job = glueJob({ runLockToken: "tok", runLockExpiresAt: now + RUN_LOCK_LEASE_MS - 3_000 }); h.runs = [];
    const res = await etlDelete();
    expect(res.status).toBe(409);
    const b = await body(res);
    expect(b.error.code).toBe("JOB_RUN_IN_PROGRESS");
    expect(b.error.message).toBe("这个作业正在提交一次运行 —— 已拒绝删除。请稍候几秒后重试。");
    expect(b.error.detail.runs).toEqual([]);
    expect((b.error.detail.locks[0] as { targetId: string }).targetId).toBe("tgt_home");
    expect(deletes()).toHaveLength(0);
    expect(h.glueDeleted).toBe(0);
  });

  it("全部 run 已终态(succeeded / failed / stopped)、没人续租的旧锁 ⇒ 200:条件删行(S1)在前、删 Glue 定义在后;响应逐字不变", async () => {
    // 轮询耗尽后保持持锁(P0-6)但两个续租间隔内没人续 ⇒ 不是在途,不该挡删除
    h.job = glueJob({ runLockToken: "stale", runLockExpiresAt: Date.now() + RUN_LOCK_LEASE_MS - RUN_LOCK_LIVE_WINDOW_MS - 1 });
    h.runs = terminalRuns;
    const res = await etlDelete();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { deleted: true, glueJobsDeleted: [] } });
    expect(deletes()).toHaveLength(1);
    expectGuardedDelete(deletes()[0].input, "bgp-etl-jobs");
    expect(h.glueDeleted).toBe(1);
    expect(workflowScans(), "放行后照常核工作流引用").toHaveLength(1);
  });

  it("S1 窄窗:删前核过关、删行的条件写却被拒(刚好有一次运行抢到锁)⇒ 什么都没删、Glue 定义也没删 ⇒ 重读作业行按在途 409", async () => {
    h.job = glueJob(); h.runs = terminalRuns; h.deleteRaces = true;
    const res = await etlDelete();
    expect(res.status).toBe(409);
    const b = await body(res);
    expect(b.error.code).toBe("JOB_RUN_IN_PROGRESS");
    expect(b.error.message).toBe("这个作业正在提交一次运行 —— 已拒绝删除。请稍候几秒后重试。");
    expect((b.error.detail.locks[0] as { targetId: string }).targetId).toBe("tgt_home");
    expect(h.glueDeleted, "条件写被拒后不许再去删 Glue 定义").toBe(0);
    expect(deletes()).toHaveLength(1); // 发了一次条件删,被拒
  });
});

describe("🔴 EMR 引擎作业删除(DELETE /api/engines/emr-serverless/[id])", () => {
  it("有 running 的 run 行 ⇒ 409 JOB_RUN_IN_PROGRESS(多一句指路运行历史「停止」);不删行、不销毁 application", async () => {
    h.job = emrJob(); h.runs = [{ ...runningRun, taskType: "emr-serverless", nativeRunId: "jr-b142", applicationId: "app-b142" }];
    const res = await emrDelete();
    expect(res.status).toBe(409);
    const b = await body(res);
    expect(b.error.code).toBe("JOB_RUN_IN_PROGRESS");
    expect(b.error.message).toBe(
      `这个作业仍有 1 条运行未结束:「${RUN_ID}」(运行中 · tgt_home · ${STARTED} 开始) —— 已拒绝删除。` +
        "请等待这些运行结束后再删除(或先在运行历史里「停止」它们);现在删掉会让它们的运行记录永远停在「运行中」,也无法再被跟踪。"
    );
    expect(b.error.detail.runs).toEqual([{ runId: RUN_ID, status: "running", startedAt: STARTED, targetId: "tgt_home" }]);
    expect(deletes()).toHaveLength(0);
    expect(h.destroyed, "409 却销毁了 application").toBe(0);
  });

  it("全部 run 已终态 ⇒ 200,原路径不变:核长操作租约 → 核工作流引用 → 销毁 application → 条件删行(S1)", async () => {
    h.job = emrJob(); h.runs = terminalRuns;
    const res = await emrDelete();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { deleted: true } });
    expect(h.destroyed).toBe(1);
    expect(deletes()).toHaveLength(1);
    expectGuardedDelete(deletes()[0].input, "bgp-engine-jobs");
    expect(h.ddb.some((x) => x.input?.TableName === "bgp-long-ops"), "放行后照常核 engine-job 租约").toBe(true);
  });

  it("S1:EMR 说 application 仍有作业在跑(EmrApplicationBusy)⇒ 409 JOB_RUN_IN_PROGRESS 原话指路,作业行不删(原来吞掉当删成功)", async () => {
    h.job = emrJob(); h.runs = terminalRuns; h.appBusy = true;
    const res = await emrDelete();
    expect(res.status).toBe(409);
    const b = await body(res);
    expect(b.error.code).toBe("JOB_RUN_IN_PROGRESS");
    expect(b.error.message).toBe(
      "EMR application app-b142 仍在运行(STARTED),还有作业运行在跑,EMR 拒绝停止 / 删除 —— 已拒绝删除作业。" +
        "请等这些运行结束(或先在运行历史 / EMR Serverless 控制台停止它们)后再删除。"
    );
    expect(b.error.detail).toEqual({ applicationId: "app-b142", state: "STARTED" });
    expect(deletes()).toHaveLength(0);
  });

  it("S1 窄窗(EMR):条件删行被拒 ⇒ 409,不吞", async () => {
    h.job = emrJob(); h.runs = terminalRuns; h.deleteRaces = true;
    const res = await emrDelete();
    expect(res.status).toBe(409);
    expect((await body(res)).error.message).toBe("这个作业正在提交一次运行 —— 已拒绝删除。请稍候几秒后重试。");
  });
});

describe("接缝:两条 DELETE 路由的核序;词表闭合;页面把 409 原话给用户看", () => {
  const SRC = resolve(__dirname, "../../../..");
  const read = (p: string) => readFileSync(resolve(SRC, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

  it.each([
    ["app/api/etl-jobs/[id]/route.ts", "etl"],
    ["app/api/engines/[engine]/[id]/route.ts", "engine"],
  ])("%s:guard 之后先 jobInflight(params.id, Item) ⇒ jobRunInProgressResponse(…, %s),排在长操作租约核 / 工作流引用核 / 撤调度 / DeleteCommand 之前", (f, kind) => {
    const src = read(f);
    const del = src.slice(src.indexOf("export async function DELETE("));
    const iGuard = del.indexOf('guardResourceAccess(req, Item, "editor")');
    const iInflight = del.indexOf("const inflight = await jobInflight(params.id, Item as Record<string, unknown>);");
    const iResp = del.indexOf(`if (hasInflight(inflight)) return jobRunInProgressResponse(inflight, "${kind}");`);
    const iRefs = del.indexOf("const jobRefs = await workflowsReferencingJob(");
    const iDelete = del.indexOf("new DeleteCommand(");
    expect(iGuard).toBeGreaterThan(-1);
    expect(iInflight, "DELETE 没核在途运行").toBeGreaterThan(iGuard);
    expect(iResp).toBeGreaterThan(iInflight);
    expect(iRefs).toBeGreaterThan(iResp);
    expect(del.indexOf("offline")).toBeGreaterThan(iResp);
    expect(iDelete).toBeGreaterThan(iResp);
    if (kind === "engine") expect(del.indexOf("resourceBusyResponse(")).toBeGreaterThan(iResp);
    // S1:删行是条件写(唯一作者 jobRowDeleteInput),被拒按在途 409;ETL 侧先删行再删 Glue 定义
    expect(del).toContain(`new DeleteCommand(jobRowDeleteInput(TABLES.${kind === "etl" ? "ETL_JOBS" : "ENGINE_JOBS"}, params.id, Item as Record<string, unknown>))`);
    expect(del).toContain("if (!isConditionalCheckFailed(e)) throw e;");
    if (kind === "etl") expect(del.indexOf("deleteGlueJobs(del)")).toBeGreaterThan(iDelete);
    if (kind === "engine") expect(del).toContain("if (isEmrApplicationBusy(e))");
  });

  it("ApiErrorCode 闭合清单含 JOB_RUN_IN_PROGRESS;离线计算页与 EmrJobPanel 的删除都经 deleteJson 并把服务端原话 message.error 出来", () => {
    expect(read("lib/api-response.ts")).toMatch(/\|\s*"JOB_RUN_IN_PROGRESS"/);
    const page = read("app/etl-jobs/page.tsx");
    expect(page).toContain('import { deleteJson } from "@/lib/http/delete-json";');
    expect(page).toMatch(/await deleteJson\(`\/api\/etl-jobs\/\$\{id\}`\)/);
    expect(page).toMatch(/message\.error\(\(e as Error\)\.message/);
    const panel = read("components/engines/EmrJobPanel.tsx");
    expect(panel).toMatch(/await deleteJson\(`\/api\/engines\/\$\{ENGINE\}\/\$\{job\.jobId\}`\)/);
    expect(panel).toMatch(/message\.error\(\(e as Error\)\.message/);
  });
});
