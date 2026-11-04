// @kf-batch 50-SEQ47b-backfill-observability —— 序 47b(B-101)补数实例可观测事实的判据。
// 钉**事实**:行数从哪个字段取、「不知道」≠ 0、「成功但 0 行」只在三个条件同时成立时成立、汇总不把未知混进总和、
// BatchGet 按 (taskId, runId) 去重分批且 UnprocessedKeys 继续取、取不齐就抛。只 mock 真外部(DynamoDB 客户端)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock("@/lib/aws/dynamodb", () => ({
  docClient: { send: sendMock },
  TABLES: { TASK_RUNS: "bgp-task-runs" },
}));

import { runFactsOf, loadRunFacts, factsForInstance, isZeroRowSuccess, zeroRowHints, summarizeRows } from "../run-facts";
import type { BackfillInstanceRow } from "../types";

const inst = (over: Partial<BackfillInstanceRow>): BackfillInstanceRow => ({
  planId: "plan1", sk: "2026-01-01#n1", date: "2026-01-01", nodeId: "n1", nodeName: "job", status: "succeeded", dependsOn: [], attempts: 1, ttl: 0, ...over,
});

beforeEach(() => { sendMock.mockReset(); });

describe("runFactsOf —— 行数来源与「不知道」", () => {
  it("同步任务:metrics.rowsWritten ⇒ rowsWritten 且来源 sync-metrics(同时有 rowsAffected 也以写入侧为准)", () => {
    const f = runFactsOf({ taskId: "t", runId: "r", taskType: "sync", status: "succeeded", metrics: { rowsRead: 12, rowsWritten: 10, rowsAffected: 99 }, glueJobName: "bgp-sync-x", glueJobRunId: "jr_1" });
    expect(f.rowsWritten).toBe(10); expect(f.rowsRead).toBe(12); expect(f.rowsSource).toBe("sync-metrics");
    expect(f.glueJobName).toBe("bgp-sync-x"); expect(f.glueJobRunId).toBe("jr_1");
  });
  it("Redshift 语句:只有 metrics.rowsAffected ⇒ rowsWritten = 它,来源 redshift-affected", () => {
    const f = runFactsOf({ taskId: "t", runId: "r", taskType: "etl", status: "succeeded", metrics: { rowsAffected: 0 }, statementId: "st-1", duration: 3 });
    expect(f.rowsWritten).toBe(0); expect(f.rowsSource).toBe("redshift-affected"); expect(f.statementId).toBe("st-1"); expect(f.duration).toBe(3);
  });
  it("🔴 没有任何行数指标 ⇒ rowsWritten 是 null(不是 0),来源 unknown;error 缺省 null", () => {
    const f = runFactsOf({ taskId: "t", runId: "r", taskType: "emr-serverless", status: "succeeded" });
    expect(f.rowsWritten).toBeNull(); expect(f.rowsSource).toBe("unknown"); expect(f.error).toBeNull(); expect(f.duration).toBeNull();
  });
  it("数字写成字符串也认;非数字不认", () => {
    expect(runFactsOf({ metrics: { rowsWritten: "7" } }).rowsWritten).toBe(7);
    expect(runFactsOf({ metrics: { rowsWritten: "abc" } }).rowsWritten).toBeNull();
  });
});

describe("isZeroRowSuccess / zeroRowHints", () => {
  const zeroRun = runFactsOf({ taskId: "t", runId: "r", taskType: "etl", status: "succeeded", metrics: { rowsAffected: 0 } });
  const unknownRun = runFactsOf({ taskId: "t", runId: "r", taskType: "emr-serverless", status: "succeeded" });
  it("成功 ∧ 行数已知 ∧ 为 0 ⇒ 真;给出含业务日期的候选原因(SQL 版第三条提「指定日期运行 / 直查」)", () => {
    const i = inst({ status: "succeeded", date: "2026-01-03" });
    expect(isZeroRowSuccess(i, zeroRun)).toBe(true);
    const hints = zeroRowHints(i, zeroRun);
    expect(hints.length).toBe(3);
    expect(hints[0]).toContain("2026-01-03");
    expect(hints[2]).toContain("指定日期运行");
  });
  it("同步任务版第三条提增量水位", () => {
    const syncZero = runFactsOf({ taskId: "t", runId: "r", taskType: "sync", status: "succeeded", metrics: { rowsWritten: 0 } });
    expect(zeroRowHints(inst({ status: "succeeded" }), syncZero)[2]).toContain("水位");
  });
  it("🔴 行数未上报(null)不算 0 行;失败 / 运行中即便 0 行也不算;没有 run 不算", () => {
    expect(isZeroRowSuccess(inst({ status: "succeeded" }), unknownRun)).toBe(false);
    expect(isZeroRowSuccess(inst({ status: "failed" }), zeroRun)).toBe(false);
    expect(isZeroRowSuccess(inst({ status: "running" }), zeroRun)).toBe(false);
    expect(isZeroRowSuccess(inst({ status: "succeeded" }), undefined)).toBe(false);
    expect(zeroRowHints(inst({ status: "succeeded" }), unknownRun)).toEqual([]);
  });
});

