// @kf-batch 50-CAPSEED-seed-dispatch
// 登记 CAP-SEED(「在该区下发一次造数」)的**装配层**判据。
// 只 mock 真外部:DynamoDB(文档客户端 —— 命令表 / run 台账 / 审计都落它)· 执行环境注册表(DDB 边界)· Glue SDK(网络)。
// seed-job / run-once / seed-http / action-commands / action-dispatch / action-handlers / run-records / audit /
// data-plane-target / aws/clients 全部跑真代码(接缝不许被 mock 抹平)。
//
// 🔴 要钉住的:
//   ① 在**点名的那个区**跑**那个区**的造数作业(作业名 / 客户端区 / --datalake 都来自该区落点),绝不回落主控区;
//   ② 手动:立刻返回 + 台账一行(taskType=seed、触发=手动、章=该区)+ 后台收口到终态;
//   ③ 定时(消费端整条链):等到终态;成功 ⇒ 命令 succeeded + 摘要带 jobRunId,且**不**另写台账(DAG 收口);
//      Glue 失败 ⇒ 命令 failed + 真因;
//   ④ fail-closed:作业不存在 / 已有一轮在跑 / 参数为空 / 区不可承接 ⇒ 一个 StartJobRun 都不发、台账零行。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  glueCalls: [] as Array<{ region: string; op: string; input: any }>,
  jobs: new Set<string>(),
  runStates: [] as string[],
  startError: null as null | string,
  ddb: [] as Array<{ op: string; input: any }>,
  commands: new Map<string, Record<string, any>>(),
  targets: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@aws-sdk/client-glue", () => {
  class Cmd { constructor(public input: any) {} }
  class GetJobCommand extends Cmd {}
  class StartJobRunCommand extends Cmd {}
  class GetJobRunCommand extends Cmd {}
  class GlueClient {
    region: string;
    middlewareStack = { add: () => {} };
    constructor(cfg: { region: string }) { this.region = cfg.region; }
    async send(c: Cmd) {
      const op = c.constructor.name.replace(/Command$/, "");
      h.glueCalls.push({ region: this.region, op, input: c.input });
      if (op === "GetJob") {
        if (!h.jobs.has(`${this.region}|${c.input.JobName}`)) { const e = new Error("not found"); e.name = "EntityNotFoundException"; throw e; }
        return { Job: { Name: c.input.JobName } };
      }
      if (op === "StartJobRun") {
        if (h.startError) { const e = new Error(h.startError); e.name = h.startError; throw e; }
        return { JobRunId: "jr_test_1" };
      }
      if (op === "GetJobRun") {
        const st = h.runStates.length > 1 ? h.runStates.shift()! : h.runStates[0];
        return { JobRun: { JobRunState: st, ExecutionTime: 321, ErrorMessage: st === "FAILED" ? "Spark 抛了 OOM" : undefined } };
      }
      throw new Error(`unexpected glue op ${op}`);
    }
  }
  return { GlueClient, GetJobCommand, StartJobRunCommand, GetJobRunCommand };
});

vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, any>;
  const docClient = {
    send: async (c: any) => {
      const op = c.constructor.name.replace(/Command$/, "");
      const input = c.input;
      h.ddb.push({ op, input });
      if (input.TableName === real.TABLES.ACTION_COMMANDS) {
        const row = h.commands.get(input.Key?.commandId);
        if (op === "Get") return { Item: row ? { ...row } : undefined };
        if (op === "Update") {
          const v = input.ExpressionAttributeValues;
          const need = v[":pending"] ?? v[":running"];
          if (!row || row.status !== need) { const e = new Error("cond"); e.name = "ConditionalCheckFailedException"; throw e; }
          if (":running" in v && ":pending" in v) row.status = "running";
          else if (":st" in v) { row.status = v[":st"]; if (v[":st"] === "succeeded") row.summary = v[":x"]; else row.error = v[":x"]; }
          else if (":failed" in v) { row.status = "failed"; row.error = v[":err"]; }
          return {};
        }
      }
      return {};
    },
  };
  return { ...real, docClient };
});

vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real = (await orig()) as Record<string, any>;
  return {
    ...real,
    requireReadyTarget: vi.fn(async (id: string) => {
      const t = h.targets.get(id);
      if (!t) throw new real.TargetNotReadyError(id, "该执行环境不可承接");
      return t;
    }),
  };
});

import { runSeedOnce, SEED_POLL, SeedAlreadyRunning, SeedInvalid, SeedJobMissing } from "../run-once";
import { seedError } from "../seed-http";
import { dispatchCommand } from "@/lib/scheduler/action-dispatch";
import { ACTION_HANDLERS } from "@/lib/scheduler/action-handlers";
import { TABLES } from "@/lib/aws/dynamodb";
import { __resetClients } from "@/lib/aws/clients";

