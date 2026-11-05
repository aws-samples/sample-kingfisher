// 2026-11-04 —— 「作业还有没有在途运行」的唯一作者 + 删作业 409 JOB_RUN_IN_PROGRESS 的原话 / detail + 轮询器收口口径的原话。
//   只 mock 真外部(DDB docClient);run-records(listRunsByTask 翻页)/ run-groups(终态词表)/ run-lock(锁属性反解)全部真跑 —— 接缝正在被测。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  pages: [] as Array<{ Items: unknown[]; LastEvaluatedKey?: Record<string, unknown> }>,
  queries: [] as Record<string, unknown>[],
  gets: [] as Record<string, unknown>[],
  jobRowExists: true,
  getThrows: false,
}));
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    docClient: {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (cmd.constructor.name === "QueryCommand") {
          h.queries.push(cmd.input);
          return h.pages[h.queries.length - 1] ?? { Items: [] };
        }
        if (cmd.constructor.name === "GetCommand") {
          h.gets.push(cmd.input);
          if (h.getThrows) throw new Error("ProvisionedThroughputExceededException");
          return { Item: h.jobRowExists ? { userId: "default-user" } : undefined };
        }
        return {};
      },
    },
  };
});

const { jobInflight, hasInflight, jobRunInProgressResponse, JOB_DEFINITION_GONE_ERROR, JOB_RUN_IN_PROGRESS_CODE, isEmrResourceNotFound, isGlueEntityNotFoundByName, jobRowDeleteInput } =
  await import("@/lib/etl/job-inflight");
const { isTerminalRunStatus, RUN_TERMINAL_STATUSES, RUN_INFLIGHT_STATUSES, RUN_CHILD_STATUSES, deriveGroupStatus } = await import("@/lib/monitor/run-groups");
const { RUN_LOCK_LEASE_MS, RUN_LOCK_LIVE_WINDOW_MS, runLockLiveCutoff } = await import("@/lib/etl/run-lock");

// 🔴 夹具 id 末 12 位必含字母
const JOB_ID = "01JOBB142GLUEXXXXXXXXXXAB";
const R = (suffix: string) => `01RUNB142${suffix.padStart(16, "A")}`;
const NOW = Date.parse("2026-11-04T08:10:00.000Z");

beforeEach(() => { h.pages = []; h.queries = []; h.gets = []; h.jobRowExists = true; h.getThrows = false; });

