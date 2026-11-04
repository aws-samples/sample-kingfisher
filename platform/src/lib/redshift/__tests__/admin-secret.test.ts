// @kf-batch 50-G2
// G6(模块 50)—— `getRedshiftSecretArn` 改复合键缓存后的**行为等价**单测。
//
// 【为什么必须有这个测试】这个函数有 **16 处调用表达式、分布 14 个文件**(execute / genbi / etl / 指标 / 质量 / 敏感扫描 …;
// 口径 = `node scripts/ast-count-callsites.mjs getRedshiftSecretArn`,AST 计数。原写 17/15 是 grep 目测的错数,见审核 v2 P2-3)。
// G 批的定义是"零行为变化",而我把它从"进程级单值 `_arn`"改成了复合键缓存 —— 这类改造最容易
// 悄悄改掉两件事:① 负结果还缓不缓存(不缓存 ⇒ 每次调用都打一次 Secrets Manager,延迟与配额都变);
// ② 无参调用是不是还等于从前的 home 路径。两条都不会有编译错误,也不会有功能报错。
// 所以这里把它们钉成不变量。
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    send = (cmd: unknown) => sendMock(cmd);
  },
  DescribeSecretCommand: class {
    constructor(public input: { SecretId: string }) {}
  },
}));

import { getRedshiftSecretArn, __resetRedshiftSecretArnCache } from "@/lib/redshift/admin-secret";

beforeEach(() => {
  vi.clearAllMocks();
  __resetRedshiftSecretArnCache();
});

