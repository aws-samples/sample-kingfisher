// 序 73 模块 57(R6)—— workflow 作用域的离线作业节点补数:
//   ETL ⇒ runEtlJob(job, { runDate, triggeredBy: "backfill", targetId: 工作流的区, backfill: { planId, nodeId } });EMR ⇒ provider.submit 同形;
//   返回 runTaskId = 作业 id;作业不绑工作流的区 ⇒ 如实失败(JobNodeUnbound,与发布期同一判定);补数标记字段只有一个作者 backfillRunExtra,
//   两个运行核心(etl/job-service · emr/provider)都把它铺进 run 行 extra(源码字面钉接缝)。
// 只 mock 真外部(DDB / 运行核心 / 引擎 provider / 数仓客户端)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const h = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown>>,
  etlRuns: [] as Array<{ job: Record<string, unknown>; opts: Record<string, unknown> }>,
  submits: [] as Array<{ job: Record<string, unknown>; opts: Record<string, unknown> }>,
}));
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, docClient: { send: async (cmd: { input: { TableName: string } }) => ({ Item: h.rows[cmd.input.TableName] }) } };
});
vi.mock("@/lib/exec-env/target-clients", () => ({ redshiftClientForHomeOnly: () => ({ send: async () => ({}) }) }));
vi.mock("@/lib/etl/job-service", () => ({
  runEtlJob: async (job: Record<string, unknown>, opts: Record<string, unknown>) => { h.etlRuns.push({ job, opts }); return { runId: `etl-run-${h.etlRuns.length}` }; },
}));
vi.mock("@/lib/engines/registry", () => ({
  isEngineType: () => true,
  getProvider: () => ({ submit: async (job: Record<string, unknown>, opts: Record<string, unknown>) => { h.submits.push({ job, opts }); return { runId: `emr-run-${h.submits.length}` }; } }),
}));

const { TABLES } = await import("@/lib/aws/dynamodb");
const { executeInstance } = await import("@/lib/backfill/execute");
const { backfillRunExtra } = await import("@/lib/backfill/run-extra");

const USW2 = "tgt_usw2_a";
const PROJ = "proj-01M1KP594D2E6DJQC8EZ8CRAES";
const JOB_ID = "01JOBGLUE000000000000000AB";
const EMR_ID = "01JOBEMR0000000000000000AD";
const plan = { target: { scope: "workflow", kind: "workflow", id: "wf1", name: "链" } } as never;
const inst = (over: Record<string, unknown>) => ({ planId: "01PLAN00000000000000000AAB", sk: "x", date: "2026-10-01", nodeId: "j1", nodeName: "清洗", status: "running", dependsOn: [], attempts: 1, ttl: 0, targetId: USW2, ...over }) as never;
const wfRow = (jobRef: Record<string, unknown>) => ({
  userId: "default-user", workflowId: "wf1", name: "链", description: "", projectId: PROJ, targets: [USW2],
  dagDefinition: { nodes: [{ id: "j1", type: "job", data: { label: "清洗", jobRef } }], edges: [] }, scheduleEnabled: false, status: "active", createdAt: "", updatedAt: "",
});
const SRC = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

beforeEach(() => {
  h.rows = {};
  h.etlRuns = [];
  h.submits = [];
  h.rows[TABLES.WORKFLOWS] = wfRow({ kind: "etl", jobId: JOB_ID });
  h.rows[TABLES.ETL_JOBS] = { userId: "default-user", jobId: JOB_ID, name: "每日清洗", type: "glue", script: "print('x')", targets: ["tgt_home", USW2], projectId: PROJ, env: "dev", createdBy: "u", createdBySub: "sub", status: "ready", createdAt: "", updatedAt: "" };
  h.rows[TABLES.ENGINE_JOBS] = { userId: "default-user", jobId: EMR_ID, engine: "emr-serverless", name: "spark-roi", projectId: PROJ, env: "dev", script: "x", status: "ready", createdBy: "u", createdBySub: "sub", createdAt: "", updatedAt: "", spec: {}, network: { subnetIds: [], securityGroupIds: [] }, targets: [USW2] };
});