describe("summarizeRows —— 只汇总成功且行数已知的实例,未知单独计数", () => {
  it("3 成功(10 / 0 / 未知)+ 1 失败 ⇒ total 10 · withRows 2 · zero 1 · unknown 1", () => {
    const facts = new Map([
      ["t#r1", runFactsOf({ taskId: "t", runId: "r1", metrics: { rowsWritten: 10 } })],
      ["t#r2", runFactsOf({ taskId: "t", runId: "r2", metrics: { rowsAffected: 0 } })],
      ["t#r3", runFactsOf({ taskId: "t", runId: "r3" })],
      ["t#r4", runFactsOf({ taskId: "t", runId: "r4", metrics: { rowsWritten: 5 } })],
    ]);
    const list = [
      inst({ sk: "a", runTaskId: "t", runId: "r1" }),
      inst({ sk: "b", runTaskId: "t", runId: "r2" }),
      inst({ sk: "c", runTaskId: "t", runId: "r3" }),
      inst({ sk: "d", runTaskId: "t", runId: "r4", status: "failed" }),
    ];
    expect(summarizeRows(list, facts)).toEqual({ rowsWrittenTotal: 10, instancesWithRows: 2, instancesZeroRows: 1, instancesUnknown: 1 });
    expect(factsForInstance(list[3], facts)?.rowsWritten).toBe(5);
    expect(factsForInstance(inst({ sk: "e" }), facts)).toBeUndefined();
  });
});

describe("loadRunFacts —— BatchGet 去重分批 + UnprocessedKeys 续取 + 取不齐就抛", () => {
  it("101 个不同 (taskId, runId) ⇒ 两批(100 + 1);同键实例只取一次;结果按 taskId#runId 可查", async () => {
    sendMock.mockImplementation(async (cmd: { input: { RequestItems: Record<string, { Keys: Array<{ taskId: string; runId: string }> }> } }) => {
      const keys = cmd.input.RequestItems["bgp-task-runs"].Keys;
      return { Responses: { "bgp-task-runs": keys.map((k) => ({ ...k, status: "succeeded", metrics: { rowsWritten: 1 } })) } };
    });
    const list: BackfillInstanceRow[] = [];
    for (let i = 0; i < 101; i++) list.push(inst({ sk: `s${i}`, runTaskId: "t", runId: `r${i}` }));
    list.push(inst({ sk: "dup", runTaskId: "t", runId: "r0" })); // 同键
    list.push(inst({ sk: "norun" })); // 没起过 run
    const facts = await loadRunFacts(list);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0][0].input.RequestItems["bgp-task-runs"].Keys).toHaveLength(100);
    expect(sendMock.mock.calls[1][0].input.RequestItems["bgp-task-runs"].Keys).toHaveLength(1);
    expect(facts.size).toBe(101);
    expect(facts.get("t#r0")?.rowsWritten).toBe(1);
  });
  it("UnprocessedKeys 继续取;连取 5 轮仍剩 ⇒ 抛(不回残缺事实)", async () => {
    let calls = 0;
    sendMock.mockImplementation(async (cmd: { input: { RequestItems: Record<string, { Keys: Array<{ taskId: string; runId: string }> }> } }) => {
      calls++;
      const keys = cmd.input.RequestItems["bgp-task-runs"].Keys;
      if (calls === 1) return { Responses: { "bgp-task-runs": [{ ...keys[0], status: "succeeded" }] }, UnprocessedKeys: { "bgp-task-runs": { Keys: keys.slice(1) } } };
      return { Responses: { "bgp-task-runs": keys.map((k) => ({ ...k, status: "failed", error: "boom" })) } };
    });
    const facts = await loadRunFacts([inst({ sk: "a", runTaskId: "t", runId: "r1" }), inst({ sk: "b", runTaskId: "t", runId: "r2" })]);
    expect(calls).toBe(2);
    expect(facts.get("t#r2")?.error).toBe("boom");

    sendMock.mockReset();
    sendMock.mockImplementation(async (cmd: { input: { RequestItems: Record<string, { Keys: unknown[] }> } }) => ({
      Responses: {}, UnprocessedKeys: { "bgp-task-runs": { Keys: cmd.input.RequestItems["bgp-task-runs"].Keys } },
    }));
    await expect(loadRunFacts([inst({ sk: "a", runTaskId: "t", runId: "r1" })])).rejects.toThrow(/仍未取到/);
  });
  it("没有任何实例带 run 定位键 ⇒ 不打 DynamoDB", async () => {
    const facts = await loadRunFacts([inst({ sk: "a" })]);
    expect(facts.size).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
