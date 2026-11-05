// 2026-11-04 —— EMR 轮询器把「application 已不存在」当终态:GetJobRun ResourceNotFound ⇒ 再问 GetApplication;不存在 / TERMINATED ⇒ run 行 failed(原话)+ 释放锁 + 停;
//   application 还在 / 瞬时错误 ⇒ 照旧有界轮询;作业行已删 ⇒ 续租失败不静默停,继续跟踪,作业行回写被条件写丢弃(不造幽灵行)。
// 装配层:provider.poll ↔ run-record ↔ run-records ↔ run-lock ↔ job-inflight 不 mock;只替换 EMR 客户端工厂与 DDB。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  emr: [] as Array<{ cmd: string; input: Record<string, unknown> }>,
  ddb: [] as Array<{ cmd: string; input: Record<string, any> }>,
  appState: "STARTED" as string, // "missing" ⇒ GetApplication 抛 ResourceNotFoundException
  jobRunMode: "running" as "running" | "gone" | "throttle" | "success",
  jobRowGone: false,
}));

vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const TABLES = real.TABLES as Record<string, string>;
  return {
    ...real,
    docClient: {
      send: async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
        const n = cmd.constructor.name; const input = cmd.input ?? {};
        h.ddb.push({ cmd: n, input });
        if (n === "GetCommand" && input.TableName === TABLES.TASK_RUNS) {
          return { Item: { taskId: input.Key.taskId, runId: input.Key.runId, status: "running", targetId: "tgt_home", applicationId: "app-b142", nativeRunId: "jr-b142", taskType: "emr-serverless" } };
        }
        if (n === "GetCommand") return { Item: h.jobRowGone ? undefined : { userId: "default-user", jobId: input.Key?.jobId } };
        if (n === "UpdateCommand" && input.TableName === TABLES.ENGINE_JOBS && h.jobRowGone && typeof input.ConditionExpression === "string") {
          const e = new Error("The conditional request failed"); e.name = "ConditionalCheckFailedException"; throw e;
        }
        return {};
      },
    },
  };
});
vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const notFound = () => { const e = new Error("Application not found"); e.name = "ResourceNotFoundException"; return e; };
  return {
    ...real,
    emrServerlessClientFor: async () => ({
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const n = cmd.constructor.name;
        h.emr.push({ cmd: n, input: cmd.input });
        if (n === "GetApplicationCommand") { if (h.appState === "missing") throw notFound(); return { application: { applicationId: "app-b142", state: h.appState } }; }
        if (n === "GetJobRunCommand") {
          if (h.jobRunMode === "gone") throw notFound();
          if (h.jobRunMode === "throttle") { const e = new Error("Rate exceeded"); e.name = "ThrottlingException"; throw e; }
          return { jobRun: { state: h.jobRunMode === "success" ? "SUCCESS" : "RUNNING", totalExecutionDurationSeconds: 7 } };
        }
        return {};
      },
    }),
    s3ClientFor: async () => ({ send: async () => ({}) }),
  };
});
vi.mock("@/lib/engines/platform-env", () => ({ getEmrDefaultNetwork: async () => ({ subnetIds: ["subnet-home"], securityGroupIds: ["sg-home"] }) }));
vi.mock("@/lib/redshift/admin-secret", () => ({ getRedshiftSecretArn: async () => "arn:aws:secretsmanager:us-east-1:123456789012:secret:redshift-admin-AbCdEf" }));
vi.mock("@/lib/governance/lineage-service", () => ({ recordComputeLineage: async () => {} }));
vi.mock("@/lib/openmetadata/om-push", () => ({ pushComputeLineageToOM: async () => {} }));

process.env.AWS_REGION = "us-east-1";
process.env.AWS_DEFAULT_REGION = "us-east-1";
process.env.AWS_ACCOUNT_ID = "123456789012";
process.env.GLUE_SCRIPTS_BUCKET = "scripts-home";
process.env.EMR_LOG_BUCKET = "dl-home";
process.env.S3TABLES_BUCKET = "tb-home";

const { emrServerlessProvider } = await import("@/lib/engines/emr/provider");
const { JOB_DEFINITION_GONE_ERROR } = await import("@/lib/etl/job-inflight");
const { TABLES } = await import("@/lib/aws/dynamodb");

// 🔴 夹具 id 末 12 位必含字母
const JOB_ID = "01JOBB142POLLEMRXXXXXXXAB";
const RUN_ID = "01RUNB142EMRRUNXXXXXXXXAB";
const job = () => ({ userId: "default-user", jobId: JOB_ID, engine: "emr-serverless", name: "b142-emr", projectId: "p1", env: "dev", script: "x", status: "running", createdBy: "u", applicationId: "app-b142", spec: {}, network: {} }) as never;
const lock = () => ({ table: TABLES.ENGINE_JOBS, key: { userId: "default-user", jobId: JOB_ID }, attr: "runLock", token: "tok-b142" });

