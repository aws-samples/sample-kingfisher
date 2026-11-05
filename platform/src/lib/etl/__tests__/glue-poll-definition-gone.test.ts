// 2026-11-04 —— Glue 轮询器把「作业定义已不存在」当终态:GetJobRun EntityNotFound ⇒ 再问 GetJob;定义也没了 ⇒ run 行写 failed(error 原话)+ 释放锁 + 停止轮询;
//   定义还在 / 瞬时错误 ⇒ 照旧有界轮询;作业行已删 ⇒ 续租失败不再静默停,改为继续跟踪到终态且作业行回写被条件写丢弃(不造幽灵行);
//   抢锁带 attribute_exists(#pk)(锁只许落在存在的作业行上)。
// 装配层:job-service ↔ run-lock ↔ run-records ↔ job-inflight ↔ glue-job-upsert(EntityNotFound 判法)不 mock;只替换 Glue / S3 客户端工厂、DDB、数仓凭证。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  glue: [] as Array<{ cmd: string; input: Record<string, unknown> }>,
  ddb: [] as Array<{ cmd: string; input: Record<string, any> }>,
  defExists: true,
  jobRunMode: "running" as "running" | "gone" | "throttle" | "succeeded",
  jobRowGone: false,
}));

vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const TABLES = real.TABLES as Record<string, string>;
  return {
    ...real,
    docClient: {
      send: async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
        const n = cmd.constructor.name;
        const input = cmd.input ?? {};
        h.ddb.push({ cmd: n, input });
        if (n === "GetCommand") return { Item: h.jobRowGone ? undefined : { userId: "default-user", jobId: input.Key?.jobId } };
        // 作业行已删:任何带条件的 UpdateItem(续租 #t = :tok / 回写 attribute_exists(jobId) / 释放)都条件不满足
        if (n === "UpdateCommand" && input.TableName === TABLES.ETL_JOBS && h.jobRowGone && typeof input.ConditionExpression === "string") {
          const e = new Error("The conditional request failed"); e.name = "ConditionalCheckFailedException"; throw e;
        }
        return {};
      },
    },
  };
});
vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const notFound = () => { const e = new Error("Entity not found"); e.name = "EntityNotFoundException"; return e; };
  return {
    ...real,
    glueClientFor: async () => ({
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const n = cmd.constructor.name;
        h.glue.push({ cmd: n, input: cmd.input });
        if (n === "GetJobCommand") { if (h.defExists) return { Job: { Name: cmd.input.JobName } }; throw notFound(); }
        if (n === "StartJobRunCommand") return { JobRunId: "jr_b142_0001" };
        if (n === "GetJobRunCommand") {
          if (h.jobRunMode === "gone") throw notFound();
          if (h.jobRunMode === "throttle") { const e = new Error("Rate exceeded"); e.name = "ThrottlingException"; throw e; }
          return { JobRun: { JobRunState: h.jobRunMode === "succeeded" ? "SUCCEEDED" : "RUNNING", ExecutionTime: 12 } };
        }
        return {};
      },
    }),
    s3ClientFor: async () => ({ send: async () => ({}) }),
  };
});
vi.mock("@/lib/redshift/admin-secret", () => ({
  getRedshiftSecretArn: async () => "arn:aws:secretsmanager:us-east-1:123456789012:secret:redshift-admin-AbCdEf",
}));

process.env.AWS_REGION = "us-east-1";
process.env.AWS_DEFAULT_REGION = "us-east-1";
process.env.AWS_ACCOUNT_ID = "123456789012";
process.env.GLUE_ROLE_ARN = "arn:aws:iam::123456789012:role/bgp-glue-role";
process.env.GLUE_SCRIPTS_BUCKET = "scripts-home";
process.env.EMR_LOG_BUCKET = "dl-home";
process.env.S3TABLES_BUCKET = "tb-home";

const { runGlueScriptJob } = await import("@/lib/etl/job-service");
const { JOB_DEFINITION_GONE_ERROR } = await import("@/lib/etl/job-inflight");
const { TABLES } = await import("@/lib/aws/dynamodb");

// 🔴 夹具 id 末 12 位必含字母
const JOB_ID = "01JOBB142POLLGLUEXXXXXXAB";
const job = () => ({
  userId: "default-user", jobId: JOB_ID, name: "b142-poll", type: "glue", script: "print('hi')\n", projectId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", glueConfig: {},
}) as never;

/** 解码 run 写通道的 UpdateCommand(#k<i> 别名)成普通对象 */
const decode = (input: Record<string, any>) => {
  const names = input.ExpressionAttributeNames ?? {}; const values = input.ExpressionAttributeValues ?? {};
  const out: Record<string, unknown> = {};
  for (const [alias, name] of Object.entries(names)) { const v = values[`:v${String(alias).slice(2)}`]; if (String(alias).startsWith("#k") && v !== undefined) out[name as string] = v; }
  return out;
};
const runRowWrites = () => h.ddb.filter((x) => x.cmd === "UpdateCommand" && x.input.TableName === TABLES.TASK_RUNS).map((x) => decode(x.input));
const jobRowStatusWrites = () => h.ddb.filter((x) => x.cmd === "UpdateCommand" && x.input.TableName === TABLES.ETL_JOBS && String(x.input.UpdateExpression).includes("lastRunStatus"));
const lockReleases = () => h.ddb.filter((x) => x.cmd === "UpdateCommand" && String(x.input.UpdateExpression).startsWith("REMOVE #t"));
const getJobRuns = () => h.glue.filter((c) => c.cmd === "GetJobRunCommand").length;
const getJobs = () => h.glue.filter((c) => c.cmd === "GetJobCommand").length;