describe("jobInflight(jobId, jobRow):在途 = run 行未终态 ∪ 作业行上刚续租的运行锁", () => {
  it("按 taskId 翻页读全部 run;只有 succeeded / failed / stopped 算结束;running / 词表外 / 缺失都算在途(fail-closed);按 startedAt 升序;只带四个字段 + taskType", async () => {
    h.pages = [
      { Items: [
        { taskId: JOB_ID, runId: R("RUNNING"), status: "running", startedAt: "2026-11-04T08:00:10.000Z", targetId: "tgt_home", taskType: "etl-glue", glueJobRunId: "jr_x" },
        { taskId: JOB_ID, runId: R("OK"), status: "succeeded", startedAt: "2026-11-04T07:00:00.000Z", targetId: "tgt_home" },
      ], LastEvaluatedKey: { taskId: JOB_ID, runId: R("OK") } },
      { Items: [
        { taskId: JOB_ID, runId: R("FAILED"), status: "failed", startedAt: "2026-11-04T07:10:00.000Z" },
        { taskId: JOB_ID, runId: R("STOPPED"), status: "stopped", startedAt: "2026-11-04T07:20:00.000Z" },
        { taskId: JOB_ID, runId: R("ODD"), status: "pending", startedAt: "2026-11-04T08:00:05.000Z", targetId: "tgt_usw2_a" },
        { taskId: JOB_ID, runId: R("NOSTATUS"), startedAt: "2026-11-04T08:00:00.000Z" },
      ] },
    ];
    const x = await jobInflight(JOB_ID, { userId: "default-user", jobId: JOB_ID }, NOW);
    expect(x.runs).toEqual([
      { runId: R("NOSTATUS"), status: "", startedAt: "2026-11-04T08:00:00.000Z", targetId: "" },
      { runId: R("ODD"), status: "pending", startedAt: "2026-11-04T08:00:05.000Z", targetId: "tgt_usw2_a" },
      { runId: R("RUNNING"), status: "running", startedAt: "2026-11-04T08:00:10.000Z", targetId: "tgt_home", taskType: "etl-glue" },
    ]);
    expect(x.locks).toEqual([]);
    expect(hasInflight(x)).toBe(true);
    expect(h.queries).toHaveLength(2);
    expect(h.queries[0].KeyConditionExpression).toBe("taskId = :t");
    expect(h.queries[0].ExpressionAttributeValues).toEqual({ ":t": JOB_ID });
    expect(h.queries[1].ExclusiveStartKey).toEqual({ taskId: JOB_ID, runId: R("OK") });
  });

  it("空 jobId ⇒ 不读库、空;全终态且无锁 ⇒ hasInflight false(删除照常放行)", async () => {
    expect(await jobInflight("  ", null)).toEqual({ runs: [], locks: [] });
    expect(h.queries).toHaveLength(0);
    h.pages = [{ Items: [{ runId: R("OK"), status: "succeeded" }, { runId: R("FAILED"), status: "failed" }, { runId: R("STOPPED"), status: "stopped" }] }];
    const x = await jobInflight(JOB_ID, { userId: "default-user", jobId: JOB_ID });
    expect(x).toEqual({ runs: [], locks: [] });
    expect(hasInflight(x)).toBe(false);
  });

  it("作业行上的运行锁:刚续租(≤ 2 个续租间隔)⇒ 在途;没人续超过窗 / 已过期 / 工作流节点锁(runLock_<node>)⇒ 不算", async () => {
    const row = {
      userId: "default-user", jobId: JOB_ID,
      runLockToken: "tok-home", runLockExpiresAt: NOW + RUN_LOCK_LEASE_MS, // 刚抢 / 刚续
      "runLock-tgt_usw2_aToken": "tok-usw2", "runLock-tgt_usw2_aExpiresAt": NOW + RUN_LOCK_LEASE_MS - RUN_LOCK_LIVE_WINDOW_MS, // 恰好到窗 ⇒ 不算(没人看着)
      "runLock-tgt_eu1Token": "tok-eu1", "runLock-tgt_eu1ExpiresAt": NOW - 1, // 已过期(僵尸锁,可直接被抢)
      "runLock_node1Token": "tok-node", "runLock_node1ExpiresAt": NOW + RUN_LOCK_LEASE_MS, // 工作流节点锁的文法,不是作业锁
    };
    const x = await jobInflight(JOB_ID, row, NOW);
    expect(x.runs).toEqual([]);
    expect(x.locks).toEqual([{ targetId: "tgt_home", expiresAt: NOW + RUN_LOCK_LEASE_MS, renewedAgoMs: 0 }]);
    expect(hasInflight(x)).toBe(true);
    // 1 分钟前续过(轮询每 60 秒续一次)⇒ 仍算活着
    const y = await jobInflight(JOB_ID, { "runLock-tgt_usw2_aToken": "t", "runLock-tgt_usw2_aExpiresAt": NOW + RUN_LOCK_LEASE_MS - 60_000 }, NOW);
    expect(y.locks).toEqual([{ targetId: "tgt_usw2_a", expiresAt: NOW + RUN_LOCK_LEASE_MS - 60_000, renewedAgoMs: 60_000 }]);
  });
});

