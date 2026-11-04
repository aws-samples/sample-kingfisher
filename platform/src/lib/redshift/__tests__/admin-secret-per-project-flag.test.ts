// `PER_PROJECT_CRED` 这个 flag 的**两态**门禁。
//
// 🔴 用户 2026-09-03 拍板「一笔做完,用 env flag 兜」时明确接受了代价:
// **flag 是永久分叉点,两条身份路径都要长期维护和测试**。
// 那就必须把代价兑现成测试 —— 只测关着的那一态,等于把一条从没跑过的路径放进生产
// (memory `unwired-code-is-unverified`:没生产调用方 = 从未验证过的代码;
//  一条永不执行的分支是同一类东西)。
//
// 本文件钉四件:
//   ① 缺省 **off**,而且只认字面量 `on`(`1`/`true`/`yes` 都不算 —— 免得有人以为开了其实没开,
//      或者反过来:某个环境里恰好有 `PER_PROJECT_CRED=false` 而被 truthy 判成开);
//   ② off 态 = 现网行为**逐字节等价**(打的还是同一个 DescribeSecret,且**不碰**新工厂);
//   ③ on 态 + 有 project = 走 §3.9 的工厂,返回它给的 per-project ARN;
//   ④ on 态 + **没有** project = 仍走 legacy —— 这是**合同规定的**(§3.9 governance-read:
//      「绝不走 lookupProjectSecretArn,它们本无 project ⇒ 会被误判 fail-closed」),不是遗漏。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const smSend = vi.fn();
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    send = (cmd: unknown) => smSend(cmd);
  },
  DescribeSecretCommand: class {
    constructor(public input: { SecretId: string }) {}
  },
}));

const getPrivilegedCred = vi.fn();
vi.mock("@/lib/exec-env/privileged-cred", () => ({ getPrivilegedCred }));

const { getRedshiftSecretArn, perProjectCredEnabled, __resetRedshiftSecretArnCache } = await import(
  "@/lib/redshift/admin-secret"
);

const ADMIN_ARN = "arn:aws:secretsmanager:us-east-1:1:secret:redshift!bgp-namespace-admin-AbCdEf";
const PROJ_ARN = "arn:aws:secretsmanager:us-east-1:1:secret:bgp/project/tgt-home/proj-x-ZzZzZz";
const PROJ = "proj-01M1KP594D2E6DJQC8EZ8CRAES";
const original = process.env.PER_PROJECT_CRED;

beforeEach(() => {
  vi.clearAllMocks();
  __resetRedshiftSecretArnCache();
  delete process.env.PER_PROJECT_CRED;
  smSend.mockResolvedValue({ ARN: ADMIN_ARN });
  getPrivilegedCred.mockResolvedValue({ kind: "project-context", secretArn: PROJ_ARN });
});

afterEach(() => {
  if (original === undefined) delete process.env.PER_PROJECT_CRED;
  else process.env.PER_PROJECT_CRED = original;
});

describe("🔴 ① 缺省 off,且只认字面量 `on`", () => {
  it("env 未设 ⇒ off", () => {
    expect(perProjectCredEnabled()).toBe(false);
  });

  it.each(["", " ", "off", "0", "1", "true", "yes", "ON ", "enabled"])(
    "PER_PROJECT_CRED=%j ⇒ %s",
    (v) => {
      process.env.PER_PROJECT_CRED = v;
      // 只有 trim + 小写后**逐字等于** on 才算开(`"ON "` 会被 trim 成 `ON` ⇒ 开)
      expect(perProjectCredEnabled()).toBe(v.trim().toLowerCase() === "on");
    }
  );

  it("on / On / ON 都算开(大小写不敏感,免得部署脚本大小写不一致)", () => {
    for (const v of ["on", "On", "ON"]) {
      process.env.PER_PROJECT_CRED = v;
      expect(perProjectCredEnabled()).toBe(true);
    }
  });
});

describe("🔴 ② off 态 = 现网逐字节等价", () => {
  it("传了 project 也**只进缓存键**:打的还是 DescribeSecret,拿的还是 admin ARN", async () => {
    const arn = await getRedshiftSecretArn({ project: PROJ });
    expect(arn).toBe(ADMIN_ARN);
    expect(smSend).toHaveBeenCalledTimes(1);
    expect(getPrivilegedCred, "flag 关着却走了新工厂 ⇒ 缺省不再等价").not.toHaveBeenCalled();
  });

  it("非 home 仍然抛并指向 getPrivilegedCred(off 态本函数只管 home)", async () => {
    await expect(getRedshiftSecretArn({ targetId: "tgt_usw2_a" })).rejects.toThrow(/getPrivilegedCred/);
    expect(getPrivilegedCred).not.toHaveBeenCalled();
  });
});

describe("🔴 ③ on 态 + 有 project ⇒ 走 §3.9 工厂", () => {
  beforeEach(() => {
    process.env.PER_PROJECT_CRED = "on";
  });

  it("purpose 写死 project-context,project 原样透传,返回工厂给的 ARN", async () => {
    const arn = await getRedshiftSecretArn({ project: PROJ });
    expect(arn).toBe(PROJ_ARN);
    expect(getPrivilegedCred).toHaveBeenCalledWith("tgt_home", { purpose: "project-context", project: PROJ });
    expect(smSend, "on 态还去打 legacy 的 DescribeSecret ⇒ 两条路径都在跑").not.toHaveBeenCalled();
  });

  it("非 home ⇒ **不再抛**(这正是要打通的那一刀),targetId 原样传给工厂", async () => {
    const arn = await getRedshiftSecretArn({ targetId: "tgt_usw2_a", project: PROJ });
    expect(arn).toBe(PROJ_ARN);
    expect(getPrivilegedCred).toHaveBeenCalledWith("tgt_usw2_a", { purpose: "project-context", project: PROJ });
  });

  it("🔴 工厂抛(如 isolated 缺凭证)⇒ **原样抛**,绝不 catch 回落 admin", async () => {
    getPrivilegedCred.mockRejectedValueOnce(new Error("no per-project credential — refuse (state=isolated)"));
    await expect(getRedshiftSecretArn({ project: PROJ })).rejects.toThrow(/state=isolated/);
    expect(smSend, "回落到 legacy admin ⇒ §3.9b 的状态机被 flag 作废了").not.toHaveBeenCalled();
  });

  it("🔴 工厂返回的形态不是 project-context ⇒ 拒(形态不符不许放行)", async () => {
    getPrivilegedCred.mockResolvedValueOnce({ kind: "governance-read", targetId: "tgt_home", readOnly: true });
    await expect(getRedshiftSecretArn({ project: PROJ })).rejects.toThrow(/形态不符/);
  });
});

describe("🔴 ④ on 态 + 没有 project ⇒ 仍走 legacy(合同规定,不是遗漏)", () => {
  it("治理/指标/质量/敏感扫描那三个调用点就是这一态", async () => {
    process.env.PER_PROJECT_CRED = "on";
    const arn = await getRedshiftSecretArn();
    expect(arn).toBe(ADMIN_ARN);
    expect(smSend).toHaveBeenCalledTimes(1);
    expect(
      getPrivilegedCred,
      "无 project 却走了 lookupProjectSecretArn ⇒ 治理类会被误判 fail-closed(52 P0-3 的失败模式)"
    ).not.toHaveBeenCalled();
  });
});
