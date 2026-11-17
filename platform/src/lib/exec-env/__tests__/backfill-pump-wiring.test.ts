// 🔴 接线:周期循环启动时**真的起了**补数推进泵与告警 / SLA 评估泵,且选主口径与数据面作业泵同一个(「写了 ≠ 接上了」);
//   本副本一接手主副本,三台泵都被叫起来各跑一轮(不各自再等完一个周期)。
//   行为判据:真调 startReconcilerLoop(production 门打开),看泵的启动函数是否被调、isLeader 是否就是本循环的租约判定、
//   真的选主成功之后三台泵交回的句柄是否都被调到。
//   只 mock 三台泵(别的目录;真泵 + 真计时器的那一半在 leader-handover-assembly 与 periodic-loop 两份判据里)与真外部(锁行所在的表)。
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => {
  const kicks: Array<{ pump: string; leaderAtKick: boolean }> = [];
  return {
    backfill: [] as Array<{ isLeader: () => boolean }>,
    alerting: [] as Array<{ isLeader: () => boolean }>,
    dataplane: [] as Array<{ isLeader: () => boolean }>,
    /** 哪台泵被叫了、被叫那一刻它自己的选主口径是什么 */
    kicks,
    /** 泵的启动函数交回的句柄(假泵:只记被叫) */
    handleOf: (pump: string, d: { isLeader: () => boolean }) => ({ kick: () => void kicks.push({ pump, leaderAtKick: d.isLeader() }) }),
    lockWrites: 0,
  };
});
vi.mock("@/lib/backfill/pump", () => ({
  startBackfillPump: (d: { isLeader: () => boolean }) => {
    h.backfill.push(d);
    return h.handleOf("backfill", d);
  },
}));
vi.mock("@/lib/alerting/pump", () => ({
  startAlertingPump: (d: { isLeader: () => boolean }) => {
    h.alerting.push(d);
    return h.handleOf("alerting", d);
  },
}));
vi.mock("@/lib/dataplane-jobs/pump", () => ({
  startDataplaneJobPump: (d: { isLeader: () => boolean }) => {
    h.dataplane.push(d);
    return h.handleOf("dataplane-jobs", d);
  },
}));
// 锁行的条件写:表是空的 ⇒ 第一次抢到,之后每次续上
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    docClient: {
      send: async (c: { constructor: { name: string } }) => {
        if (c.constructor.name !== "UpdateCommand") throw new Error("意料之外的命令:" + c.constructor.name);
        h.lockWrites++;
        return {};
      },
    },
  };
});

/** 打开 production 启动门、换假时钟(循环的计时器不会真到点),跑完复原。 */
async function inProduction<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  const prev = process.env.NODE_ENV;
  (process.env as Record<string, string>).NODE_ENV = "production";
  delete process.env.BGP_RECONCILER_DISABLED;
  try {
    return await fn();
  } finally {
    (process.env as Record<string, string>).NODE_ENV = prev as string;
    vi.useRealTimers();
  }
}

describe("🔴 接线", () => {
  it("startReconcilerLoop ⇒ 三台泵各起一次,isLeader = 本循环的租约判定(未持租约 ⇒ false);还没当选时谁也没被叫", async () => {
    await inProduction(async () => {
      const { startReconcilerLoop, holdsLeaderLease } = await import("@/lib/exec-env/reconciler-loop");
      startReconcilerLoop();
      startReconcilerLoop(); // 幂等
      expect(h.backfill).toHaveLength(1);
      expect(h.dataplane).toHaveLength(1);
      expect(h.backfill[0].isLeader()).toBe(holdsLeaderLease());
      expect(h.backfill[0].isLeader()).toBe(false);
      // 告警 / SLA 评估泵:没接上就是「规则配好了不点按钮永远不告警」(本判据存在的理由)
      expect(h.alerting).toHaveLength(1);
      expect(h.alerting[0].isLeader()).toBe(holdsLeaderLease());
      expect(h.alerting[0].isLeader()).toBe(false);
      expect(h.kicks).toEqual([]);
    });
  });

  it("本副本一接手主副本 ⇒ 三台泵都被叫起来各跑一轮,被叫那一刻泵的选主口径已经为真;之后的续租不再叫", async () => {
    await inProduction(async () => {
      const { startReconcilerLoop, runElectionBeat } = await import("@/lib/exec-env/reconciler-loop");
      startReconcilerLoop(); // 幂等:与上一条共用同一个已启动的循环
      expect(await runElectionBeat()).toBe(true);
      expect(h.lockWrites).toBe(1);
      expect(h.kicks).toEqual([
        { pump: "dataplane-jobs", leaderAtKick: true },
        { pump: "backfill", leaderAtKick: true },
        { pump: "alerting", leaderAtKick: true },
      ]);
      expect(await runElectionBeat()).toBe(true); // 续租
      expect(h.lockWrites).toBe(2);
      expect(h.kicks).toHaveLength(3);
    });
  });
});
