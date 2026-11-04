// B-97(2026-10-18 第三十九轮硬门 s38 70f):发现作业 StartJobRun 撞 Glue 并发上限不许原样 502。
//   CloudTrail 坐实:同一作业 07:32:04Z 起一次(已 SUCCEEDED),07:34:13Z 再起被拒 ConcurrentRunsExceededException —— Glue 的并发计数在
//   上一次运行刚结束后滞后几十秒释放;用户在表刚发现完就点「刷新」就会撞上。
//   只 mock 真外部(Glue 客户端对象,经参数注入);算法 `startRunAdoptingConcurrent` 是唯一作者,`startDiscovery` 必须经它起运行(调用点判据)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { StartJobRunCommand, GetJobRunsCommand } from "@aws-sdk/client-glue";
import { startRunAdoptingConcurrent, isConcurrentRunsExceeded, GLUE_CONCURRENT_RETRY, GLUE_ACTIVE_RUN_STATES } from "@/lib/datasource/glue-reach";

const concurrentErr = () => Object.assign(new Error("Concurrent runs exceeded for bgp-ds-discover-x"), { name: "ConcurrentRunsExceededException" });
const ARGS = { "--result_uri": "s3://b/discover/x/gamedata.json", "--database": "gamedata" };

/** 假 Glue 客户端:按命令类型回放脚本;记下每次 StartJobRun / GetJobRuns 与 sleep。 */
function fakeGlue(plan: { starts: Array<(() => { JobRunId: string }) | (() => never)>; runs?: Array<{ Id: string; JobRunState: string; Arguments?: Record<string, string> }> }) {
  const calls: string[] = [];
  let si = 0;
  const glue = {
    send: async (cmd: unknown) => {
      if (cmd instanceof StartJobRunCommand) {
        calls.push("StartJobRun");
        const step = plan.starts[Math.min(si++, plan.starts.length - 1)];
        return step();
      }
      if (cmd instanceof GetJobRunsCommand) {
        calls.push("GetJobRuns");
        return { JobRuns: plan.runs || [] };
      }
      throw new Error(`unexpected command ${String((cmd as { constructor?: { name?: string } })?.constructor?.name)}`);
    },
  };
  const slept: number[] = [];
  const sleep = async (ms: number) => { slept.push(ms); };
  return { glue, calls, slept, sleep };
}

