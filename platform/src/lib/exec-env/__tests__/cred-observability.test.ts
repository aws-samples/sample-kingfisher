// §3.9b「回落可观测(闭环)」的门禁 —— 那一格明写「🔴 仅 `console.warn` + 进程内 Map **不算**闭环」。
//
// 🔴 这里最重要的一条是**零容忍**:`isolated` 状态下出现回落**必须抛**。
// 它在 `getPrivilegedCred` 里已经有一道 `state === "isolated"` 的拒绝分支,本文件是**第二道**。
// 为什么要两道:本仓已经栽过多次"顺序 bug"(sqlSkeleton 先删注释后 mask、mock 先 SET 后判条件、
// finalize 前置判反……)。如果哪次重构把那个分支挪到了回落之后,只有第二道能立刻炸;
// 只有告警的话,它会安静地发一封邮件然后继续把 admin 交出去。
import { describe, it, expect, vi, beforeEach } from "vitest";

const audits: Array<{ action: string; detail: unknown }> = [];
let auditThrows = false;
vi.mock("@/lib/audit", () => ({
  writeAuditRecord: vi.fn(async (_a: unknown, action: string, opts: { detail?: unknown }) => {
    if (auditThrows) throw new Error("审计表挂了");
    audits.push({ action, detail: opts?.detail });
    return "aid";
  }),
  recordAudit: vi.fn(async () => {}),
}));

const events: Array<{ severity: string; dedupeKey: string; ruleName: string; message: string }> = [];
let alertThrows = false;
vi.mock("@/lib/alerting/events", () => ({
  putEventIfNew: vi.fn(async (ev: { severity: string; dedupeKey: string; ruleName: string; message: string }) => {
    if (alertThrows) throw new Error("告警表挂了");
    events.push(ev);
    return ev;
  }),
}));

const metrics: Array<Record<string, unknown>> = [];
let metricThrows = false;
vi.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: class {
    constructor(public cfg: unknown) {}
    async send(cmd: { input: Record<string, unknown> }) {
      if (metricThrows) throw new Error("cloudwatch 挂了");
      metrics.push(cmd.input);
      return {};
    }
  },
  PutMetricDataCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

const {
  reportCredentialFallback,
  reportProvisioningExpired,
  getCredFallbackCounts,
  getCredObservabilityFailures,
  __resetCredObservability,
  CRED_METRIC_NAMESPACE,
} = await import("@/lib/exec-env/cred-observability");

const BASE = {
  targetId: "tgt_home",
  projectId: "proj-01M1KP594D2E6DJQC8EZ8CRAES",
  purpose: "project-context",
  epoch: 3,
  reason: "no-per-project-secret",
};

beforeEach(() => {
  audits.length = 0;
  events.length = 0;
  metrics.length = 0;
  auditThrows = false;
  alertThrows = false;
  metricThrows = false;
  __resetCredObservability();
});

describe("🔴🔴 零容忍:isolated 状态出现回落 ⇒ P1 告警 + **抛**", () => {
  it("抛,而且抛之前把 P1 告警发出去了(人必须知道)", async () => {
    await expect(reportCredentialFallback({ ...BASE, state: "isolated" })).rejects.toThrow(
      /凭证隔离不变量被破坏/
    );
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe("P1");
    expect(events[0].dedupeKey).toBe(`isolated-fallback#tgt_home#${BASE.projectId}#e3`);
  });

  it("🔴 抛了就**不许**计数成一次「正常回落」(那会让 isolated 的 fallback 指标不再恒为 0)", async () => {
    await reportCredentialFallback({ ...BASE, state: "isolated" }).catch(() => {});
    expect(getCredFallbackCounts(), "isolated 的回落被记成普通回落 ⇒ 指标永久为 0 的宣称就假了").toEqual({});
    expect(metrics).toHaveLength(0);
  });
});

