// 2026-11-26 —— 页面「触发一次调度」之后自动跟到这次触发的运行结束(规则 = lib/etl/trigger-follow.ts;调用点 = 离线计算页 doTrigger)。
//
// 【缺陷原形】页面只在触发后第 5 秒重取一次运行历史;调度服务把触发变成运行行要几十秒到一分钟 ⇒ 这次触发的运行行、它的结果与失败原因
//   都要用户自己点「刷新」才看得到;作业列表那一行的状态不跟(定时那次失败了,列表里还写着上一次的「成功」)。
// 变异提示:`scheduledTriggerFollow` 里去掉「不在触发之前的那批里」的过滤 ⇒「老的终态行不算数」红;页面 doTrigger 改回一次性 setTimeout ⇒ 调用点两条红。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scheduledTriggerFollow, TRIGGER_FOLLOW_INFLIGHT, TRIGGER_FOLLOW_INTERVAL_MS, TRIGGER_FOLLOW_MAX_TICKS } from "@/lib/etl/trigger-follow";
import { RUN_INFLIGHT_STATUSES } from "@/lib/monitor/run-groups";

const OLD = [
  { runId: "ex_old1#tgt_home", status: "succeeded" },
  { runId: "manual-1", status: "failed" },
];
const BEFORE = OLD.map((r) => r.runId);

describe("看完了没有:以触发之前的运行行为起点", () => {
  it("在途状态词表与服务端的唯一作者逐项相同(页面不能直接引服务端模块,所以这里钉住)", () => {
    expect([...TRIGGER_FOLLOW_INFLIGHT]).toEqual([...RUN_INFLIGHT_STATUSES]);
  });
  it("还没有新行 ⇒ 继续等(老的终态行不算数 —— 否则触发后第一拍就以为看完了)", () => {
    expect(scheduledTriggerFollow(BEFORE, OLD, 1)).toBe("wait-new");
    expect(scheduledTriggerFollow(BEFORE, [], 1)).toBe("wait-new");
  });
  it("新行出现但还在跑 / 调度器放手而后端可能仍在跑 ⇒ 继续等", () => {
    expect(scheduledTriggerFollow(BEFORE, [{ runId: "ex_new#tgt_home", status: "running" }, ...OLD], 1)).toBe("wait-terminal");
    expect(scheduledTriggerFollow(BEFORE, [{ runId: "ex_new#tgt_home", status: "timeout-pending" }, ...OLD], 1)).toBe("wait-terminal");
  });
  it("新行到了终态(成功 / 失败 / 已停止都算)⇒ 看完了", () => {
    for (const status of ["succeeded", "failed", "stopped"]) {
      expect(scheduledTriggerFollow(BEFORE, [{ runId: "ex_new#tgt_home", status }, ...OLD], 1), status).toBe("done");
    }
  });
  it("触发了两个区:只出现一个区的新行 ⇒ 继续等另一个;两个都结束才算看完", () => {
    const a = { runId: "ex_new#tgt_home", status: "succeeded" };
    const b = { runId: "ex_new#tgt_usw2_a", status: "running" };
    expect(scheduledTriggerFollow(BEFORE, [a, ...OLD], 2)).toBe("wait-new");
    expect(scheduledTriggerFollow(BEFORE, [a, b, ...OLD], 2)).toBe("wait-terminal");
    expect(scheduledTriggerFollow(BEFORE, [a, { ...b, status: "failed" }, ...OLD], 2)).toBe("done");
  });
  it("老的行里有还在跑的不影响判断;没有 runId 的行不算新行;期望数给 0 也至少等一条", () => {
    const oldRunning = [{ runId: "manual-9", status: "running" }];
    expect(scheduledTriggerFollow(["manual-9"], [{ runId: "ex_new#tgt_home", status: "failed" }, ...oldRunning], 1)).toBe("done");
    expect(scheduledTriggerFollow(BEFORE, [{ status: "succeeded" }, { runId: "", status: "succeeded" }, ...OLD], 1)).toBe("wait-new");
    expect(scheduledTriggerFollow(BEFORE, OLD, 0)).toBe("wait-new");
  });
  it("轮询有上限(约 5 分钟),不无限看下去", () => {
    expect(TRIGGER_FOLLOW_INTERVAL_MS * TRIGGER_FOLLOW_MAX_TICKS).toBe(300_000);
  });
});

describe("调用点:离线计算页的「触发一次调度」真的接上了", () => {
  const src = readFileSync(join(process.cwd(), "src/app/etl-jobs/page.tsx"), "utf8");
  const body = (name: string, next: string) => src.slice(src.indexOf(`const ${name} = `), src.indexOf(`const ${next} = `));
  it("doTrigger:起点在发触发请求**之前**读;触发成功后进入跟随,不再是一次性的定时重取", () => {
    const trig = body("doTrigger", "doUnschedule");
    expect(trig.length).toBeGreaterThan(200);
    const iBefore = trig.indexOf("const before: string[] = ((await fetchRunRows(sel.jobId))");
    const iPost = trig.indexOf("/schedule/trigger`");
    expect(iBefore, "没有在触发之前读起点").toBeGreaterThan(-1);
    expect(iBefore).toBeLessThan(iPost);
    expect(trig).toContain("if (okN > 0) followTrigger(sel.jobId, before, okN);");
    expect(trig).not.toContain("setTimeout(");
  });
  it("followTrigger:每一拍按规则判断,看完(或到上限)就停并刷新作业列表;换了作业不把上一条的运行历史画过来", () => {
    const follow = body("followTrigger", "runOrAsk");
    expect(follow.length).toBeGreaterThan(200);
    expect(follow).toContain('scheduledTriggerFollow(before, rows, expected) === "done"');
    expect(follow).toContain("n >= TRIGGER_FOLLOW_MAX_TICKS");
    expect(follow).toContain("TRIGGER_FOLLOW_INTERVAL_MS");
    expect(follow).toMatch(/clearInterval\(pollRef\.current\);\s*fetchJobs\(\);/);
    expect(follow).toContain("if (rows && selIdRef.current === id) setRuns(rows);");
  });
});
