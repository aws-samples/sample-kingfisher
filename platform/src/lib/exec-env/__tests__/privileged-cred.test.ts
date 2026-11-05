// G2R —— 凭证工厂单测(50 SPEC §3.9 + §3.9b v3.3)。
//
// 【本文件的两条承重】
// ① **admin-ddl 绝不发凭证**(v1 审核 P0-5:旧稿 `return cached(admin)` 把 raw admin secret 交给调用方);
// ② **凭证隔离状态机的 fail-closed 语义**(v2 审核 P0-3)。
//    第 ② 条里最关键的一条是"**状态切换后旧 admin 必须切走**" —— 这正是上一版实测失败的场景:
//    capability 切到就绪后,第二次调用仍返回 `degraded=true` 的旧 admin。现在把它钉成回归测试。
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireReadyTargetMock = vi.fn();
vi.mock("@/lib/exec-env/registry", () => ({
  requireReadyTarget: (...a: unknown[]) => requireReadyTargetMock(...a),
}));

// 🔴 本文件碰到的唯一真外部是 Secrets Manager:project-context 路径按名 DescribeSecret 查 per-project 凭证
// (`project-secret.ts` → `target-clients.describeSecretArnByName`)。以前没 mock ⇒ 在本机拿开发者的真凭证真打 AWS、
// 靠真账号里「没有这个 secret」返回 ResourceNotFoundException 才绿;CI 上没有凭证就红(2026-11-05)。
// 这里把它钉成「确认不存在」:正是这些判据要的前提(没有 per-project 凭证 ⇒ 看状态机决定回落还是拒)。
const smSend = vi.fn(async () => {
  throw Object.assign(new Error("Secrets Manager can't find the specified secret."), { name: "ResourceNotFoundException" });
});
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class { send = smSend; },
  DescribeSecretCommand: class { constructor(public input: unknown) {} },
}));

import {
  getPrivilegedCred,
  getCredDegradationCount,
  requireCredentialIsolationState,
  provisioningExpired,
  __resetCredCache,
  __resetCredDegradation,
  type ProjectContextCred,
  type GovernanceReadIdentity,
} from "@/lib/exec-env/privileged-cred";

const SECRET = "arn:aws:secretsmanager:us-east-1:REDACTED:secret:redshift-admin";
const PID = "proj-01M1KP594D2E6DJQC8EZ8CRAES"; // 真环境形态(大写 ULID),见 project-schema.ts 的订正说明

