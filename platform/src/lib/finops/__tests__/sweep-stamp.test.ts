// @kf-batch 50-W3f-T0-T3
// 门票 T1:成本行继承 run 的归属章 + 存量成本行回填。
//
// 🔴 只打桩到 AWS SDK 边界(DDB / Glue / EMR)与 finops store;sweep / backfill 本体用真的。
//    第一批的教训:mock 掉被测函数的下一层,测的就是 mock。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  runs: [] as Array<Record<string, unknown>>,
  runRows: {} as Record<string, Record<string, unknown> | undefined>,
  costRows: [] as Array<Record<string, any>>,
  put: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, any>>,
  watermark: null as string | null,
}));

class ConditionalCheckFailedException extends Error {
  name = "ConditionalCheckFailedException";
}

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { TASK_RUNS: "bgp-task-runs" },
  docClient: {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
      const kind = cmd.constructor.name;
      if (kind === "ScanCommand") return { Items: h.runs };
      if (kind === "GetCommand") return { Item: h.runRows[`${cmd.input.Key.taskId}#${cmd.input.Key.runId}`] };
      if (kind === "UpdateCommand") {
        const row = h.costRows.find((r) => `taskcost#${r.taskId}` === cmd.input.Key.pk && r.sk === cmd.input.Key.sk);
        if (!row || row.targetId !== undefined) throw new ConditionalCheckFailedException("cond");
        h.updates.push(cmd.input);
        row.projectId = cmd.input.ExpressionAttributeValues[":p"];
        row.targetId = cmd.input.ExpressionAttributeValues[":t"];
        return {};
      }
      throw new Error(`unexpected ${kind}`);
    }),
  },
}));

// 🔴 客户端**按 region 从工厂取**(W3f-8 真环境抓到的缺陷:原来是模块级 home 客户端 ⇒ 非 home 的 run 计量取不到,
//    被 catch 吞成 skipped ⇒ 别的区成本永远归不上而扫描器一切正常)。这里记下每次要的 region,好断「usw2 的 run 用的是 us-west-2 的客户端」。
const clientLog = vi.hoisted(() => ({ glue: [] as string[], emr: [] as string[] }));
vi.mock("@/lib/exec-env/target-clients", () => ({
  glueClientFor: vi.fn(async (region: string) => {
    clientLog.glue.push(region);
    return { async send() { return { JobRun: { DPUSeconds: 100 } }; } };
  }),
  emrServerlessClientFor: vi.fn(async (region: string) => {
    clientLog.emr.push(region);
    return { async send() { return { jobRun: { billedResourceUtilization: { vCPUHour: 1, memoryGBHour: 2, storageGBHour: 0 } } }; } };
  }),
}));
vi.mock("@/lib/exec-env/target-region", () => ({
  regionOfTarget: vi.fn(async (targetId: string) => {
    if (targetId === "tgt_home") return "us-east-1";
    if (targetId === "tgt_usw2_a") return "us-west-2";
    throw new Error(`执行目标 ${targetId} 不存在或没有 region 属性`);
  }),
}));

vi.mock("@/lib/finops/store", () => ({
  getWatermark: vi.fn(async () => h.watermark),
  setWatermark: vi.fn(async (_sk: string, v: string) => {
    h.watermark = v;
  }),
  putCostRunIfNew: vi.fn(async (row: Record<string, unknown>) => {
    h.put.push(row);
    return true;
  }),
  scanAllCostRuns: vi.fn(async () => h.costRows),
  costRunPk: (taskId: string) => `taskcost#${taskId}`,
}));

const { sweepTaskCosts } = await import("@/lib/finops/sweep");
const { backfillCostRunStamps } = await import("@/lib/finops/stamp-backfill");

const glueRun = (over: Record<string, unknown> = {}) => ({
  taskId: "J1",
  runId: "R1",
  taskType: "etl-glue",
  status: "succeeded",
  startedAt: "2026-09-05T00:00:00.000Z",
  finishedAt: "2026-09-05T00:10:00.000Z",
  glueJobName: "g",
  glueJobRunId: "jr",
  projectId: "proj-x",
  targetId: "tgt_usw2_a",
  ...over,
});

beforeEach(() => {
  h.runs = [];
  h.runRows = {};
  h.costRows = [];
  h.put.length = 0;
  h.updates.length = 0;
  h.watermark = null;
  clientLog.glue.length = 0;
  clientLog.emr.length = 0;
});

