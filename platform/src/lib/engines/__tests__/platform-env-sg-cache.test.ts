// G6/G7—— EMR 默认 SG id 缓存的**站点级**单测。
//
// 【为什么必须有这个文件】外部审核 v2 **P2-2**:"platform-env 没有站点级缓存测试"。
// 这个站点与另两个凭证缓存不同:它的原语义是"**查到才缓存**、查不到/出错返回 `""` 并下次重试"。
// G6 改造把单值 `_sgIdCache` 换成了按 `locationCacheKey(targetId)` 的复合键缓存,
// 用的是 `peek`/`set` 而不是 `resolve()` —— 因为 `resolve()` 会把**负结果也缓存住**,
// 那样一个短暂的 EC2 抖动就会让整个进程生命周期内都拿不到 SG(行为被悄悄改掉,且没有报错)。
// 这条语义差别不写测试就守不住,所以这里正反两面都钉。
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
vi.mock("@aws-sdk/client-ec2", () => ({
  EC2Client: class {
    send = (cmd: unknown) => sendMock(cmd);
  },
  DescribeSecurityGroupsCommand: class {
    constructor(public input: { Filters?: Array<{ Name: string; Values: string[] }> }) {}
  },
}));

// 子网来自 env(CDK 注入);不设它 getEmrDefaultNetwork 会在第一步就返回 null,测不到 SG 这一段。
process.env.EMR_DEFAULT_SUBNET_IDS = "subnet-aaa,subnet-bbb";

import { getEmrDefaultNetwork, __resetSgIdCache } from "@/lib/engines/platform-env";

beforeEach(() => {
  vi.clearAllMocks();
  __resetSgIdCache();
});

describe("按名解析 SG id + 复合键缓存", () => {
  it("查到 → 返回完整网络,并按 SG 名过滤(不是瞎拿第一个 SG)", async () => {
    sendMock.mockResolvedValue({ SecurityGroups: [{ GroupId: "sg-111" }] });
    await expect(getEmrDefaultNetwork()).resolves.toEqual({
      subnetIds: ["subnet-aaa", "subnet-bbb"],
      securityGroupIds: ["sg-111"],
    });
    const cmd = sendMock.mock.calls[0][0] as { input: { Filters: Array<{ Name: string; Values: string[] }> } };
    expect(cmd.input.Filters[0].Name).toBe("group-name");
    expect(cmd.input.Filters[0].Values[0]).toBe(process.env.EMR_DEFAULT_SG_NAME || "bgp-emr-sg");
  });

  it("正结果缓存:第二次不再打 EC2(SG id 在其生命周期内不变)", async () => {
    sendMock.mockResolvedValue({ SecurityGroups: [{ GroupId: "sg-111" }] });
    await getEmrDefaultNetwork();
    await getEmrDefaultNetwork();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("🔴 负结果**不缓存**:查不到 → 下次仍会重试(改造前 `if (id) _sgIdCache = id` 就是这个语义)", async () => {
    sendMock.mockResolvedValue({ SecurityGroups: [] });
    await expect(getEmrDefaultNetwork()).resolves.toBeNull();
    await expect(getEmrDefaultNetwork()).resolves.toBeNull();
    expect(
      sendMock,
      "若走了 resolve() 把负结果缓存住,一次 EC2 抖动就让整个进程再也拿不到 SG —— 而且不报错"
    ).toHaveBeenCalledTimes(2);
  });

  it("🔴 EC2 抛错 → 返回 null 而不是抛(getEmrDefaultNetwork 依赖'取不到就不带 networkConfiguration')", async () => {
    sendMock.mockRejectedValue(new Error("throttled"));
    await expect(getEmrDefaultNetwork()).resolves.toBeNull();
    // 抖动过去之后必须能恢复 —— 这正是"负结果不缓存"要保住的东西。
    sendMock.mockResolvedValue({ SecurityGroups: [{ GroupId: "sg-222" }] });
    await expect(getEmrDefaultNetwork()).resolves.toMatchObject({ securityGroupIds: ["sg-222"] });
  });

  it("__resetSgIdCache 真的清得掉(排障用,不能是个空壳)", async () => {
    sendMock.mockResolvedValue({ SecurityGroups: [{ GroupId: "sg-111" }] });
    await getEmrDefaultNetwork();
    __resetSgIdCache();
    await getEmrDefaultNetwork();
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("子网 env 为空 → null,且**根本不查 SG**(不凑半套网络)", async () => {
    const saved = process.env.EMR_DEFAULT_SUBNET_IDS;
    process.env.EMR_DEFAULT_SUBNET_IDS = "";
    try {
      await expect(getEmrDefaultNetwork()).resolves.toBeNull();
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      process.env.EMR_DEFAULT_SUBNET_IDS = saved;
    }
  });
});

describe("并发解析(P2-2 要求的那条)", () => {
  it("同槽并发:两个调用拿到同一个 SG,收敛后只留一个槽", async () => {
    const pending: Array<(v: unknown) => void> = [];
    sendMock.mockImplementation(() => new Promise((res) => pending.push(res)));
    const p1 = getEmrDefaultNetwork();
    const p2 = getEmrDefaultNetwork();
    expect(pending.length).toBeGreaterThanOrEqual(1);
    pending.forEach((res) => res({ SecurityGroups: [{ GroupId: "sg-111" }] }));
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toEqual(b);
    expect(a?.securityGroupIds).toEqual(["sg-111"]);
    // 收敛后再取一次必须命中缓存(证明最终只留一个槽,没分裂)。
    const before = sendMock.mock.calls.length;
    await getEmrDefaultNetwork();
    expect(sendMock.mock.calls.length).toBe(before);
  });
});
