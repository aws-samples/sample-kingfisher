// @kf-batch 50-WP5-rungroup
// 「取消一条 run,在它自己那个 target 上」的装配层单测(50 SPEC v3.44 §2.7 cancel;判据 E-163)。
//
// 🔴 mock 边界:**真外部**(DDB 客户端 / 两个 per-target AWS 客户端工厂 / 引擎 provider)。
//    `run-records` 这个兄弟模块**不 mock** —— 「取消成功后台账要变成 stopped」这一步正是接缝,
//    mock 掉它就等于不看(记忆 mock-hides-the-seam)。
// 🔴 客户端工厂的 mock **必须记下传进来的 targetId 并据此回不同的客户端**,不许回一个「反正能用」的假对象:
//    拿 home 客户端去停非 home 的 run 不会报错、只会什么都没停掉却回成功 —— 那正是要观察的那件事。
import { describe, it, expect, vi, beforeEach } from "vitest";

const store: Record<string, Record<string, any>> = {};
const rsSent: Array<{ targetId: string; cmd: string; input: any }> = [];
const glueSent: Array<{ targetId: string; cmd: string; input: any }> = [];
const providerStops: Array<{ runId: string; nativeRunId: string }> = [];
let rsThrow: Error | null = null;

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { TASK_RUNS: "bgp-task-runs", RUN_GROUPS: "bgp-run-groups" },
  docClient: {
    send: vi.fn(async (cmd: { input?: any; constructor: { name: string } }) => {
      const input = cmd.input ?? {};
      if (cmd.constructor.name === "UpdateCommand") {
        const k = `${input.Key.taskId}#${input.Key.runId}`;
        if (!store[k]) { const e = new Error("cond"); e.name = "ConditionalCheckFailedException"; throw e; }
        const names = input.ExpressionAttributeNames ?? {};
        for (const [ph, val] of Object.entries(input.ExpressionAttributeValues ?? {})) {
          const nameKey = Object.keys(names).find((n) => names[n] && input.UpdateExpression.includes(`${n} = ${ph}`));
          if (nameKey) store[k][names[nameKey]] = val;
        }
        return {};
      }
      throw new Error(`内存 DDB 不支持:${cmd.constructor.name}`);
    }),
  },
}));

vi.mock("@/lib/exec-env/data-plane-target", () => ({
  redshiftClientForTarget: vi.fn(async (targetId: string) => ({
    send: vi.fn(async (cmd: { input?: any; constructor: { name: string } }) => {
      if (rsThrow) { const e = rsThrow; rsThrow = null; throw e; }
      rsSent.push({ targetId, cmd: cmd.constructor.name, input: cmd.input });
      return {};
    }),
  })),
  glueClientForTarget: vi.fn(async (targetId: string) => ({
    send: vi.fn(async (cmd: { input?: any; constructor: { name: string } }) => {
      glueSent.push({ targetId, cmd: cmd.constructor.name, input: cmd.input });
      return {};
    }),
  })),
}));

vi.mock("@/lib/engines/registry", () => ({
  getProvider: vi.fn(() => ({
    stop: vi.fn(async (_job: unknown, runId: string, nativeRunId: string) => {
      providerStops.push({ runId, nativeRunId });
    }),
  })),
}));

const { cancelRunOnItsTarget } = await import("@/lib/monitor/run-cancel");

const RUN = {
  taskId: "job1",
  runId: "r1",
  targetId: "tgt_use1_a",
  status: "running",
};

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  rsSent.length = 0; glueSent.length = 0; providerStops.length = 0; rsThrow = null;
  store["job1#r1"] = { taskId: "job1", runId: "r1", status: "running" };
});

describe("🔴 已终态一律不连坐(E-163 的负向半边)", () => {
  for (const st of ["succeeded", "failed", "stopped"]) {
    it(`${st} ⇒ 不取消、不发任何后端调用、台账一个字节不变`, async () => {
      store["job1#r1"].status = st;
      const before = JSON.stringify(store);
      const r = await cancelRunOnItsTarget({ ...RUN, status: st, taskType: "etl-redshift", statementId: "s1" });
      expect(r.cancelled).toBe(false);
      expect(r.reason).toMatch(/已终态/);
      expect(rsSent, "已终态还去调后端 = 可能把别人的语句取消了").toEqual([]);
      expect(JSON.stringify(store), "把 succeeded 改成 stopped = 伪造历史").toBe(before);
    });
  }
});

