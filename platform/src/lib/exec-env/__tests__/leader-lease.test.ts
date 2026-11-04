// leader-lease:reconciler 单例选主的 DDB 条件写租约(acquire / renew / steal-on-expiry / release)。
// 🔴 涉网依赖顶层 vi.mock(铁律:动态 import × vi.mock 拦不住)。条件写在 mock 里不被求值 ⇒ 靠 mock 返回/抛错模拟"抢到/被拒"。
import { describe, it, expect, vi, beforeEach } from "vitest";

const updateMock = vi.fn();
const deleteMock = vi.fn();
vi.mock("@/lib/aws/dynamodb", () => ({
  docClient: { send: (cmd: { __kind: string }) => (cmd.__kind === "delete" ? deleteMock(cmd) : updateMock(cmd)) },
  TABLES: { EXECUTION_ENVS: "bgp-execution-envs" },
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  UpdateCommand: class {
    __kind = "update";
    constructor(public input: Record<string, unknown>) {}
  },
  DeleteCommand: class {
    __kind = "delete";
    constructor(public input: Record<string, unknown>) {}
  },
}));

import { acquireOrRenewLeaderLease, releaseLeaderLease, RECONCILER_LEASE_MS } from "@/lib/exec-env/leader-lease";

const ccf = () => Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
const vals = (m: typeof updateMock) => m.mock.calls[0][0].input.ExpressionAttributeValues as Record<string, unknown>;

beforeEach(() => {
  updateMock.mockReset();
  deleteMock.mockReset();
});

describe("leader-lease 选主", () => {
  it("首次抢锁(无 prev)→ 生成新 token,写专用锁行 pk=lock/sk=reconciler,含 acquire 三条件 + 新到期", async () => {
    updateMock.mockResolvedValue({});
    const lease = await acquireOrRenewLeaderLease(null, 1_000_000);
    expect(lease).not.toBeNull();
    expect(typeof lease!.token).toBe("string");
    const cmd = updateMock.mock.calls[0][0].input;
    expect(cmd.Key).toEqual({ pk: "lock", sk: "reconciler" }); // 与 pk="env" 不同分区 ⇒ 对 listTargetsRaw 不可见
    expect(cmd.ConditionExpression).toContain("attribute_not_exists(#tok)");
    expect(cmd.ConditionExpression).toContain("#exp < :now");
    expect(cmd.ConditionExpression).toContain("#tok = :tok");
    expect(vals(updateMock)[":exp"]).toBe(1_000_000 + RECONCILER_LEASE_MS);
    expect(vals(updateMock)[":now"]).toBe(1_000_000);
  });

  it("别的副本持锁未过期 → CCF → 返回 null(本副本本 tick 不当 leader)", async () => {
    updateMock.mockRejectedValue(ccf());
    expect(await acquireOrRenewLeaderLease(null, 1_000_000)).toBeNull();
  });

  it("续租(带 prev)→ 复用同一 token,顶满新到期(sticky leader)", async () => {
    updateMock.mockResolvedValue({});
    const lease = await acquireOrRenewLeaderLease({ token: "tok-abc" }, 2_000_000);
    expect(lease!.token).toBe("tok-abc");
    expect(vals(updateMock)[":tok"]).toBe("tok-abc");
    expect(vals(updateMock)[":exp"]).toBe(2_000_000 + RECONCILER_LEASE_MS);
  });

  it("🔴 非 CCF 错误(权限/网络)照抛,不吞成 null(否则会静默变成'永不当 leader')", async () => {
    updateMock.mockRejectedValue(new Error("AccessDenied"));
    await expect(acquireOrRenewLeaderLease(null, 1)).rejects.toThrow("AccessDenied");
  });

  it("租约时长满足硬约束:TTL + tick(4min)< 15min stale 阈值", () => {
    expect(RECONCILER_LEASE_MS + 4 * 60 * 1000).toBeLessThan(15 * 60 * 1000);
  });

  it("release:条件 token 匹配删锁行;被他人抢走(CCF)静默不抛", async () => {
    deleteMock.mockResolvedValue({});
    await releaseLeaderLease({ token: "t1" });
    const cmd = deleteMock.mock.calls[0][0].input;
    expect(cmd.ConditionExpression).toContain("#tok = :tok");
    expect((cmd.ExpressionAttributeValues as Record<string, unknown>)[":tok"]).toBe("t1");
    deleteMock.mockRejectedValue(ccf());
    await expect(releaseLeaderLease({ token: "t2" })).resolves.toBeUndefined();
  });

  it("release(null)= no-op", async () => {
    await releaseLeaderLease(null);
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
