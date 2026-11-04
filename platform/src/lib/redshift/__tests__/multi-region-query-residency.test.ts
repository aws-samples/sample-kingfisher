// 直查提交层 × 可审计闭包(SPEC v3.23 §3.2;ACCEPTANCE 提交层单测面):
//   · 跨法域 target:提交**之前**写区域审计,auditId 回到 submission,并作为 Redshift 语句的 StatementName(statement ↔ 审计关联);
//   · 审计写不成 ⇒ **那一个 target 不提交**(errorKind=audit-unavailable),其它 target 照跑;
//   · 缺同意(并发竞态)⇒ errorKind=ack-required,不提交;
//   · home / 同法域:不设 StatementName、不带 auditId —— 存量请求逐字节不变。
// 打桩到 AWS SDK 边界 + residency-audit(它自己的单测在 residency-audit.test.ts)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  sent: [] as Array<Record<string, any>>,
  bindings: {} as Record<string, any>,
  auditMode: "ok" as "ok" | "unavailable" | "ack-required",
  auditCalls: [] as Array<Record<string, any>>,
}));

vi.mock("@aws-sdk/client-redshift-data", () => {
  class ExecuteStatementCommand {
    constructor(public input: any) {}
  }
  return { ExecuteStatementCommand };
});

vi.mock("@/lib/exec-env/target-clients", () => ({
  redshiftDataClientFor: vi.fn((region: string) => ({
    async send(cmd: any) {
      h.sent.push({ region, ...cmd.input });
      return { Id: `stmt-${h.sent.length}` };
    },
  })),
}));

vi.mock("@/lib/exec-env/data-plane-target", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    resolveRedshiftBinding: vi.fn(async (args: { targetId?: string }) => {
      const tid = args.targetId || "tgt_home";
      const b = h.bindings[tid];
      if (!b) throw new (real.TargetBindingRejected as any)("missing-component", `目标 ${tid} 没装 redshift 组件`);
      return { targetId: tid, home: tid === "tgt_home", degradedToLegacyAdmin: true, ...b };
    }),
  };
});

vi.mock("@/lib/security/query-handle", () => ({
  issueHandle: vi.fn(async (args: Record<string, any>) => `handle-${args.targetId}`),
}));

vi.mock("@/lib/realtime/zeroetl-service", () => ({
  ZEROETL_WORKGROUP: "bgp-zeroetl-wg",
  getZeroEtlSecretArn: vi.fn(async () => "arn:zeroetl"),
}));

vi.mock("@/lib/exec-env/residency-audit", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const { AuditUnavailable, ResidencyAckRequired } = await import("@/lib/exec-env/residency");
  return {
    ...real,
    residencyAudit: vi.fn(async (input: Record<string, any>) => {
      h.auditCalls.push(input);
      if (input.knownJurisdiction === "home") return null;
      if (h.auditMode === "unavailable") throw new AuditUnavailable(input.targetId, "region table down");
      if (h.auditMode === "ack-required") throw new ResidencyAckRequired(input.targetId, { version: "v1", text: "T", textHash: "H" });
      return { auditId: `01AUDIT-${input.targetId}`, targetId: input.targetId, jurisdiction: "eu-sim", region: "us-west-2" };
    }),
  };
});

import { submitToTargets } from "@/lib/redshift/multi-region-query";
import type { Identity } from "@/lib/auth/identity";

const HOME = "tgt_home";
const EU = "tgt_usw2_b";
const ID: Identity = { sub: "sub-A", username: "alice", groups: [], isPlatformAdmin: false, isManager: false, isDeveloper: false, demo: false };

beforeEach(() => {
  h.sent = [];
  h.auditCalls = [];
  h.auditMode = "ok";
  h.bindings = {
    [HOME]: { region: "us-east-1", workgroup: "bgp-workgroup", database: "dev", secretArn: "arn:home", jurisdiction: "home" },
    [EU]: { region: "us-west-2", workgroup: "bgp-workgroup-tgt-usw2-b", database: "dev", secretArn: "arn:eu", jurisdiction: "eu-sim" },
  };
});

describe("🔴 跨法域提交:审计在前、auditId 进 submission 与 StatementName;home 一字不变", () => {
  it("home:residencyAudit 以 knownJurisdiction=home 调用 ⇒ 无 auditId、无 StatementName(存量请求逐字节不变)", async () => {
    const [s] = await submitToTargets({ sql: "select 1", targets: [HOME], projectId: "p", identity: ID });
    expect(s.auditId).toBeUndefined();
    expect(h.sent[0].StatementName).toBeUndefined();
    expect(h.auditCalls[0]).toMatchObject({ targetId: HOME, entry: "execute", knownJurisdiction: "home" });
  });
  it("跨法域:审计**先于** ExecuteStatement;auditId 回到 submission 且 == StatementName;审计带 SQL 原文与 projectId", async () => {
    const subs = await submitToTargets({ sql: "select secret from t", targets: [HOME, EU], projectId: "p", identity: ID });
    const eu = subs.find((s) => s.targetId === EU)!;
    expect(eu.auditId).toBe(`01AUDIT-${EU}`);
    expect(eu.statementId).toBeTruthy();
    const euSent = h.sent.find((x) => x.WorkgroupName === "bgp-workgroup-tgt-usw2-b")!;
    expect(euSent.StatementName).toBe(`01AUDIT-${EU}`);
    expect(h.auditCalls.find((c) => c.targetId === EU)).toMatchObject({ entry: "execute", sqlText: "select secret from t", projectId: "p", knownJurisdiction: "eu-sim" });
    // home 那条仍无 StatementName
    expect(h.sent.find((x) => x.WorkgroupName === "bgp-workgroup")!.StatementName).toBeUndefined();
  });
  it("🔴 审计写不成 ⇒ 该 target **不提交**(errorKind=audit-unavailable、无 statementId),home 照跑(提交层)", async () => {
    h.auditMode = "unavailable";
    const subs = await submitToTargets({ sql: "select 1", targets: [HOME, EU], projectId: "p", identity: ID });
    const eu = subs.find((s) => s.targetId === EU)!;
    expect(eu.statementId).toBeUndefined();
    expect(eu.errorKind).toBe("audit-unavailable");
    expect(eu.errorHint).toMatch(/写不成即拒/);
    expect(eu.region).toBe("us-west-2"); // 落点信息仍回给 sheet(排障第一问是「我打到哪了」)
    expect(h.sent.map((x) => x.WorkgroupName)).toEqual(["bgp-workgroup"]);
    expect(subs.find((s) => s.targetId === HOME)!.statementId).toBeTruthy();
  });
  it("缺同意(并发竞态)⇒ errorKind=ack-required、不提交", async () => {
    h.auditMode = "ack-required";
    const [eu] = await submitToTargets({ sql: "select 1", targets: [EU], projectId: "p", identity: ID });
    expect(eu.statementId).toBeUndefined();
    expect(eu.errorKind).toBe("ack-required");
    expect(h.sent).toEqual([]);
  });
});