describe("🔴 受控过渡态回落:审计 + 指标 + 告警 三件齐(缺一件就不算闭环)", () => {
  it.each(["legacy-seeded", "provisioning"])("state=%s ⇒ 三件都落地", async (state) => {
    await reportCredentialFallback({ ...BASE, state, provisioningDeadlineAt: "2026-10-01T00:00:00.000Z" });

    // ① 审计:§3.9b 的字段清单逐项在
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("exec-env.credential.fallback");
    expect(audits[0].detail).toMatchObject({
      purpose: "project-context",
      credentialIsolationState: state,
      credentialEpoch: 3,
      provisioningDeadlineAt: "2026-10-01T00:00:00.000Z",
      reason: "no-per-project-secret",
      result: "degraded-to-legacy-admin",
    });
    // 🔴 不记 secret / 口令
    expect(JSON.stringify(audits).toLowerCase()).not.toContain("password");
    expect(JSON.stringify(audits)).not.toContain("arn:aws:secretsmanager");

    // ② 指标:按 target·project(少了维度就没法回答「是哪个项目还在回落」)
    expect(metrics).toHaveLength(1);
    expect(metrics[0].Namespace).toBe(CRED_METRIC_NAMESPACE);
    const md = (metrics[0].MetricData as Array<{ MetricName: string; Dimensions: Array<{ Name: string; Value: string }> }>)[0];
    expect(md.MetricName).toBe("CredentialFallback");
    expect(md.Dimensions.map((d) => d.Name).sort()).toEqual(["IsolationState", "ProjectId", "TargetId"]);

    // ③ 告警(P2:受控过渡但必须收敛)
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe("P2");
    expect(events[0].dedupeKey).toBe(`fallback#tgt_home#${BASE.projectId}#${state}#e3`);
  });

  it("同一世代重复回落 ⇒ 计数累加,但去重键不变(靠 putEventIfNew 幂等,不刷屏)", async () => {
    await reportCredentialFallback({ ...BASE, state: "legacy-seeded" });
    await reportCredentialFallback({ ...BASE, state: "legacy-seeded" });
    expect(getCredFallbackCounts()[`tgt_home#${BASE.projectId}#legacy-seeded#e3`]).toBe(2);
    expect(new Set(events.map((e) => e.dedupeKey)).size).toBe(1);
  });

  it("epoch 变了 ⇒ 去重键跟着变(推进状态后能重新告警,不会被旧事件永久压住)", async () => {
    await reportCredentialFallback({ ...BASE, state: "legacy-seeded", epoch: 3 });
    await reportCredentialFallback({ ...BASE, state: "provisioning", epoch: 4 });
    expect(new Set(events.map((e) => e.dedupeKey)).size).toBe(2);
  });
});

describe("🔴 可观测通道**自己**失效也必须可见(否则等于没有审计)", () => {
  it("审计写失败 ⇒ 吞异常(热路径不打挂),但计数 +1 并额外告警", async () => {
    auditThrows = true;
    await expect(reportCredentialFallback({ ...BASE, state: "legacy-seeded" })).resolves.toBeUndefined();
    expect(getCredObservabilityFailures().audit).toBe(1);
    expect(events.some((e) => e.dedupeKey.startsWith("fallback-audit-failed#")), "审计静默失效了").toBe(true);
  });

  it("指标 / 告警失败 ⇒ 各自计数,且不影响主流程", async () => {
    metricThrows = true;
    alertThrows = true;
    await expect(reportCredentialFallback({ ...BASE, state: "provisioning" })).resolves.toBeUndefined();
    const f = getCredObservabilityFailures();
    expect(f.metric).toBe(1);
    expect(f.alert).toBeGreaterThanOrEqual(1);
  });
});

describe("🔴 provisioning 过期:告警**不能替代**硬拒", () => {
  it("报的是 P1,而且文案里写清了「自此一律拒绝」(拒绝本身在 getPrivilegedCred)", async () => {
    await reportProvisioningExpired({
      targetId: "tgt_usw2_a",
      projectId: BASE.projectId,
      provisioningDeadlineAt: "2026-08-01T00:00:00.000Z",
      epoch: 2,
    });
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe("P1");
    expect(events[0].dedupeKey).toBe("provisioning-expired#tgt_usw2_a#e2");
    expect(events[0].message).toMatch(/一律拒绝/);
  });

  it("告警通道挂了也不抛(拒绝路径不能被告警失败带崩)", async () => {
    alertThrows = true;
    await expect(
      reportProvisioningExpired({ targetId: "tgt_home", projectId: BASE.projectId, epoch: 1 })
    ).resolves.toBeUndefined();
  });
});