describe("jobRunInProgressResponse ⇒ 409 JOB_RUN_IN_PROGRESS(页面经 deleteJson 原话给用户看)", () => {
  const body = async (r: Response) => (await r.json()) as { success: boolean; error: { code: string; message: string; detail: { runs: unknown[]; locks: unknown[] } } };

  it("有在途 run(ETL):逐条「runId」(运行中 · target · startedAt 开始);ETL 页没有单条停止入口 ⇒ 不承诺「停止」;detail.runs 四字段", async () => {
    const r = jobRunInProgressResponse({
      runs: [
        { runId: R("ONE"), status: "running", startedAt: "2026-11-04T08:00:00.000Z", targetId: "tgt_home", taskType: "etl-glue" },
        { runId: R("TWO"), status: "pending", targetId: "tgt_usw2_a" },
      ],
      locks: [],
    }, "etl");
    expect(r.status).toBe(409);
    const b = await body(r);
    expect(b.success).toBe(false);
    expect(b.error.code).toBe("JOB_RUN_IN_PROGRESS");
    expect(JOB_RUN_IN_PROGRESS_CODE).toBe("JOB_RUN_IN_PROGRESS");
    expect(b.error.message).toBe(
      `这个作业仍有 2 条运行未结束:「${R("ONE")}」(运行中 · tgt_home · 2026-11-04T08:00:00.000Z 开始)、「${R("TWO")}」(pending · tgt_usw2_a) —— 已拒绝删除。` +
        "请等待这些运行结束后再删除;现在删掉会让它们的运行记录永远停在「运行中」,也无法再被跟踪。"
    );
    expect(b.error.detail.runs).toEqual([
      { runId: R("ONE"), status: "running", startedAt: "2026-11-04T08:00:00.000Z", targetId: "tgt_home" },
      { runId: R("TWO"), status: "pending", targetId: "tgt_usw2_a" },
    ]);
    expect(b.error.detail.locks).toEqual([]);
  });

  it("有在途 run(引擎作业):多一句指路运行历史里的「停止」(EmrJobPanel 真有这个按钮)", async () => {
    const r = jobRunInProgressResponse({ runs: [{ runId: R("EMR"), status: "running", startedAt: "2026-11-04T08:00:00.000Z", targetId: "tgt_home" }], locks: [] }, "engine");
    const b = await body(r);
    expect(r.status).toBe(409);
    expect(b.error.message).toBe(
      `这个作业仍有 1 条运行未结束:「${R("EMR")}」(运行中 · tgt_home · 2026-11-04T08:00:00.000Z 开始) —— 已拒绝删除。` +
        "请等待这些运行结束后再删除(或先在运行历史里「停止」它们);现在删掉会让它们的运行记录永远停在「运行中」,也无法再被跟踪。"
    );
  });

  it("只有刚续租的锁 / 删行条件写被拒(提交窗,run 行还没写出来):用户语言一句话(S7),锁的内部细节只进 detail.locks", async () => {
    const r = jobRunInProgressResponse({ runs: [], locks: [{ targetId: "tgt_usw2_a", expiresAt: NOW + RUN_LOCK_LEASE_MS - 4_000, renewedAgoMs: 4_000 }] }, "etl");
    const b = await body(r);
    expect(r.status).toBe(409);
    expect(b.error.code).toBe("JOB_RUN_IN_PROGRESS");
    expect(b.error.message).toBe("这个作业正在提交一次运行 —— 已拒绝删除。请稍候几秒后重试。");
    expect(b.error.message).not.toContain("运行锁");
    expect(b.error.detail).toEqual({ runs: [], locks: [{ targetId: "tgt_usw2_a", expiresAt: NOW + RUN_LOCK_LEASE_MS - 4_000, renewedAgoMs: 4_000 }] });
    // 条件写被拒后重读发现两边都空(窄窗已过)⇒ 同一句话,不编细节
    const race = await body(jobRunInProgressResponse({ runs: [], locks: [] }, "engine"));
    expect(race.error.message).toBe("这个作业正在提交一次运行 —— 已拒绝删除。请稍候几秒后重试。");
  });

  it("B2:timeout-pending 的行算在途,用户用词「已到调度器软限、等待对账」,并多一句真实出路(刷新列表让平台对账收口)", async () => {
    const etl = await body(jobRunInProgressResponse({ runs: [{ runId: R("TP"), status: "timeout-pending", startedAt: "2026-11-04T07:00:00.000Z", targetId: "tgt_home" }], locks: [] }, "etl"));
    expect(etl.error.message).toBe(
      `这个作业仍有 1 条运行未结束:「${R("TP")}」(已到调度器软限、等待对账 · tgt_home · 2026-11-04T07:00:00.000Z 开始) —— 已拒绝删除。` +
        "请等待这些运行结束后再删除;现在删掉会让它们的运行记录永远停在「运行中」,也无法再被跟踪。" +
        "其中「已到调度器软限、等待对账」的运行是调度器等了 50 分钟后放手的,后端可能仍在跑:请先刷新一次离线计算页的作业列表(平台会按后端真实状态对账收口),收口后再删除。"
    );
    expect(etl.error.message).not.toMatch(/timeout-pending/); // 不裸出英文状态
    const emr = await body(jobRunInProgressResponse({ runs: [{ runId: R("TP"), status: "timeout-pending", targetId: "tgt_usw2_a" }], locks: [] }, "engine"));
    expect(emr.error.message).toContain("(或先在运行历史里「停止」它们)");
    expect(emr.error.message).toContain("请先刷新一次引擎作业列表(平台会按后端真实状态对账收口),收口后再删除。");
    // running 行不带这句
    const plain = await body(jobRunInProgressResponse({ runs: [{ runId: R("RUN"), status: "running", targetId: "tgt_home" }], locks: [] }, "etl"));
    expect(plain.error.message).not.toContain("软限");
  });
});