const decode = (input: Record<string, any>) => {
  const names = input.ExpressionAttributeNames ?? {}; const values = input.ExpressionAttributeValues ?? {};
  const out: Record<string, unknown> = {};
  for (const [alias, name] of Object.entries(names)) { const v = values[`:v${String(alias).slice(2)}`]; if (String(alias).startsWith("#k") && v !== undefined) out[name as string] = v; }
  return out;
};
const runRowWrites = () => h.ddb.filter((x) => x.cmd === "UpdateCommand" && x.input.TableName === TABLES.TASK_RUNS).map((x) => decode(x.input));
const jobRowStatusWrites = () => h.ddb.filter((x) => x.cmd === "UpdateCommand" && x.input.TableName === TABLES.ENGINE_JOBS && String(x.input.UpdateExpression).includes("lastRunStatus"));
const lockReleases = () => h.ddb.filter((x) => x.cmd === "UpdateCommand" && String(x.input.UpdateExpression).startsWith("REMOVE #t"));
const getJobRuns = () => h.emr.filter((c) => c.cmd === "GetJobRunCommand").length;
const getApps = () => h.emr.filter((c) => c.cmd === "GetApplicationCommand").length;

beforeEach(() => { h.emr.length = 0; h.ddb.length = 0; h.appState = "STARTED"; h.jobRunMode = "running"; h.jobRowGone = false; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("🔴 EMR poll:application 已不存在 ⇒ 当场收口,不再空转 60 分钟", () => {
  it.each([["missing(ResourceNotFound)", "missing"], ["TERMINATED", "TERMINATED"]])("GetJobRun ResourceNotFound → GetApplication %s ⇒ run 行 failed + 原话;作业行回写 failed(条件写);释放锁;停止轮询", async (_label, appState) => {
    const p = emrServerlessProvider.poll(job(), RUN_ID, "jr-b142", lock());
    h.jobRunMode = "gone"; h.appState = appState;
    await vi.advanceTimersByTimeAsync(15_000);
    await p;
    const failed = runRowWrites().find((w) => w.status === "failed");
    expect(failed, "run 行没按失败收口 ⇒ 永远「运行中」").toBeTruthy();
    expect(failed!.error).toBe(JOB_DEFINITION_GONE_ERROR.emr);
    expect(getApps(), "收口前必须再问一次 application 本体").toBe(1);
    const js = jobRowStatusWrites();
    expect(js.at(-1)!.input.ExpressionAttributeValues[":s"]).toBe("failed");
    expect(js.at(-1)!.input.ExpressionAttributeValues[":ls"]).toBe("failed");
    expect(js.at(-1)!.input.ConditionExpression).toBe("attribute_exists(jobId)");
    expect(lockReleases()).toHaveLength(1);
    const polls = getJobRuns();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getJobRuns()).toBe(polls);
  });

  it("作业行也已删:续租条件写失败 ⇒ 确认行已不在后继续跟踪;application 没了 ⇒ run 行 failed;作业行回写被条件写丢弃;没有锁可释放", async () => {
    const p = emrServerlessProvider.poll(job(), RUN_ID, "jr-b142", lock());
    h.jobRowGone = true; h.jobRunMode = "gone"; h.appState = "missing";
    await vi.advanceTimersByTimeAsync(15_000);
    await p;
    const failed = runRowWrites().find((w) => w.status === "failed");
    expect(failed).toBeTruthy();
    expect(failed!.error).toBe(JOB_DEFINITION_GONE_ERROR.emr);
    const probe = h.ddb.find((x) => x.cmd === "GetCommand" && x.input.TableName === TABLES.ENGINE_JOBS && x.input.ProjectionExpression === "#pk" && x.input.ExpressionAttributeNames?.["#pk"] === "userId");
    expect(probe?.input.Key).toEqual({ userId: "default-user", jobId: JOB_ID });
    expect(jobRowStatusWrites().at(-1)!.input.ConditionExpression).toBe("attribute_exists(jobId)");
    expect(lockReleases()).toHaveLength(0);
  });

  it("GetJobRun 一时查不到但 application 还 STARTED ⇒ 不下结论、继续轮询;下一轮 SUCCESS ⇒ 正常收口 succeeded", async () => {
    const p = emrServerlessProvider.poll(job(), RUN_ID, "jr-b142", lock());
    h.jobRunMode = "gone";
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getApps()).toBe(1);
    expect(runRowWrites().some((w) => w.status === "failed")).toBe(false);
    h.jobRunMode = "success";
    await vi.advanceTimersByTimeAsync(15_000);
    await p;
    expect(runRowWrites().find((w) => w.status === "succeeded")).toBeTruthy();
    expect(lockReleases()).toHaveLength(1);
  });

  it("瞬时错误(ThrottlingException)⇒ 不问 application、不写终态,照旧有界轮询", async () => {
    void emrServerlessProvider.poll(job(), RUN_ID, "jr-b142", lock());
    h.jobRunMode = "throttle";
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getJobRuns()).toBe(2);
    expect(getApps()).toBe(0);
    expect(runRowWrites()).toHaveLength(0);
    expect(lockReleases()).toHaveLength(0);
  });
});
