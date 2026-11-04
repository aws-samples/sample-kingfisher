// @kf-batch 50-WP17-serverless-workflow
// 「台账行 ↔ 服务侧 run」的对法(判据 ACCEPTANCE v1.43 段 `slsw` SW-10c / SW-10d / SW-12 的读侧一半)。
//
// 🔴 为什么值得单独一组:服务侧**不给**「台账 runId → 服务 RunId」的映射,只能自己对。
// 原来只有时间窗一种(±2 min),而一次手动 + 一次 cron 完全可能落在同 2 分钟里 ⇒ 对错了就把
// A 次运行的日志/状态显示成 B 次的(而且看不出错)。T-12 之后台账 runId 的 raw 段就是服务侧
// per-run dag_id(`ex_<uuid>`),任务实例 id 又实测是 `<ex_uuid>_<task_id>_<attempt>` ⇒ 可以**精确**对。
import { beforeEach, describe, expect, it, vi } from "vitest";

const listTaskInstances = vi.fn();
const listWorkflowRuns = vi.fn();
const getWorkflowRun = vi.fn();
const getTaskInstance = vi.fn();
vi.mock("@/lib/scheduler/serverless/workflow-client", () => ({
  listTaskInstances: (...a: unknown[]) => listTaskInstances(...a),
  listWorkflowRuns: (...a: unknown[]) => listWorkflowRuns(...a),
  getWorkflowRun: (...a: unknown[]) => getWorkflowRun(...a),
  getTaskInstance: (...a: unknown[]) => getTaskInstance(...a),
  workflowNameOf: (arn: string) => arn.slice(arn.lastIndexOf("workflow/") + "workflow/".length),
}));

const {
  listServerlessNodeStates,
  mapTaskState,
  resolveServiceRunId,
  runsByProximity,
  taskInstanceBelongsToRun,
} = await import("@/lib/scheduler/serverless/task-logs");

const ARN = "arn:aws:airflow-serverless:us-east-1:1:workflow/bgp_wf1-abc123";
const RAW = "ex_6d5210f0-7c7d-4cca-8f7b-b444bbe6978f";
const LEDGER = { runId: `${RAW}#tgt_use1_a`, startedAt: "2026-09-11T13:14:34.000Z", finishedAt: "2026-09-11T13:17:06.000Z" };

beforeEach(() => {
  listTaskInstances.mockReset();
  listWorkflowRuns.mockReset();
  getWorkflowRun.mockReset();
  getTaskInstance.mockReset();
});

describe("SW-10c 台账 runId 的 raw 段 ↔ 任务实例前缀", () => {
  it("前缀命中才算同一次 run(必须带下划线边界:`ex_a` 不许命中 `ex_ab_t_1`)", () => {
    expect(taskInstanceBelongsToRun(`${RAW}_n1_1`, RAW)).toBe(true);
    expect(taskInstanceBelongsToRun(`${RAW}___start_1`, RAW)).toBe(true);
    expect(taskInstanceBelongsToRun("ex_other_n1_1", RAW)).toBe(false);
    expect(taskInstanceBelongsToRun("ex_ab_t_1", "ex_a"), "少了下划线边界会把别的 run 认成自己").toBe(false);
    expect(taskInstanceBelongsToRun(`${RAW}_n1_1`, ""), "raw 为空时不许瞎命中").toBe(false);
  });

  it("候选按「时间上最近」排序(探测顺序 = 少打几次服务 API)", () => {
    const runs = [
      { RunId: "far", RunDetailSummary: { StartedAt: "2026-09-11T10:00:00Z", EndedAt: "2026-09-11T10:05:00Z" } },
      { RunId: "near", RunDetailSummary: { StartedAt: "2026-09-11T13:14:00Z", EndedAt: "2026-09-11T13:17:10Z" } },
      { RunId: "nodate" },
    ];
    expect(runsByProximity(runs, LEDGER)).toEqual(["near", "far", "nodate"]);
  });

  it("🔴 精确对:第一个候选不含我的实例就继续探下一个(不许拿最近那次当答案)", async () => {
    listWorkflowRuns.mockResolvedValue([
      { RunId: "runB", RunDetailSummary: { StartedAt: "2026-09-11T13:16:00Z", EndedAt: "2026-09-11T13:17:05Z" } },
      { RunId: "runA", RunDetailSummary: { StartedAt: "2026-09-11T13:14:00Z", EndedAt: "2026-09-11T13:17:20Z" } },
    ]);
    listTaskInstances.mockImplementation((_r: string, _a: string, runId: string) =>
      Promise.resolve({ TaskInstances: runId === "runA" ? [{ TaskInstanceId: `${RAW}_n1_1` }] : [{ TaskInstanceId: "ex_zzz_n1_1" }] })
    );
    const r = await resolveServiceRunId({ region: "us-east-1", workflowArn: ARN, ledger: LEDGER });
    expect(r).toEqual({ runId: "runA", how: "exact" });
    expect(listTaskInstances).toHaveBeenCalledTimes(2);
  });

  it("存量行(T-12 之前,没有 raw 段)⇒ 退回时间窗,并如实标 `time-window`", async () => {
    listWorkflowRuns.mockResolvedValue([
      { RunId: "runA", RunDetailSummary: { StartedAt: "2026-09-11T13:14:00Z", EndedAt: "2026-09-11T13:17:20Z" } },
    ]);
    const r = await resolveServiceRunId({
      region: "us-east-1", workflowArn: ARN,
      ledger: { runId: "scheduled__2026-09-07T00:00:00+00:00", startedAt: LEDGER.startedAt, finishedAt: LEDGER.finishedAt },
    });
    expect(r.how).toBe("time-window");
    expect(r.runId).toBe("runA");
    expect(listTaskInstances, "没有 raw 段时不该白探服务 API").not.toHaveBeenCalled();
  });

  it("🔴 一个都对不上 ⇒ `none`(**不许**随便挑一个:那会把别次运行的日志显示成这次的)", async () => {
    listWorkflowRuns.mockResolvedValue([
      { RunId: "runX", RunDetailSummary: { StartedAt: "2026-09-11T01:00:00Z", EndedAt: "2026-09-11T01:05:00Z" } },
    ]);
    listTaskInstances.mockResolvedValue({ TaskInstances: [{ TaskInstanceId: "ex_zzz_n1_1" }] });
    const r = await resolveServiceRunId({ region: "us-east-1", workflowArn: ARN, ledger: LEDGER });
    expect(r).toEqual({ how: "none" });
  });
});