describe("B-97 StartJobRun 撞并发上限:认领在途运行 / 退避重试 / 其它错误直抛", () => {
  it("撞上 + 有同库在途运行 ⇒ 认领它(adopted=true,jobRunId = 在途那次),不 sleep", async () => {
    const f = fakeGlue({
      starts: [() => { throw concurrentErr(); }],
      runs: [
        { Id: "jr_done", JobRunState: "SUCCEEDED", Arguments: ARGS },
        { Id: "jr_live", JobRunState: "RUNNING", Arguments: ARGS },
      ],
    });
    const r = await startRunAdoptingConcurrent(f.glue, "bgp-ds-discover-x", ARGS, f.sleep);
    expect(r).toEqual({ jobRunId: "jr_live", adopted: true });
    expect(f.calls).toEqual(["StartJobRun", "GetJobRuns"]);
    expect(f.slept).toEqual([]);
  });

  it("撞上 + 在途运行是**别的库** ⇒ 不认领;退避后重起成功(adopted=false)", async () => {
    const f = fakeGlue({
      starts: [() => { throw concurrentErr(); }, () => ({ JobRunId: "jr_new" })],
      runs: [{ Id: "jr_other", JobRunState: "RUNNING", Arguments: { ...ARGS, "--database": "otherdb" } }],
    });
    const r = await startRunAdoptingConcurrent(f.glue, "bgp-ds-discover-x", ARGS, f.sleep);
    expect(r).toEqual({ jobRunId: "jr_new", adopted: false });
    expect(f.slept).toEqual([GLUE_CONCURRENT_RETRY.backoffMs]);
  });

  it("撞上 + 没有在途运行(并发计数滞后)⇒ 退避 backoffMs 再起 ⇒ 第二次成功", async () => {
    const f = fakeGlue({
      starts: [() => { throw concurrentErr(); }, () => ({ JobRunId: "jr_second" })],
      runs: [{ Id: "jr_done", JobRunState: "SUCCEEDED", Arguments: ARGS }],
    });
    const r = await startRunAdoptingConcurrent(f.glue, "bgp-ds-discover-x", ARGS, f.sleep);
    expect(r).toEqual({ jobRunId: "jr_second", adopted: false });
    expect(f.calls).toEqual(["StartJobRun", "GetJobRuns", "StartJobRun"]);
    expect(f.slept).toEqual([GLUE_CONCURRENT_RETRY.backoffMs]);
  });

  it("连续撞满 attempts 次且始终无在途运行 ⇒ 抛出原错误;sleep 恰 attempts-1 次", async () => {
    const f = fakeGlue({ starts: [() => { throw concurrentErr(); }], runs: [] });
    await expect(startRunAdoptingConcurrent(f.glue, "bgp-ds-discover-x", ARGS, f.sleep)).rejects.toMatchObject({ name: "ConcurrentRunsExceededException" });
    expect(f.calls.filter((c) => c === "StartJobRun")).toHaveLength(GLUE_CONCURRENT_RETRY.attempts);
    expect(f.slept).toHaveLength(GLUE_CONCURRENT_RETRY.attempts - 1);
  });

  it("其它错误(如 EntityNotFoundException)⇒ 直接抛,不查在途、不 sleep、不重试", async () => {
    const f = fakeGlue({ starts: [() => { throw Object.assign(new Error("Job not found"), { name: "EntityNotFoundException" }); }], runs: [] });
    await expect(startRunAdoptingConcurrent(f.glue, "bgp-ds-discover-x", ARGS, f.sleep)).rejects.toMatchObject({ name: "EntityNotFoundException" });
    expect(f.calls).toEqual(["StartJobRun"]);
    expect(f.slept).toEqual([]);
  });

  it("错误识别:按 name 或按 Glue 原话;终态不算在途", () => {
    expect(isConcurrentRunsExceeded(concurrentErr())).toBe(true);
    expect(isConcurrentRunsExceeded(new Error("Concurrent runs exceeded for job x"))).toBe(true);
    expect(isConcurrentRunsExceeded(new Error("AccessDeniedException"))).toBe(false);
    for (const s of ["SUCCEEDED", "FAILED", "STOPPED", "TIMEOUT", "ERROR"]) expect(GLUE_ACTIVE_RUN_STATES.has(s)).toBe(false);
    for (const s of ["STARTING", "RUNNING", "STOPPING", "WAITING"]) expect(GLUE_ACTIVE_RUN_STATES.has(s)).toBe(true);
  });
});

describe("B-97 接缝:startDiscovery 起运行**只**经 startRunAdoptingConcurrent(调用点判据,不是 import 判据)", () => {
  const src = readFileSync(resolve(__dirname, "..", "glue-reach.ts"), "utf-8");
  it("glue-reach.ts 里 `new StartJobRunCommand(` 只出现在 startRunAdoptingConcurrent 体内一处", () => {
    const occurrences = src.split("new StartJobRunCommand(").length - 1;
    expect(occurrences).toBe(1);
    const fnStart = src.indexOf("export async function startRunAdoptingConcurrent(");
    const fnEnd = src.indexOf("export async function startDiscovery(");
    expect(fnStart).toBeGreaterThan(0);
    expect(fnEnd).toBeGreaterThan(fnStart);
    expect(src.slice(fnStart, fnEnd)).toContain("new StartJobRunCommand(");
  });
  it("startDiscovery 体内有 `startRunAdoptingConcurrent(glue, jobName` 这个调用点", () => {
    const body = src.slice(src.indexOf("export async function startDiscovery("));
    expect(body).toMatch(/startRunAdoptingConcurrent\(glue,\s*jobName/);
  });
});