describe("行为等价:无参调用 == 从前的 home 路径", () => {
  it("按 REDSHIFT_SECRET_ID 查,返回 ARN", async () => {
    sendMock.mockResolvedValue({ ARN: "arn:aws:secretsmanager:us-east-1:REDACTED:secret:x" });
    await expect(getRedshiftSecretArn()).resolves.toBe("arn:aws:secretsmanager:us-east-1:REDACTED:secret:x");
    const cmd = sendMock.mock.calls[0][0] as { input: { SecretId: string } };
    // 默认值与改造前一致(env 未设时 "redshift!bgp-namespace-admin")。
    expect(cmd.input.SecretId).toBe(process.env.REDSHIFT_SECRET_ID || "redshift!bgp-namespace-admin");
  });

  it("解析失败 → undefined(不抛)—— 本地/无密钥环境靠这条回退联邦身份", async () => {
    sendMock.mockRejectedValue(new Error("no such secret"));
    await expect(getRedshiftSecretArn()).resolves.toBeUndefined();
  });

  it("ARN 为空 → undefined", async () => {
    sendMock.mockResolvedValue({ ARN: "" });
    await expect(getRedshiftSecretArn()).resolves.toBeUndefined();
  });

  it("🔴 负结果也缓存:第二次不再打 Secrets Manager(与改造前 `_arn = null` 语义一致)", async () => {
    sendMock.mockRejectedValue(new Error("boom"));
    await getRedshiftSecretArn();
    await getRedshiftSecretArn();
    expect(sendMock, "负结果没缓存 ⇒ 每个调用方每次都打一次 SM,16 处调用会放大成真实配额压力").toHaveBeenCalledTimes(1);
  });

  it("正结果也只解析一次", async () => {
    sendMock.mockResolvedValue({ ARN: "arn:x" });
    await getRedshiftSecretArn();
    await getRedshiftSecretArn();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("显式传 tgt_home 与不传等价(同一缓存槽,不会各解析一次)", async () => {
    sendMock.mockResolvedValue({ ARN: "arn:x" });
    await getRedshiftSecretArn();
    await getRedshiftSecretArn({ targetId: "tgt_home" });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe("非 home 一律拒(本函数不该从 env 猜别的区域的 secret)", () => {
  it("传非 home targetId ⇒ 抛,并指向 getPrivilegedCred", async () => {
    await expect(getRedshiftSecretArn({ targetId: "tgt_eu1" })).rejects.toThrow(/getPrivilegedCred/);
    expect(sendMock, "拒绝要发生在打库之前").not.toHaveBeenCalled();
  });

  it("非法 targetId 也拒(格式校验在缓存键里)", async () => {
    await expect(getRedshiftSecretArn({ targetId: "nope" })).rejects.toThrow();
  });
});

describe("project 维只进缓存键,不改 G 阶段的解析结果", () => {
  it("不同 project 各成一槽(为 P52.5a 的 per-project 凭证预留)", async () => {
    sendMock.mockResolvedValue({ ARN: "arn:x" });
    await getRedshiftSecretArn({ project: "proj_a" });
    await getRedshiftSecretArn({ project: "proj_b" });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("G 阶段两个 project 拿到的仍是同一个(单一 admin secret),不假装已隔离", async () => {
    sendMock.mockResolvedValue({ ARN: "arn:x" });
    expect(await getRedshiftSecretArn({ project: "proj_a" })).toBe("arn:x");
    expect(await getRedshiftSecretArn({ project: "proj_b" })).toBe("arn:x");
  });
});

// 🔴 G7 补(外部审核 v2 P2-2 点名的"并发解析"):这个站点有 16 处调用,
// 同一进程里多个请求同时打进来是常态,不能只测串行。
// 🔴 G7 补(外部审核 v2 P2-2 点名的"两 target / 两 project / 写后失活 / 并发解析")。
//
// ⚠️ **如实登记一条测不了的**:本站点的 resolver 里是 `await import("@aws-sdk/client-secrets-manager")`
// (动态 import,为了不把 SDK 拉进冷启动)。实测:vitest 下**第二个并发的动态 import 会被 mock 注册表拒**,
// 而本函数的 `catch { return null }` 会把它**静默吞成"没有 secret"**。于是"同槽在途并发"这条在本站点
// 用这套 harness **测不出真行为**(第二个调用永远返回 undefined,不是产品行为)。
// ⇒ 处理办法:**在途并发放到 `ProcessCache` 层测**(cred-cache.test.ts,机制就在那儿),
//    本站点只测**串行收敛**与**槽隔离**。另两个站点(zeroetl / platform-env)的 client 是静态 import,
//    在途并发有真测试。**不写一个"看起来在测并发、其实断了个 harness 假象"的用例。**
//
// 附带观察(不在本批修):上面那个吞一切的 `catch` 会把**基础设施层错误**(import 失败/凭证层异常)
// 也当成"没有 secret"并**缓存为负结果**,整个进程生命周期回落联邦身份。这是既有语义
// (文件头写明"解析失败回退调用者联邦身份"),改它会动 home 行为 ⇒ 归 P52.5a 的凭证收口一起看。
describe("并发/多槽(P2-2)", () => {
  it("串行收敛:两次调用只解析一次,且拿到同一个值(槽没分裂)", async () => {
    sendMock.mockResolvedValue({ ARN: "arn:x" });
    const a = await getRedshiftSecretArn();
    const b = await getRedshiftSecretArn();
    expect(a).toBe("arn:x");
    expect(b).toBe(a);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("槽隔离:两个 project 各自解析,互不覆盖", async () => {
    let n = 0;
    sendMock.mockImplementation(() => Promise.resolve({ ARN: `arn:${++n}` }));
    const a = await getRedshiftSecretArn({ project: "proj_a" });
    const b = await getRedshiftSecretArn({ project: "proj_b" });
    // G 阶段两槽解析的是同一个 env secret,值本该相同;这里 mock 故意给不同值,
    // 目的是断**槽没有互相覆盖**(若两槽串了,两次结果会相等)。
    expect(a).not.toBe(b);
    expect(sendMock).toHaveBeenCalledTimes(2);
    // 再取一次 proj_a 必须还是它自己的值(不是被 proj_b 冲掉的)。
    expect(await getRedshiftSecretArn({ project: "proj_a" })).toBe(a);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});