const ACCT = "000000000000";
const USW2 = {
  pk: "env", sk: "tgt_usw2_a", targetId: "tgt_usw2_a", region: "us-west-2", accountId: ACCT, status: "active", ready: true,
  components: ["core", "redshift", "airflow-serverless"],
  resources: {
    datalakeBucket: `bgp-datalake-${ACCT}-tgt-usw2-a`,
    scriptsBucket: `bgp-glue-scripts-${ACCT}-tgt-usw2-a`,
    tableBucket: "bgp-table-bucket-tgt-usw2-a",
    glueRoleArn: `arn:aws:iam::${ACCT}:role/BgpExecEnv-tgt-usw2-a-glue-role`,
  },
};

const instant = async () => {};
const runPuts = () => h.ddb.filter((x) => x.op === "Put" && x.input.TableName === TABLES.TASK_RUNS).map((x) => x.input.Item);
const runUpdates = () => h.ddb.filter((x) => x.op === "Update" && x.input.TableName === TABLES.TASK_RUNS).map((x) => x.input);
const starts = () => h.glueCalls.filter((c) => c.op === "StartJobRun");

beforeEach(() => {
  h.glueCalls.length = 0;
  h.ddb.length = 0;
  h.jobs = new Set(["us-west-2|bgp-game-seed-tgt_usw2_a", "us-east-1|bgp-game-seed"]);
  h.runStates = ["RUNNING", "SUCCEEDED"];
  h.startError = null;
  h.commands.clear();
  h.targets = new Map([["tgt_usw2_a", USW2]]);
  process.env.AWS_REGION = "us-east-1";
  SEED_POLL.intervalMs = 0;
  __resetClients();
});

describe("CAP-SEED ① 在点名的那个区跑那个区的作业", () => {
  it("非主控区:客户端区 / 作业名 / --datalake 全来自该区落点", async () => {
    const r = await runSeedOnce({ targetId: "tgt_usw2_a", dataset: "gamedata", projectId: "p1", trigger: "manual", sleep: instant });
    expect(r).toMatchObject({ targetId: "tgt_usw2_a", region: "us-west-2", jobName: "bgp-game-seed-tgt_usw2_a", jobRunId: "jr_test_1", state: "RUNNING" });
    expect(new Set(h.glueCalls.map((c) => c.region))).toEqual(new Set(["us-west-2"])); // 一个调用都不许打到主控区
    expect(starts()[0].input).toEqual({ JobName: "bgp-game-seed-tgt_usw2_a", Arguments: { "--datalake": USW2.resources.datalakeBucket } });
  });

  it("主控区:跑 bgp-game-seed(灌源库,不带参数)", async () => {
    const r = await runSeedOnce({ targetId: "tgt_home", dataset: "gamedata", projectId: "p1", trigger: "manual", sleep: instant });
    expect(r).toMatchObject({ region: "us-east-1", jobName: "bgp-game-seed" });
    expect(starts()[0].input).toEqual({ JobName: "bgp-game-seed", Arguments: {} });
  });
});

describe("CAP-SEED ② 手动:立刻返回 + 台账一行 + 后台收口", () => {
  it("台账:taskType=seed · 触发=手动 · 章=该区 · 归属项目;收口到 succeeded", async () => {
    const r = await runSeedOnce({ targetId: "tgt_usw2_a", dataset: "gamedata", projectId: "p1", trigger: "manual", sleep: instant });
    const puts = runPuts();
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({
      taskId: "seed_tgt_usw2_a", runId: r.runId, taskType: "seed", triggeredBy: "manual", status: "running",
      targetId: "tgt_usw2_a", projectId: "p1", glueJobName: "bgp-game-seed-tgt_usw2_a", glueJobRunId: "jr_test_1",
    });
    await vi.waitFor(() => expect(runUpdates()).toHaveLength(1));
    const u = runUpdates()[0];
    const set = Object.fromEntries(Object.entries(u.ExpressionAttributeNames as Record<string, string>)
      .filter(([k]) => k.startsWith("#k")).map(([k, name]) => [name, u.ExpressionAttributeValues[`:v${k.slice(2)}`]]));
    expect(set).toMatchObject({ status: "succeeded", duration: 321, error: null });
  });

  it("Glue 失败 ⇒ 台账收口 failed + 真因", async () => {
    h.runStates = ["FAILED"];
    await runSeedOnce({ targetId: "tgt_usw2_a", dataset: "gamedata", projectId: "p1", trigger: "manual", sleep: instant });
    await vi.waitFor(() => expect(runUpdates()).toHaveLength(1));
    const vals = Object.values(runUpdates()[0].ExpressionAttributeValues as Record<string, unknown>);
    expect(vals).toContain("failed");
    expect(vals.some((v) => typeof v === "string" && v.includes("Spark 抛了 OOM"))).toBe(true);
  });
});

