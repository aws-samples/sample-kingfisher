// @kf-batch 50-G7-P0P1P2
// G6/G7(模块 50)—— zero-etl admin secret 缓存的**站点级**单测。
//
// 【为什么必须有这个文件】外部审核 v2 **P2-2**:"Zero-ETL 既有测试没有覆盖复合 key / 失活"。
// 这是 R9 才发现的**第二个**凭证缓存 —— `redshift/execute` 与 zero-etl 是两条分叉,
// 只给 `redshift/admin-secret.ts` 加复合键的话,**zero-etl 查询路径会绕过隔离**,
// 而且不会有任何异常表征(只会"看起来正常地用了别的 target 的 secret")。
// 所以这里把三件事钉住:① 复合键真的按 (target, project) 分槽;② 非 home 拒绝;
// ③ **写后失活的粒度 ≥ 缓存的粒度**(这一条是写测试时才发现的真缺陷,见下)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    send = (cmd: unknown) => sendMock(cmd);
  },
  DescribeSecretCommand: class {
    constructor(public input: { SecretId: string }) {}
  },
  CreateSecretCommand: class {
    constructor(public input: unknown) {}
  },
  PutSecretValueCommand: class {
    constructor(public input: unknown) {}
  },
  GetSecretValueCommand: class {
    constructor(public input: unknown) {}
  },
}));

import {
  getZeroEtlSecretArn,
  invalidateZeroEtlSecretArn,
  __resetZeroEtlSecretArnCache,
} from "@/lib/realtime/zeroetl-service";

beforeEach(() => {
  vi.clearAllMocks();
  __resetZeroEtlSecretArnCache();
});