describe("词表与口径(单一作者)", () => {
  it("词表(B2):在途 = running + timeout-pending;终态 = succeeded / failed / stopped;isTerminalRunStatus 对词表外 / 非字符串 / 缺失一律 false;组派生把 timeout-pending 当未终态", () => {
    expect([...RUN_INFLIGHT_STATUSES]).toEqual(["running", "timeout-pending"]);
    expect([...RUN_TERMINAL_STATUSES]).toEqual(["succeeded", "failed", "stopped"]);
    expect([...RUN_CHILD_STATUSES]).toEqual(["running", "timeout-pending", "succeeded", "failed", "stopped"]);
    for (const s of RUN_TERMINAL_STATUSES) expect(isTerminalRunStatus(s)).toBe(true);
    for (const s of RUN_INFLIGHT_STATUSES) expect(isTerminalRunStatus(s)).toBe(false);
    expect(isTerminalRunStatus("pending")).toBe(false);
    expect(isTerminalRunStatus(undefined)).toBe(false);
    expect(isTerminalRunStatus(null)).toBe(false);
    expect(isTerminalRunStatus(1)).toBe(false);
    expect(deriveGroupStatus([{ status: "timeout-pending" }, { status: "succeeded" }])).toEqual({ status: "running", unknownStatuses: [] });
  });
  it("轮询器收口原话(Glue / EMR);EMR「没有这个资源」与 Glue「实体不存在」都**只认错误名**(S2:/not found/i 的宽口径会把别的错判成定义已删)", () => {
    expect(JOB_DEFINITION_GONE_ERROR.glue).toBe("Glue 作业定义已不存在,运行无法继续跟踪;状态按失败收口(作业可能已被删除)");
    expect(JOB_DEFINITION_GONE_ERROR.emr).toBe("EMR application 已不存在,运行无法继续跟踪;状态按失败收口(作业可能已被删除)");
    const nf = new Error("x"); nf.name = "ResourceNotFoundException";
    expect(isEmrResourceNotFound(nf)).toBe(true);
    expect(isEmrResourceNotFound(new Error("ResourceNotFoundException"))).toBe(false); // 只认 name,不猜 message
    expect(isEmrResourceNotFound(null)).toBe(false);
    const enf = new Error("Entity not found"); enf.name = "EntityNotFoundException";
    expect(isGlueEntityNotFoundByName(enf)).toBe(true);
    const conn = new Error("Connection my-conn not found"); conn.name = "InvalidInputException";
    expect(isGlueEntityNotFoundByName(conn)).toBe(false);
    expect(isGlueEntityNotFoundByName(new Error("EntityNotFoundException"))).toBe(false);
  });
  it("jobRowDeleteInput(S1):主键 + 每把作业级锁(home ∪ 绑定区 ∪ 行上残留)都「不存在或没人刚续租」的条件;只有锁字段没有别的", () => {
    const row = { userId: "default-user", jobId: JOB_ID, targets: ["tgt_usw2_a"], "runLock-tgt_eu1Token": "x", "runLock-tgt_eu1ExpiresAt": NOW + 5 };
    const input = jobRowDeleteInput("bgp-etl-jobs", JOB_ID, row, NOW);
    expect(input.TableName).toBe("bgp-etl-jobs");
    expect(input.Key).toEqual({ userId: "default-user", jobId: JOB_ID });
    expect(input.ConditionExpression).toBe(
      "(attribute_not_exists(#lk0) OR #le0 < :liveCutoff) AND (attribute_not_exists(#lk1) OR #le1 < :liveCutoff) AND (attribute_not_exists(#lk2) OR #le2 < :liveCutoff)"
    );
    expect(input.ExpressionAttributeNames).toEqual({
      "#lk0": "runLockToken", "#le0": "runLockExpiresAt",
      "#lk1": "runLock-tgt_eu1Token", "#le1": "runLock-tgt_eu1ExpiresAt",
      "#lk2": "runLock-tgt_usw2_aToken", "#le2": "runLock-tgt_usw2_aExpiresAt",
    });
    expect(input.ExpressionAttributeValues).toEqual({ ":liveCutoff": runLockLiveCutoff(NOW) });
    // 存量单绑 / 无绑定的行:home 一把锁
    expect(jobRowDeleteInput("bgp-engine-jobs", JOB_ID, { userId: "default-user", jobId: JOB_ID }, NOW).ConditionExpression).toBe("(attribute_not_exists(#lk0) OR #le0 < :liveCutoff)");
  });
});
