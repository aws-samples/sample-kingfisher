// @kf-batch 50-B51-backfill-pump
// 🔴 接线:周期循环启动时**真的起了**补数推进泵,且选主口径与数据面作业泵同一个(「写了 ≠ 接上了」)。
//   行为判据:真调 startReconcilerLoop(production 门打开),看泵的启动函数是否被调、isLeader 是否就是本循环的租约判定。
//   只 mock 两个泵(别的目录);假计时器下循环不会真 tick,注册表 / 探活 / 租约都不会被调用,无需 mock。
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ backfill: [] as Array<{ isLeader: () => boolean }>, dataplane: 0 }));
vi.mock("@/lib/backfill/pump", () => ({ startBackfillPump: (d: { isLeader: () => boolean }) => h.backfill.push(d) }));
vi.mock("@/lib/dataplane-jobs/pump", () => ({ startDataplaneJobPump: () => { h.dataplane++; } }));

describe("🔴 B-51c 接线", () => {
  it("startReconcilerLoop ⇒ 起补数推进泵一次,isLeader = 本循环的租约判定(未持租约 ⇒ false)", async () => {
    vi.useFakeTimers();
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    delete process.env.BGP_RECONCILER_DISABLED;
    try {
      const { startReconcilerLoop, holdsLeaderLease } = await import("@/lib/exec-env/reconciler-loop");
      startReconcilerLoop();
      startReconcilerLoop(); // 幂等
      expect(h.backfill).toHaveLength(1);
      expect(h.dataplane).toBe(1);
      expect(h.backfill[0].isLeader()).toBe(holdsLeaderLease());
      expect(h.backfill[0].isLeader()).toBe(false);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = prev as string;
      vi.useRealTimers();
    }
  });
});