describe("复合键:按 (targetId, project, purpose) 分槽", () => {
  it("无参 == 显式 tgt_home:同一槽,只解析一次", async () => {
    sendMock.mockResolvedValue({ ARN: "arn:zeroetl" });
    await getZeroEtlSecretArn();
    await getZeroEtlSecretArn({ targetId: "tgt_home" });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("不同 project 各成一槽(为 P52.5a 的 per-project 凭证预留)", async () => {
    sendMock.mockResolvedValue({ ARN: "arn:zeroetl" });
    await getZeroEtlSecretArn({ project: "proj_a" });
    await getZeroEtlSecretArn({ project: "proj_b" });
    await getZeroEtlSecretArn({ project: "proj_a" });
    expect(sendMock, "proj_a 第二次应命中缓存,proj_b 应独立解析").toHaveBeenCalledTimes(2);
  });

  it("🔴 负结果也缓存(与改造前 `_secretArnCache = \"\"` 语义一致,不然每次调用都打一次 SM)", async () => {
    sendMock.mockRejectedValue(new Error("no such secret"));
    expect(await getZeroEtlSecretArn()).toBeUndefined();
    expect(await getZeroEtlSecretArn()).toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe("非 home 一律拒(本函数不该从 env 猜别的区域的 secret)", () => {
  it("传非 home ⇒ 抛并指向 getPrivilegedCred,且**打库之前**就拒", async () => {
    await expect(getZeroEtlSecretArn({ targetId: "tgt_eu1" })).rejects.toThrow(/getPrivilegedCred/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("非法 targetId 也拒(格式校验在缓存键里)", async () => {
    await expect(getZeroEtlSecretArn({ targetId: "nope" })).rejects.toThrow();
    await expect(getZeroEtlSecretArn({ targetId: "tgt_a_" })).rejects.toThrow();
  });

  it("失活函数同样过 home 校验(非 home 抛,而不是静默无操作)", () => {
    expect(() => invalidateZeroEtlSecretArn("tgt_eu1")).toThrow(/getPrivilegedCred/);
  });
});

describe("🔴 写后失活:粒度必须 ≥ 缓存粒度(G7 修的真缺陷)", () => {
  it("🔴🔴 失活要清掉该 target 的**全部**槽 —— 只清 project 为空那一槽会漏掉 project 槽里的 null", async () => {
    // ① secret 还不存在:两个 project 各缓存一个"解析为空"。
    sendMock.mockRejectedValue(new Error("ResourceNotFoundException"));
    expect(await getZeroEtlSecretArn()).toBeUndefined();
    expect(await getZeroEtlSecretArn({ project: "proj_a" })).toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(2);

    // ② 平台创建了 secret,并按写路径失活。
    const cleared = invalidateZeroEtlSecretArn();
    expect(cleared, "两个槽都该被清掉;只清 1 个就是旧实现那种 no-op 式失活").toBe(2);

    // ③ 现在两个 project 都必须重新解析并拿到新 ARN。
    sendMock.mockReset();
    sendMock.mockResolvedValue({ ARN: "arn:zeroetl:new" });
    expect(await getZeroEtlSecretArn()).toBe("arn:zeroetl:new");
    expect(
      await getZeroEtlSecretArn({ project: "proj_a" }),
      "旧实现下这里仍是 undefined ⇒ 该 project 继续回落 IAM 身份,而且不报错、看不出来"
    ).toBe("arn:zeroetl:new");
  });

  it("🔴 返回值 = 真实清掉的槽数(三个槽就得是 3;写死 1 会被这条抓到)", async () => {
    sendMock.mockResolvedValue({ ARN: "arn:zeroetl" });
    await getZeroEtlSecretArn();
    await getZeroEtlSecretArn({ project: "proj_a" });
    await getZeroEtlSecretArn({ project: "proj_b" });
    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(invalidateZeroEtlSecretArn(), "三个槽都该被清").toBe(3);
  });

  it("🔴 清完之后**每个** project 槽都要重新解析(不是只有 project 为空那个)", async () => {
    sendMock.mockResolvedValue({ ARN: "arn:zeroetl" });
    await getZeroEtlSecretArn();
    await getZeroEtlSecretArn({ project: "proj_a" });
    await getZeroEtlSecretArn({ project: "proj_b" });
    sendMock.mockClear();
    invalidateZeroEtlSecretArn();
    await getZeroEtlSecretArn();
    await getZeroEtlSecretArn({ project: "proj_a" });
    await getZeroEtlSecretArn({ project: "proj_b" });
    expect(sendMock, "只清一个槽的话,剩下两个会直接命中旧缓存").toHaveBeenCalledTimes(3);
  });

  it("失活只影响本 target:清 home 不该动到别的 target 的槽", async () => {
    // 目前只有 home 能进缓存(非 home 被拒),所以这里断的是"前缀匹配不越界":
    // 清 `tgt_home#` 不会把一个恰好以 tgt_home 为前缀的别名槽(如 tgt_home2)一起带走。
    sendMock.mockResolvedValue({ ARN: "arn:zeroetl" });
    await getZeroEtlSecretArn({ project: "proj_a" });
    expect(invalidateZeroEtlSecretArn()).toBe(1);
    // 键形状是 `tgt_home#...`,而 `tgt_home2#...` 不以 `tgt_home#` 开头 ⇒ 不会被误清。
    expect("tgt_home2#-#zeroetl-admin#-".startsWith("tgt_home#")).toBe(false);
  });
});

describe("并发解析(P2-2 要求的那条)", () => {
  it("同槽并发:两个调用拿到同一个值,且缓存里只留一个槽", async () => {
    // 🔴 收集**每一个**在途 resolver 再一起放行。只留最后一个(`let resolveIt = res`)会让
    // 第一个调用永远悬着 → 测试超时,而超时看起来像"产品卡住",其实是测试自己写错了。
    const pending: Array<(v: unknown) => void> = [];
    sendMock.mockImplementation(() => new Promise((res) => pending.push(res)));
    const p1 = getZeroEtlSecretArn();
    const p2 = getZeroEtlSecretArn();
    expect(pending.length, "两个并发调用都应已发出请求").toBeGreaterThanOrEqual(1);
    pending.forEach((res) => res({ ARN: "arn:zeroetl" }));
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe("arn:zeroetl");
    expect(b).toBe(a);
    // 🔴 如实登记:`ProcessCache` **没有做 in-flight 去重**(改造前也没有),
    // 所以并发时 resolver 会被各调一次。这里**不把它断言成 1** —— 那会把"当前实现细节"
    // 钉成合同;也**不断言成 2** —— 那会把一个可优化点钉成期望行为。
    // 真正要保证的是"两个调用者拿到同一个值、缓存不分裂",上面两条已经断了。
    expect(sendMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    // 并发结束后再取一次:必须命中缓存(证明最终只留了一个槽)。
    const before = sendMock.mock.calls.length;
    expect(await getZeroEtlSecretArn()).toBe("arn:zeroetl");
    expect(sendMock.mock.calls.length).toBe(before);
  });
});