describe("离线作业节点补数(workflow 作用域)", () => {
  it("ETL 作业 ⇒ runEtlJob(实例日期 · backfill · 工作流的区 · 计划 / 节点引用),runTaskId = 作业 id", async () => {
    const r = await executeInstance(plan, inst({}));
    expect(h.etlRuns.length).toBe(1);
    expect(h.etlRuns[0].job.jobId).toBe(JOB_ID);
    expect(h.etlRuns[0].opts).toEqual({ runDate: "2026-10-01", triggeredBy: "backfill", targetId: USW2, backfill: { planId: "01PLAN00000000000000000AAB", nodeId: "j1" } });
    expect(r).toEqual({ runTaskId: JOB_ID, runId: "etl-run-1" });
  });
  it("EMR 作业 ⇒ provider.submit 同形;小时粒度取日", async () => {
    h.rows[TABLES.WORKFLOWS] = wfRow({ kind: "emr", jobId: EMR_ID });
    const r = await executeInstance(plan, inst({ date: "2026-10-02T03" }));
    expect(h.submits.length).toBe(1);
    expect(h.submits[0].job.jobId).toBe(EMR_ID);
    expect(h.submits[0].opts).toEqual({ runDate: "2026-10-02", triggeredBy: "backfill", targetId: USW2, backfill: { planId: "01PLAN00000000000000000AAB", nodeId: "j1" } });
    expect(r).toEqual({ runTaskId: EMR_ID, runId: "emr-run-1" });
    expect(h.etlRuns).toEqual([]);
  });
  it("🔴 作业不绑工作流的区 ⇒ 如实失败(JobNodeUnbound not-bound),不替它挑区、不提交", async () => {
    h.rows[TABLES.ETL_JOBS] = { ...(h.rows[TABLES.ETL_JOBS] as Record<string, unknown>), targets: ["tgt_home"] };
    await expect(executeInstance(plan, inst({}))).rejects.toMatchObject({ code: "JOB_NODE_UNBOUND", reason: "not-bound" });
    expect(h.etlRuns).toEqual([]);
  });
  it("存量实例没有 targetId ⇒ 回落工作流绑定的第一个区(与 sql 节点同口径)", async () => {
    await executeInstance(plan, inst({ targetId: undefined }));
    expect(h.etlRuns[0].opts.targetId).toBe(USW2);
  });
  it("未关联 ⇒ 如实失败(missing-ref)", async () => {
    h.rows[TABLES.WORKFLOWS] = wfRow({});
    await expect(executeInstance(plan, inst({}))).rejects.toMatchObject({ code: "JOB_NODE_UNBOUND", reason: "missing-ref" });
  });
});

describe("补数标记字段只有一个作者,两个运行核心都铺进 run 行", () => {
  it("backfillRunExtra:有引用才加键;没有 ⇒ 空对象(手动 / 定时 run 行同形)", () => {
    expect(backfillRunExtra({ planId: "p", nodeId: "n" })).toEqual({ backfillPlanId: "p", backfillNode: "n" });
    expect(backfillRunExtra({ planId: "p" })).toEqual({ backfillPlanId: "p" });
    expect(backfillRunExtra(undefined)).toEqual({});
    expect(backfillRunExtra({ planId: "" })).toEqual({});
  });
  it("etl/job-service 两条 createRunRecord · emr/provider 一条 createRunRecord 都铺 backfillRunExtra(opts.backfill)", () => {
    const js = read("lib/etl/job-service.ts");
    expect(js.match(/\.\.\.backfillRunExtra\(opts\.backfill\)/g)?.length).toBe(2);
    expect(js).toMatch(/backfill\?: BackfillRunRef;/);
    const pv = read("lib/engines/emr/provider.ts");
    expect(pv.match(/\.\.\.backfillRunExtra\(opts\.backfill\)/g)?.length).toBe(1);
    expect(read("lib/engines/spi.ts")).toMatch(/backfill\?: import\("@\/lib\/backfill\/run-extra"\)\.BackfillRunRef;/);
    // 工作流 SQL 节点补数也走同一个作者(不再内联两个键)
    const ex = read("lib/backfill/execute.ts");
    expect(ex).toContain("...backfillRunExtra({ planId: inst.planId, nodeId: inst.nodeId })");
    expect(ex).not.toMatch(/backfillPlanId: inst\.planId, backfillNode: inst\.nodeId/);
  });
});