/** provisioning 的合法未来 deadline / 已过期 deadline —— v3.7 起它参与准入判定。 */
const future = () => new Date(Date.now() + 7 * 86_400_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

function target(over: Record<string, unknown> = {}) {
  return {
    targetId: "tgt_home",
    region: "us-east-1",
    status: "active",
    ready: true,
    resources: { redshiftSecretArn: SECRET },
    credentialIsolationState: "legacy-seeded",
    credentialEpoch: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetCredCache();
  __resetCredDegradation();
  requireReadyTargetMock.mockResolvedValue(target());
});

describe("🔴 admin-ddl 绝不发凭证(v1 审核 P0-5 的反测)", () => {
  it("调用即抛,且错误指向结构化请求 + 闭合执行器", async () => {
    await expect(getPrivilegedCred("tgt_home", { purpose: "admin-ddl" })).rejects.toThrow(
      /闭合执行器|AdminDdlRequest/
    );
  });

  it("🔴 本模块不导出任何返回 Secret 的 admin 路径(§3.9a 要求可断)", async () => {
    const mod = await import("@/lib/exec-env/privileged-cred");
    for (const name of Object.keys(mod)) {
      expect(name, "导出名里出现 admin+secret 组合").not.toMatch(/admin.*secret|secret.*admin/i);
    }
    // 白名单式钉住:新增导出必须在这里显式过一遍(防有人偷偷加回取凭证的口子)。
    expect(Object.keys(mod).sort()).toEqual(
      [
        "__resetCredCache",
        "__resetCredDegradation",
        "getCredDegradationCount",
        "getPrivilegedCred",
        // v3.7 新增:provisioning 窗口是否过期的**纯函数**(不返回任何凭证,只回 boolean)。
        // 白名单必须显式过一遍 —— 这条测试的意义就是让"偷偷加回取凭证的口子"变成一次可见的改动。
        "provisioningExpired",
        "requireCredentialIsolationState",
      ].sort()
    );
  });
});

describe("🔴 凭证隔离状态:缺状态不得解释为 legacy(§3.9b)", () => {
  it("状态字段缺失 ⇒ 拒绝(不是回落 admin)", async () => {
    requireReadyTargetMock.mockResolvedValue(target({ credentialIsolationState: undefined }));
    await expect(
      getPrivilegedCred("tgt_home", { purpose: "project-context", project: PID })
    ).rejects.toThrow(/缺失或未知/);
  });

  it("状态是未知字符串 ⇒ 拒绝", async () => {
    requireReadyTargetMock.mockResolvedValue(target({ credentialIsolationState: "whatever" }));
    await expect(
      getPrivilegedCred("tgt_home", { purpose: "project-context", project: PID })
    ).rejects.toThrow(/缺失或未知/);
  });

  it("epoch 非法(负数/非整数/缺失)⇒ 拒绝", async () => {
    for (const bad of [undefined, -1, 1.5, "0"]) {
      requireReadyTargetMock.mockResolvedValue(target({ credentialEpoch: bad }));
      await expect(
        getPrivilegedCred("tgt_home", { purpose: "project-context", project: PID })
      ).rejects.toThrow(/credentialEpoch 非法/);
    }
  });

  it("🔴 capabilities 与状态判定**无关**(不得再用负向推断决定权限)", () => {
    // 给一个"capabilities 里啥都没有"的 isolated target:仍必须被判为 isolated。
    const iso = requireCredentialIsolationState(
      target({ credentialIsolationState: "isolated", credentialEpoch: 3, capabilities: [] }) as never
    );
    expect(iso).toEqual({ state: "isolated", epoch: 3 });
  });
});

describe("class① project-context", () => {
  it("🔴 缺 projectId ⇒ 直接拒(§3.9b 不接受可选)", async () => {
    await expect(getPrivilegedCred("tgt_home", { purpose: "project-context" })).rejects.toThrow(/projectId/);
  });

  it("legacy-seeded 且无项目凭证 ⇒ 显式回落并标记 degraded + 带状态存证", async () => {
    const c = (await getPrivilegedCred("tgt_home", { purpose: "project-context", project: PID })) as ProjectContextCred;
    expect(c.secretArn).toBe(SECRET);
    expect(c.degradedToLegacyAdmin).toBe(true);
    expect(c.isolation).toEqual({ state: "legacy-seeded", epoch: 0 });
    // 回落的前提「没有 per-project 凭证」必须真的查过 Secrets Manager(不是跳过查找直接回落)
    expect(smSend).toHaveBeenCalled();
  });

  it("provisioning 窗口内同样允许回落(否则供给期业务中断 = 砍功能)", async () => {
    requireReadyTargetMock.mockResolvedValue(
      target({ credentialIsolationState: "provisioning", credentialEpoch: 1, provisioningDeadlineAt: future() })
    );
    const c = (await getPrivilegedCred("tgt_home", { purpose: "project-context", project: PID })) as ProjectContextCred;
    expect(c.degradedToLegacyAdmin).toBe(true);
  });

  it("🔴 isolated 且无项目凭证 ⇒ fail-closed,永不回落", async () => {
    requireReadyTargetMock.mockResolvedValue(target({ credentialIsolationState: "isolated", credentialEpoch: 2 }));
    await expect(
      getPrivilegedCred("tgt_home", { purpose: "project-context", project: PID })
    ).rejects.toThrow(/state=isolated/);
  });

  it("描述符缺 redshiftSecretArn ⇒ 拒(过渡态也必须有实名 secret,不从 env 猜)", async () => {
    requireReadyTargetMock.mockResolvedValue(target({ resources: {} }));
    await expect(
      getPrivilegedCred("tgt_home", { purpose: "project-context", project: PID })
    ).rejects.toThrow(/没有 redshiftSecretArn/);
  });
});

describe("🔴🔴 P0-3 回归:状态切换后旧 admin 必须切走(上一版实测失败的场景)", () => {
  it("legacy-seeded(epoch 0)→ isolated(epoch 1):第二次调用不得再返回旧 admin", async () => {
    requireReadyTargetMock.mockResolvedValue(target({ credentialIsolationState: "legacy-seeded", credentialEpoch: 0 }));
    const first = (await getPrivilegedCred("tgt_home", {
      purpose: "project-context",
      project: PID,
    })) as ProjectContextCred;
    expect(first.degradedToLegacyAdmin, "第一次:过渡期应回落").toBe(true);

    // 完成:状态单调前进 + epoch++
    requireReadyTargetMock.mockResolvedValue(target({ credentialIsolationState: "isolated", credentialEpoch: 1 }));
    await expect(
      getPrivilegedCred("tgt_home", { purpose: "project-context", project: PID }),
      "上一版这里会命中旧缓存、仍返回 degraded=true 的 admin"
    ).rejects.toThrow(/state=isolated/);
  });

  it("🔴 回落结果不进缓存 ⇒ 每次都重新判状态(状态一变立刻生效,不等缓存过期)", async () => {
    await getPrivilegedCred("tgt_home", { purpose: "project-context", project: PID });
    await getPrivilegedCred("tgt_home", { purpose: "project-context", project: PID });
    // 计数 2 说明两次都真的走了判定,而不是第二次命中缓存。
    expect(getCredDegradationCount()).toEqual({ [`tgt_home#${PID}#legacy-seeded#e0`]: 2 });
  });

  it("退化计数带 state 与 epoch(事后能复盘'当时凭什么放行')", async () => {
    requireReadyTargetMock.mockResolvedValue(
      target({ credentialIsolationState: "provisioning", credentialEpoch: 7, provisioningDeadlineAt: future() })
    );
    await getPrivilegedCred("tgt_home", { purpose: "project-context", project: PID });
    expect(Object.keys(getCredDegradationCount())[0]).toContain("provisioning#e7");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 v3.7(外部审核 v4 P1-4):provisioning 的 deadline 必须**参与准入**,不是存着好看
// 上一版只在写侧判"非空",读路径完全不看 ⇒ 过去时间/垃圾串进了 provisioning 就能**无限期**用共享 admin。
// ══════════════════════════════════════════════════════════════════════════════
describe("🔴 provisioning deadline 硬拒(v4 P1-4)", () => {
  it("🔴 deadline 已过期 ⇒ 拒绝回落(与 isolated 同样 fail-closed)", async () => {
    requireReadyTargetMock.mockResolvedValue(
      target({ credentialIsolationState: "provisioning", credentialEpoch: 1, provisioningDeadlineAt: past() })
    );
    await expect(getPrivilegedCred("tgt_home", { purpose: "project-context", project: PID })).rejects.toThrow(
      /provisioning 窗口已过期/
    );
  });

  it("🔴 deadline 缺失 ⇒ 拒(缺 deadline 不得解释为『还在窗口内』)", async () => {
    requireReadyTargetMock.mockResolvedValue(target({ credentialIsolationState: "provisioning", credentialEpoch: 1 }));
    await expect(getPrivilegedCred("tgt_home", { purpose: "project-context", project: PID })).rejects.toThrow(
      /provisioningDeadlineAt 缺失或无法解析/
    );
  });

  it("🔴 deadline 是垃圾串 ⇒ 拒(不是当成新鲜)", async () => {
    requireReadyTargetMock.mockResolvedValue(
      target({ credentialIsolationState: "provisioning", credentialEpoch: 1, provisioningDeadlineAt: "soon" })
    );
    await expect(getPrivilegedCred("tgt_home", { purpose: "project-context", project: PID })).rejects.toThrow(
      /无法解析/
    );
  });

  it("legacy-seeded 不受 deadline 约束(它不是有窗口的过渡态)", async () => {
    requireReadyTargetMock.mockResolvedValue(target({ credentialIsolationState: "legacy-seeded", credentialEpoch: 0 }));
    const c = (await getPrivilegedCred("tgt_home", { purpose: "project-context", project: PID })) as ProjectContextCred;
    expect(c.degradedToLegacyAdmin).toBe(true);
  });

  it("provisioningExpired 纯函数:边界两侧 + 非 provisioning 恒 false", () => {
    const at = new Date(Date.now() + 60_000).toISOString();
    expect(provisioningExpired({ state: "provisioning", epoch: 1, provisioningDeadlineAt: at })).toBe(false);
    expect(provisioningExpired({ state: "provisioning", epoch: 1, provisioningDeadlineAt: at }, Date.parse(at) + 1)).toBe(
      true
    );
    // 🔴 缺/坏 deadline ⇒ 当作已过期(fail-closed 方向,不是"无从判断就放行")
    expect(provisioningExpired({ state: "provisioning", epoch: 1 })).toBe(true);
    expect(provisioningExpired({ state: "legacy-seeded", epoch: 0 })).toBe(false);
    expect(provisioningExpired({ state: "isolated", epoch: 3 })).toBe(false);
  });
});

describe("class② governance-read", () => {
  it("返回只读身份标记,不含任何 secret 字段", async () => {
    const c = (await getPrivilegedCred("tgt_home", { purpose: "governance-read" })) as GovernanceReadIdentity;
    expect(c.kind).toBe("governance-read");
    expect(c.readOnly).toBe(true);
    expect(JSON.stringify(c)).not.toContain("secret");
  });

  it("🔴 不要求 credentialIsolationState(治理类无 project,不该被状态门拦)", async () => {
    requireReadyTargetMock.mockResolvedValue(target({ credentialIsolationState: undefined }));
    await expect(getPrivilegedCred("tgt_home", { purpose: "governance-read" })).resolves.toMatchObject({
      kind: "governance-read",
    });
  });

  it("🔴 缓存按 purpose 分槽:先取 project-context 再取 governance-read 不能串", async () => {
    const a = (await getPrivilegedCred("tgt_home", { purpose: "project-context", project: PID })) as ProjectContextCred;
    expect(a.kind).toBe("project-context");
    const b = await getPrivilegedCred("tgt_home", { purpose: "governance-read", project: PID });
    expect(b.kind, "purpose 维缺失时这里会拿到项目凭证 = 治理身份拿到 admin").toBe("governance-read");
  });
});

describe("fail-closed:目标不可用就不发凭证", () => {
  it("requireReadyTarget 抛 ⇒ 工厂抛(不吞、不兜底)", async () => {
    requireReadyTargetMock.mockRejectedValue(new Error("执行目标不可用:tgt_eu1 —— status=draining"));
    await expect(getPrivilegedCred("tgt_eu1", { purpose: "project-context", project: PID })).rejects.toThrow(/不可用/);
  });

  it("目标校验发生在一切之前", async () => {
    requireReadyTargetMock.mockRejectedValue(new Error("nope"));
    await expect(getPrivilegedCred("tgt_eu1", { purpose: "governance-read" })).rejects.toThrow();
    expect(requireReadyTargetMock).toHaveBeenCalledWith("tgt_eu1");
  });
});