beforeEach(() => { h.glue.length = 0; h.ddb.length = 0; h.defExists = true; h.jobRunMode = "running"; h.jobRowGone = false; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("🔴 pollGlueRun:作业定义已不存在 ⇒ 当场收口,不再空转 40 分钟", () => {
  it("定义被删(作业行还在,如 Glue 侧外部删除):下一轮 GetJobRun EntityNotFound → GetJob 也 EntityNotFound ⇒ run 行 failed + 原话 error;作业行回写 failed(条件写);释放锁;之后不再轮询", async () => {
    await runGlueScriptJob(job(), { targetId: "tgt_home", triggeredBy: "manual" });
    const getJobsAtSubmit = getJobs();
    h.defExists = false; h.jobRunMode = "gone";
    await vi.advanceTimersByTimeAsync(15_000);
    const failed = runRowWrites().find((w) => w.status === "failed");
    expect(failed, "run 行没按失败收口 ⇒ 永远「运行中」").toBeTruthy();
    expect(failed!.error).toBe(JOB_DEFINITION_GONE_ERROR.glue);
    expect(typeof failed!.finishedAt).toBe("string");
    expect(getJobs() - getJobsAtSubmit, "收口前必须再问一次定义本体").toBe(1);
    const js = jobRowStatusWrites();
    expect(js.at(-1)!.input.ExpressionAttributeValues[":s"]).toBe("failed");
    expect(js.at(-1)!.input.ConditionExpression).toBe("attribute_exists(jobId)");
    expect(lockReleases(), "确认终态必须释放运行锁").toHaveLength(1);
    expect(lockReleases()[0].input.ConditionExpression).toBe("#t = :tok");
    const polls = getJobRuns();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getJobRuns(), "收口后还在轮询").toBe(polls);
  });

  it("作业行也已删(缺陷原形:删作业把行与定义一起删了):续租条件写失败 ⇒ 不静默停,确认行已不在后继续跟踪;定义没了 ⇒ run 行 failed;作业行回写被条件写丢弃(不造幽灵行);没有锁可释放", async () => {
    await runGlueScriptJob(job(), { targetId: "tgt_home" });
    h.jobRowGone = true; h.defExists = false; h.jobRunMode = "gone";
    await vi.advanceTimersByTimeAsync(15_000);
    const failed = runRowWrites().find((w) => w.status === "failed");
    expect(failed, "作业行被删后 run 行必须仍被收口").toBeTruthy();
    expect(failed!.error).toBe(JOB_DEFINITION_GONE_ERROR.glue);
    // 续租失败后读过作业行主键(只有它能分辨「行已删」与「被别的 run 接管」)
    const probe = h.ddb.find((x) => x.cmd === "GetCommand" && x.input.TableName === TABLES.ETL_JOBS && x.input.ProjectionExpression === "#pk" && x.input.ExpressionAttributeNames?.["#pk"] === "userId");
    expect(probe?.input.Key).toEqual({ userId: "default-user", jobId: JOB_ID });
    // 作业行 failed 回写发了、带条件、被拒后吞掉(没有裸 upsert)
    const js = jobRowStatusWrites();
    expect(js.at(-1)!.input.ConditionExpression).toBe("attribute_exists(jobId)");
    expect(lockReleases(), "行已不在,没有锁可释放").toHaveLength(0);
    const polls = getJobRuns();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getJobRuns()).toBe(polls);
  });

  it("GetJobRun 一时查不到但定义还在 ⇒ 不下结论、继续轮询;下一轮 SUCCEEDED ⇒ 正常收口 succeeded", async () => {
    await runGlueScriptJob(job(), { targetId: "tgt_home" });
    h.jobRunMode = "gone";
    await vi.advanceTimersByTimeAsync(15_000);
    expect(runRowWrites().some((w) => w.status === "failed")).toBe(false);
    expect(lockReleases()).toHaveLength(0);
    h.jobRunMode = "succeeded";
    await vi.advanceTimersByTimeAsync(15_000);
    expect(runRowWrites().find((w) => w.status === "succeeded")).toBeTruthy();
    expect(lockReleases()).toHaveLength(1);
  });

  it("瞬时错误(ThrottlingException)⇒ 不问定义、不写终态,照旧有界轮询", async () => {
    await runGlueScriptJob(job(), { targetId: "tgt_home" });
    const getJobsAtSubmit = getJobs();
    h.jobRunMode = "throttle";
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getJobRuns()).toBe(2);
    expect(getJobs()).toBe(getJobsAtSubmit);
    expect(runRowWrites()).toHaveLength(0);
    expect(lockReleases()).toHaveLength(0);
  });

  it("抢锁只许落在存在的作业行上(attribute_exists(#pk));running 回写带 attribute_exists(jobId)", async () => {
    await runGlueScriptJob(job(), { targetId: "tgt_home" });
    const acquire = h.ddb.find((x) => x.cmd === "UpdateCommand" && String(x.input.UpdateExpression) === "SET #t = :tok, #e = :exp");
    expect(acquire?.input.ConditionExpression).toBe("attribute_exists(#pk) AND (attribute_not_exists(#t) OR #e < :now)");
    expect(acquire?.input.ExpressionAttributeNames).toEqual({ "#t": "runLockToken", "#e": "runLockExpiresAt", "#pk": "userId" });
    const running = h.ddb.find((x) => x.cmd === "UpdateCommand" && String(x.input.UpdateExpression).startsWith("SET glueJobName"));
    expect(running?.input.ConditionExpression).toBe("attribute_exists(jobId)");
  });
});