describe("SW-10d 任务状态只认 GetTaskInstance", () => {
  it("🔴 `NONE` 必须译成 skipped(原样显示 none 会被当成「没跑到」)", () => {
    expect(mapTaskState("NONE")).toBe("skipped");
    expect(mapTaskState("SUCCESS")).toBe("success");
    expect(mapTaskState("UPSTREAM_FAILED")).toBe("upstream_failed");
    expect(mapTaskState(undefined)).toBe("no_status");
  });

  it("逐节点状态:TaskId 来自 GetTaskInstance;同一 task 多次尝试只留 attempt 最大的那条", async () => {
    listWorkflowRuns.mockResolvedValue([
      { RunId: "runA", RunDetailSummary: { StartedAt: "2026-09-11T13:14:00Z", EndedAt: "2026-09-11T13:17:20Z" } },
    ]);
    listTaskInstances.mockResolvedValue({
      TaskInstances: [{ TaskInstanceId: `${RAW}_n1_1` }, { TaskInstanceId: `${RAW}_n1_2` }, { TaskInstanceId: `${RAW}___start_1` }],
    });
    getWorkflowRun.mockResolvedValue({ RunType: "SCHEDULED" });
    getTaskInstance.mockImplementation((_r: string, _a: string, _run: string, tid: string) => {
      if (tid.endsWith("_n1_1")) return Promise.resolve({ TaskId: "n1", Status: "QUEUED", AttemptNumber: 1 });
      if (tid.endsWith("_n1_2")) return Promise.resolve({ TaskId: "n1", Status: "FAILED", AttemptNumber: 2, DurationInSeconds: 7 });
      return Promise.resolve({ TaskId: "__start", Status: "SUCCESS", AttemptNumber: 1 });
    });
    const r = await listServerlessNodeStates({ workflowArn: ARN, ledger: LEDGER });
    expect(r.how).toBe("exact");
    expect(r.runType).toBe("SCHEDULED");
    const byId = Object.fromEntries(r.nodes.map((n) => [n.taskId, n]));
    expect(Object.keys(byId).sort()).toEqual(["__start", "n1"]);
    expect(byId.n1.state, "留了停在 QUEUED 的旧尝试 ⇒ 界面显示成「还在跑」").toBe("failed");
    expect(byId.n1.tryNumber).toBe(2);
  });

  it("对不上 run ⇒ 节点列表为空但**如实**带 how=none(调用方据此给人话,而不是显示成没跑)", async () => {
    listWorkflowRuns.mockResolvedValue([]);
    const r = await listServerlessNodeStates({ workflowArn: ARN, ledger: LEDGER });
    expect(r).toEqual({ how: "none", nodes: [] });
  });
});