describe("🔴 客户端必须按**这条 run 自己的 targetId** 建", () => {
  it("Redshift:CancelStatement 打在该 run 的 target 上,且台账收口成 stopped", async () => {
    const r = await cancelRunOnItsTarget({ ...RUN, taskType: "etl-redshift", statementId: "stmt-9" });
    expect(r).toMatchObject({ cancelled: true, targetId: "tgt_use1_a", runId: "r1" });
    expect(rsSent).toHaveLength(1);
    expect(rsSent[0].targetId, "🔴 拿 home 客户端去停非 home 的语句什么都不会发生却回成功").toBe("tgt_use1_a");
    expect(rsSent[0].cmd).toBe("CancelStatementCommand");
    expect(rsSent[0].input.Id).toBe("stmt-9");
    expect(store["job1#r1"].status, "取消是用户的意图,台账要立刻反映(否则组一直停在 running)").toBe("stopped");
    expect(store["job1#r1"].finishedAt).toBeTruthy();
  });

  it("试运行(etl-redshift-dryrun)走同一支", async () => {
    const r = await cancelRunOnItsTarget({ ...RUN, taskType: "etl-redshift-dryrun", statementId: "stmt-d" });
    expect(r.cancelled).toBe(true);
    expect(rsSent[0].input.Id).toBe("stmt-d");
  });

  it("Glue:BatchStopJobRun 带作业名 + JobRunId,打在该 run 的 target 上", async () => {
    const r = await cancelRunOnItsTarget({ ...RUN, taskType: "etl-glue", glueJobName: "g1", glueJobRunId: "jr1" });
    expect(r.cancelled).toBe(true);
    expect(glueSent[0].targetId).toBe("tgt_use1_a");
    expect(glueSent[0].cmd).toBe("BatchStopJobRunCommand");
    expect(glueSent[0].input).toMatchObject({ JobName: "g1", JobRunIds: ["jr1"] });
    expect(store["job1#r1"].status).toBe("stopped");
  });

  it("EMR:委托给引擎 provider(它自己收口 stopped ⇒ 本模块**不**重复写,免两个作者)", async () => {
    const r = await cancelRunOnItsTarget({ ...RUN, taskType: "emr-serverless", nativeRunId: "n1" }, { job: { jobId: "job1" } });
    expect(r.cancelled).toBe(true);
    expect(providerStops).toEqual([{ runId: "r1", nativeRunId: "n1" }]);
    expect(store["job1#r1"].status, "provider 自己写;这里再写一遍就是两个作者").toBe("running");
  });
});

describe("🔴 取消不了的时候必须说清楚,绝不静默当成功", () => {
  it("缺原生标识 ⇒ 不取消 + 人话原因 + 零后端调用", async () => {
    expect(await cancelRunOnItsTarget({ ...RUN, taskType: "etl-redshift" })).toMatchObject({ cancelled: false });
    expect((await cancelRunOnItsTarget({ ...RUN, taskType: "etl-glue", glueJobName: "g1" })).reason).toMatch(/JobRunId/);
    expect((await cancelRunOnItsTarget({ ...RUN, taskType: "emr-serverless" })).reason).toMatch(/nativeRunId/);
    expect((await cancelRunOnItsTarget({ ...RUN, taskType: "emr-serverless", nativeRunId: "n1" })).reason).toMatch(/作业定义/);
    expect(rsSent.concat(glueSent)).toEqual([]);
    expect(providerStops).toEqual([]);
  });

  it("🔴 平台不认识的 taskType ⇒ 如实说「不知道怎么取消」并指出去哪儿手动停(静默成功会让页面说已取消而后端还在烧钱)", async () => {
    const r = await cancelRunOnItsTarget({ ...RUN, taskType: "flink" });
    expect(r.cancelled).toBe(false);
    expect(r.reason).toContain("flink");
    expect(r.reason).toMatch(/手动停止/);
  });

  it("后端报错 ⇒ 回 cancelled:false 带原文,**不抛**(一个区停不下来不该让另一个区的成功取消变成失败)", async () => {
    rsThrow = new Error("ThrottlingException: rate exceeded");
    const r = await cancelRunOnItsTarget({ ...RUN, taskType: "etl-redshift", statementId: "s1" });
    expect(r.cancelled).toBe(false);
    expect(r.reason).toContain("ThrottlingException");
    expect(store["job1#r1"].status, "后端没停成就不许把台账写成 stopped").toBe("running");
  });
});