describe("CAP-SEED ③ 定时:消费端整条链(命令表 → 抢单 → 执行体 → 终态)", () => {
  const cmd = (over: Record<string, unknown> = {}) => ({
    commandId: "c1", action: "seed.run-once", targetId: "tgt_usw2_a", projectId: "p1", params: { dataset: "gamedata" },
    runId: "scheduled__x", taskId: "seedsch_01X", requestedAt: "2026-10-11T00:00:00Z", status: "pending", ...over,
  });

  it("成功 ⇒ 命令 succeeded,摘要带 jobRunId / 区;不另写 run 台账(DAG 收口);审计 via=schedule", async () => {
    h.commands.set("c1", cmd());
    const out = await dispatchCommand("c1", ACTION_HANDLERS);
    expect(out.kind).toBe("accepted");
    await (out as { execution: Promise<void> }).execution;
    const row = h.commands.get("c1")!;
    expect(row.status).toBe("succeeded");
    expect(row.summary).toMatchObject({ jobName: "bgp-game-seed-tgt_usw2_a", jobRunId: "jr_test_1", region: "us-west-2", state: "SUCCEEDED" });
    expect(runPuts()).toEqual([]);
    const audits = h.ddb.filter((x) => x.op === "Put" && x.input.TableName === TABLES.AUDIT).map((x) => x.input.Item);
    expect(audits.some((a) => a.action === "seed.run" && JSON.stringify(a).includes('"via":"schedule"'))).toBe(true);
  });

  it("Glue 失败 ⇒ 命令 failed + 真因(DAG 轮询到 failed 就让 task 失败)", async () => {
    h.runStates = ["RUNNING", "FAILED"];
    h.commands.set("c1", cmd());
    const out = await dispatchCommand("c1", ACTION_HANDLERS);
    await (out as { execution: Promise<void> }).execution;
    const row = h.commands.get("c1")!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("Spark 抛了 OOM");
  });

  it("🔴 参数为空 ⇒ 命令直接判 failed,一个 Glue 调用都不发", async () => {
    h.commands.set("c1", cmd({ params: {} }));
    const out = await dispatchCommand("c1", ACTION_HANDLERS);
    expect(out.kind).toBe("rejected");
    expect(h.commands.get("c1")!.status).toBe("failed");
    expect(h.glueCalls).toEqual([]);
  });
});

describe("CAP-SEED ④ fail-closed", () => {
  it("该区没有造数作业(生产模式)⇒ SeedJobMissing → 409,零 StartJobRun、台账零行", async () => {
    h.jobs.clear();
    const e = await runSeedOnce({ targetId: "tgt_usw2_a", dataset: "gamedata", projectId: "p1", trigger: "manual", sleep: instant }).catch((x) => x);
    expect(e).toBeInstanceOf(SeedJobMissing);
    expect(starts()).toEqual([]);
    expect(runPuts()).toEqual([]);
    const res = seedError(e);
    expect(res.status).toBe(409);
    expect((await res.json()).error.detail.reason).toBe("seed-job-missing");
  });

  it("已有一轮在跑 ⇒ SeedAlreadyRunning → 409,台账零行", async () => {
    h.startError = "ConcurrentRunsExceededException";
    const e = await runSeedOnce({ targetId: "tgt_usw2_a", dataset: "gamedata", projectId: "p1", trigger: "manual", sleep: instant }).catch((x) => x);
    expect(e).toBeInstanceOf(SeedAlreadyRunning);
    expect(seedError(e).status).toBe(409);
    expect(runPuts()).toEqual([]);
  });

  it("没点名数据集 ⇒ SeedInvalid → 400,一个 Glue 调用都不发", async () => {
    const e = await runSeedOnce({ targetId: "tgt_usw2_a", dataset: "", projectId: "p1", trigger: "manual", sleep: instant }).catch((x) => x);
    expect(e).toBeInstanceOf(SeedInvalid);
    expect(seedError(e).status).toBe(400);
    expect(h.glueCalls).toEqual([]);
  });

  it("该区不可承接 ⇒ 拒绝(不回落主控区),一个 Glue 调用都不发", async () => {
    h.targets.clear();
    const e = await runSeedOnce({ targetId: "tgt_usw2_a", dataset: "gamedata", projectId: "p1", trigger: "manual", sleep: instant }).catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(h.glueCalls).toEqual([]);
    expect([409, 503]).toContain(seedError(e).status);
  });
});
