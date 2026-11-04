// 等待上下文与唯一轮询原语的判据:无上下文即抛(闸门 ④ 的运行时半边)、op 帧 / 后台帧都放行、未登记 owner 拒、
// 预算到抛 LongOpWaitBudgetExceeded(文案含次数 / 秒数 / 最后状态)、abort、退避口径、ALS 跨 await / Promise.all 保持。
import { describe, it, expect } from "vitest";
import { BACKGROUND_WAITERS, LongOpContextMissing, currentWaitContext, runAsBackgroundWaiter, runInLongOp } from "../context";
import { LongOpAborted, LongOpWaitBudgetExceeded, awaitTerminal } from "../await-terminal";

const noSleep = async () => {};

describe("context", () => {
  it("请求路径(无帧)⇒ currentWaitContext undefined;runInLongOp 内是 op 帧且跨 await / Promise.all 保持;退出后恢复", async () => {
    expect(currentWaitContext()).toBeUndefined();
    await runInLongOp({ taskId: "t1", opKind: "modeling-land" }, async () => {
      expect(currentWaitContext()).toEqual({ kind: "op", taskId: "t1", opKind: "modeling-land" });
      await new Promise((resolve) => setTimeout(resolve, 2));
      const seen = await Promise.all([1, 2].map(async () => { await new Promise((resolve) => setTimeout(resolve, 1)); return currentWaitContext(); }));
      expect(seen.every((frame) => frame?.kind === "op" && frame.taskId === "t1")).toBe(true);
    });
    expect(currentWaitContext()).toBeUndefined();
  });

  it("runAsBackgroundWaiter:登记过的 owner 建后台帧;未登记 ⇒ 抛(不许静默放行)", async () => {
    await runAsBackgroundWaiter("dataplane-jobs-step", async () => {
      expect(currentWaitContext()).toEqual({ kind: "background", owner: "dataplane-jobs-step" });
    });
    expect(() => runAsBackgroundWaiter("rogue" as never, () => 1)).toThrow(/未登记在 BACKGROUND_WAITERS/);
    expect(BACKGROUND_WAITERS).toContain("reconciler-target");
    expect(new Set(BACKGROUND_WAITERS).size).toBe(BACKGROUND_WAITERS.length);
  });
});

describe("awaitTerminal", () => {
  it("🔴 无等待上下文 ⇒ 第一步就抛 LongOpContextMissing(probe 一次都不调)", async () => {
    let probes = 0;
    await expect(awaitTerminal({ what: "观测语句", maxPolls: 3, sleep: noSleep, probe: async () => { probes++; return { done: true, value: 1 }; } })).rejects.toBeInstanceOf(LongOpContextMissing);
    expect(probes).toBe(0);
  });

  it("op 帧 / 后台帧里:probe 到 done 返回 value;done:false 继续;probe 抛原样上抛", async () => {
    const states = ["STARTED", "STARTED", "FINISHED"];
    const out = await runInLongOp({ taskId: "t", opKind: "modeling-land" }, () =>
      awaitTerminal<string>({ what: "观测语句", maxPolls: 10, sleep: noSleep, probe: async () => { const st = states.shift()!; return st === "FINISHED" ? { done: true, value: "ok" } : { done: false, state: st }; } }));
    expect(out).toBe("ok");
    const bg = await runAsBackgroundWaiter("metadata-mirror", () => awaitTerminal<number>({ what: "x", maxPolls: 1, sleep: noSleep, probe: async () => ({ done: true, value: 7 }) }));
    expect(bg).toBe(7);
    await expect(runInLongOp({ taskId: "t", opKind: "k" }, () => awaitTerminal({ what: "x", maxPolls: 2, sleep: noSleep, probe: async () => { throw new Error("语句FAILED"); } }))).rejects.toThrow("语句FAILED");
  });

  it("预算到 ⇒ LongOpWaitBudgetExceeded,文案 = 「<what>超时(轮询 N 次 / s,最后状态 X)」;退避 150 × 1.6 顶 1000", async () => {
    const waits: number[] = [];
    await expect(runInLongOp({ taskId: "t", opKind: "k" }, () =>
      awaitTerminal({ what: "Redshift 语句执行", maxPolls: 7, sleep: async (ms) => { waits.push(ms); }, probe: async () => ({ done: false, state: "STARTED" }) }),
    )).rejects.toSatisfy((e: unknown) => e instanceof LongOpWaitBudgetExceeded && /^Redshift 语句执行超时\(轮询 7 次 \/ [\d.]+s,最后状态 STARTED\)$/.test(e.message));
    expect(waits).toEqual([150, 240, 384, 614, 982, 1000, 1000]);
  });

  it("abortSignal 已 aborted ⇒ 下一轮前抛 LongOpAborted,不再打外部系统", async () => {
    const controller = new AbortController();
    let probes = 0;
    await expect(runInLongOp({ taskId: "t", opKind: "k" }, () =>
      awaitTerminal({ what: "x", maxPolls: 5, sleep: noSleep, abortSignal: controller.signal, probe: async () => { probes++; controller.abort(); return { done: false }; } }),
    )).rejects.toBeInstanceOf(LongOpAborted);
    expect(probes).toBe(1);
  });
});