describe("🔴🔴 W3f-8:计量客户端按 run 的 target 所在 region 取(模块级 home 客户端是这类缺陷的唯一来源)", () => {
  it("usw2 的 Glue run ⇒ 用 us-west-2 的客户端;home 的 ⇒ us-east-1(变异:换回 AWS_REGION ⇒ 本条必红)", async () => {
    h.runs = [glueRun(), glueRun({ runId: "R2", targetId: "tgt_home" })];
    const r = await sweepTaskCosts({ backfill: true });
    expect(r.attributed).toBe(2);
    expect(clientLog.glue.sort()).toEqual(["us-east-1", "us-west-2"]);
    expect(h.put.map((x) => x.targetId).sort()).toEqual(["tgt_home", "tgt_usw2_a"]);
  });

  it("EMR 同理:非 home 的 run 用该区的 EMR 客户端", async () => {
    h.runs = [glueRun({ taskType: "emr-serverless", glueJobName: undefined, glueJobRunId: undefined, applicationId: "app", nativeRunId: "n1" })];
    await sweepTaskCosts({ backfill: true });
    expect(clientLog.emr).toEqual(["us-west-2"]);
  });

  it("🔴 target 解析不到 ⇒ 计入 `errors`(不是 skipped、不猜 home、不写行)—— 错不许再藏进 skipped", async () => {
    h.runs = [glueRun({ targetId: "tgt_gone_zz" })];
    const r = await sweepTaskCosts({ backfill: true });
    expect(r).toMatchObject({ attributed: 0, errors: 1, skipped: 0, unstamped: 0 });
    expect(h.put).toEqual([]);
    expect(clientLog.glue).toEqual([]);
  });

  it("本就不计量的 run(dms / workflow)仍是 skipped,不算 errors", async () => {
    h.runs = [glueRun({ glueJobName: undefined, glueJobRunId: undefined, taskType: "sync", channel: "dms" })];
    const r = await sweepTaskCosts({ backfill: true });
    expect(r).toMatchObject({ attributed: 0, errors: 0, skipped: 1 });
  });

  it("接线门禁:sweep.ts 里不许再有模块级 Glue / EMR 客户端,且必须经 regionOfTarget + 工厂取客户端", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../sweep.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1 ");
    for (const bad of ["new GlueClient(", "new EMRServerlessClient(", "process.env.AWS_REGION"]) {
      expect(src, `sweep.ts 又出现了 ${bad} ⇒ 非 home 的 run 计量会静默取不到`).not.toContain(bad);
    }
    for (const must of ["regionOfTarget(run.targetId)", "glueClientFor(region)", "emrServerlessClientFor(region)"]) {
      expect(src).toContain(must);
    }
  });
});

describe("🔴 T1 sweep:成本行带 run 的章", () => {
  it("有章的 run ⇒ 成本行 {projectId,targetId} 与 run 行**逐字相同**", async () => {
    h.runs = [glueRun()];
    const r = await sweepTaskCosts({ backfill: true });
    expect(r.attributed).toBe(1);
    expect(r.unstamped).toBe(0);
    expect(h.put[0]).toMatchObject({ taskId: "J1", runId: "R1", projectId: "proj-x", targetId: "tgt_usw2_a", engine: "glue" });
  });

  it("🔴 无章的 run ⇒ **不归因、不猜 home**,计入 unstamped(变异:把 continue 删掉 ⇒ 本条必红)", async () => {
    h.runs = [glueRun({ targetId: undefined }), glueRun({ runId: "R2", projectId: undefined })];
    const r = await sweepTaskCosts({ backfill: true });
    expect(h.put, "无章 run 写出了成本行 ⇒ 要么猜了 home、要么写了个残行").toEqual([]);
    expect(r.unstamped).toBe(2);
    expect(r.attributed).toBe(0);
    expect(JSON.stringify(h.put)).not.toContain("tgt_home");
  });

  it("EMR 路径同样带章(两条引擎路径共用同一段写入)", async () => {
    h.runs = [glueRun({ taskType: "emr-serverless", glueJobName: undefined, glueJobRunId: undefined, applicationId: "app", nativeRunId: "n1" })];
    await sweepTaskCosts({ backfill: true });
    expect(h.put[0]).toMatchObject({ engine: "emr-serverless", projectId: "proj-x", targetId: "tgt_usw2_a" });
  });
});

describe("🔴 T1 backfill:存量成本行从 run 行补章(只补空缺、不猜 home)", () => {
  it("缺章的成本行 ⇒ 回查 run 行、条件写补上;已有章的不碰", async () => {
    h.costRows = [
      { taskId: "J1", runId: "R1", sk: "R1" },
      { taskId: "J1", runId: "R2", sk: "R2", projectId: "proj-y", targetId: "tgt_home" },
    ];
    h.runRows["J1#R1"] = { taskId: "J1", runId: "R1", projectId: "proj-x", targetId: "tgt_usw2_a" };
    const r = await backfillCostRunStamps();
    expect(r).toMatchObject({ scanned: 2, backfilled: 1, alreadyStamped: 1, unresolved: [] });
    expect(h.updates.length).toBe(1);
    const u = h.updates[0];
    expect(u.Key).toEqual({ pk: "taskcost#J1", sk: "R1" });
    expect(u.ConditionExpression).toContain("attribute_not_exists(targetId)");
    expect(u.ExpressionAttributeValues).toEqual({ ":p": "proj-x", ":t": "tgt_usw2_a" });
    expect(h.costRows[0]).toMatchObject({ projectId: "proj-x", targetId: "tgt_usw2_a" });
  });

  it("🔴 run 行不存在 / run 行无章 ⇒ 登记 unresolved,**零写入**(变异:回落 home ⇒ 本条必红)", async () => {
    h.costRows = [
      { taskId: "J1", runId: "GONE", sk: "GONE" },
      { taskId: "J1", runId: "R3", sk: "R3" },
    ];
    h.runRows["J1#R3"] = { taskId: "J1", runId: "R3" }; // 存量无章 run
    const r = await backfillCostRunStamps();
    expect(r.backfilled).toBe(0);
    expect(r.unresolved.map((u) => u.reason).sort()).toEqual(["run 行不存在", "run 行无章"]);
    expect(h.updates).toEqual([]);
  });

  it("并发第二次回填撞条件 ⇒ 记 alreadyStamped,不抛", async () => {
    h.costRows = [{ taskId: "J1", runId: "R1", sk: "R1" }];
    h.runRows["J1#R1"] = { taskId: "J1", runId: "R1", projectId: "proj-x", targetId: "tgt_usw2_a" };
    await backfillCostRunStamps();
    // 第二轮:scanAllCostRuns 仍回同一数组(mock),但行上已有章 ⇒ 走 alreadyStamped 分支
    const r2 = await backfillCostRunStamps();
    expect(r2).toMatchObject({ backfilled: 0, alreadyStamped: 1 });
  });
});
