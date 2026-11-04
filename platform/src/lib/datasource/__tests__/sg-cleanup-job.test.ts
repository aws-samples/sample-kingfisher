// 序 58 B-130 —— 平台自建安全组持久清理作业的 handler 判据(与 runner 的装配在 app/api/datasources/__tests__/delete-guard-assembly.test.ts)。
//   只 mock 真外部(EC2 / Glue / RDS 客户端工厂);handler ↔ datasource-service(count / delete)之间不 mock。
//   判据:
//     ① 网卡 > 0 且在预算内 ⇒ wait 30 s,**不发 Delete**,证据记 eniCount;
//     ② 网卡 = 0 ⇒ Delete ⇒ succeeded,证据 outcome=deleted;组已不在 ⇒ gone 也算成功(路由同步删成功的常规路径);
//     ③ 网卡 > 0 且入队已超 30 分钟 ⇒ failed,原因点名「需人工」+ sgId + 区,证据 outcome=needs-manual;
//     ④ Describe 与 Delete 之间又挂上网卡(DependencyViolation)⇒ wait,不算失败;
//     ⑤ Describe 读失败 ⇒ retry(可恢复),不是 failed;
//     ⑥ state 缺字段 ⇒ failed(不可恢复);组名不是本源的平台组 ⇒ skipped-not-platform 也收口成功(用户的组一个不碰)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DataplaneJobRow } from "@/lib/dataplane-jobs/model";

const h = vi.hoisted(() => ({
  groups: {} as Record<string, string>, cmds: [] as string[], enis: 0, depFail: false, describeEniError: null as Error | null,
}));
vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real: any = await orig();
  const ec2 = {
    send: async (cmd: any) => {
      const n = cmd.constructor.name;
      if (n === "DescribeNetworkInterfacesCommand") {
        h.cmds.push("enis");
        if (h.describeEniError) throw h.describeEniError;
        return { NetworkInterfaces: Array.from({ length: h.enis }, (_, i) => ({ NetworkInterfaceId: `eni-${i}` })) };
      }
      if (n === "DescribeSecurityGroupsCommand") {
        const id = cmd.input.GroupIds[0];
        h.cmds.push(`describe ${id}`);
        if (!(id in h.groups)) { const e: any = new Error("nf"); e.name = "InvalidGroup.NotFound"; throw e; }
        return { SecurityGroups: [{ GroupId: id, GroupName: h.groups[id] }] };
      }
      if (n === "DeleteSecurityGroupCommand") {
        h.cmds.push(`delete ${cmd.input.GroupId}`);
        if (h.depFail) { const e: any = new Error("has a dependent object"); e.name = "DependencyViolation"; throw e; }
        return {};
      }
      return {};
    },
  };
  return { ...real, ec2ClientFor: async () => ec2, glueClientFor: async () => ({ send: async () => ({}) }), rdsClientFor: async () => ({ send: async () => ({}) }) };
});

import { sgCleanupJobHandler, SG_CLEANUP_WAIT_MS, SG_CLEANUP_BUDGET_MS } from "@/lib/datasource/sg-cleanup-job";

const DSID = "01HXAAAAAAAAAAAAAAAA12345678"; // 平台组名 = bgp-ds-12345678
const T0 = Date.parse("2026-10-28T08:00:00.000Z");
function job(over: Partial<DataplaneJobRow> = {}, state: Record<string, unknown> = { sgId: "sg-plat", region: "us-east-1", datasourceId: DSID }): DataplaneJobRow {
  return {
    jobId: "dpj_test", kind: "sg-cleanup", targetId: "tgt_home", idempotencyKey: "sg-plat:g1", phase: "queued",
    state, progress: { done: 0, total: 1, label: "delete-platform-security-group" }, evidence: {}, attempts: 0, revision: 1,
    nextRunAt: 0, createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), createdBy: "user:t", ...over,
  };
}
const ctx = (j: DataplaneJobRow, nowMs = T0 + 60_000) => ({ job: j, now: () => nowMs, deadline: nowMs + 45_000, sleep: async () => {} });

beforeEach(() => {
  h.cmds.length = 0; h.enis = 0; h.depFail = false; h.describeEniError = null;
  h.groups = { "sg-plat": "bgp-ds-12345678", "sg-cust": "customer-db-access" };
});

describe("🔴 B-130 sg-cleanup handler:按网卡事实收口", () => {
  it("① 网卡 2 张、入队 1 分钟 ⇒ wait 30 s,不发 Delete,证据 eniCount=2", async () => {
    h.enis = 2;
    const r = await sgCleanupJobHandler.step(ctx(job()));
    expect(r.next).toEqual({ kind: "wait", delayMs: SG_CLEANUP_WAIT_MS });
    expect(r.evidence).toMatchObject({ sgId: "sg-plat", region: "us-east-1", eniCount: 2 });
    expect(h.cmds.filter((c) => c.startsWith("delete"))).toHaveLength(0);
  });
  it("② 网卡 0 ⇒ Delete ⇒ succeeded,outcome=deleted,progress 1/1", async () => {
    const r = await sgCleanupJobHandler.step(ctx(job()));
    expect(r.next).toEqual({ kind: "succeeded" });
    expect(r.evidence).toMatchObject({ outcome: "deleted", eniCount: 0 });
    expect(r.progress.done).toBe(1);
    expect(h.cmds).toEqual(["enis", "describe sg-plat", "delete sg-plat"]);
  });
  it("②b 组已不在(路由同步删成功的常规路径)⇒ gone 也是 succeeded", async () => {
    const r = await sgCleanupJobHandler.step(ctx(job({}, { sgId: "sg-nope", region: "us-east-1", datasourceId: DSID })));
    expect(r.next).toEqual({ kind: "succeeded" });
    expect(r.evidence).toMatchObject({ outcome: "gone" });
  });
  it("③ 网卡仍 > 0 且入队已超 30 分钟 ⇒ failed(需人工),点名 sgId 与区,outcome=needs-manual", async () => {
    h.enis = 1;
    const r = await sgCleanupJobHandler.step(ctx(job(), T0 + SG_CLEANUP_BUDGET_MS + 1000));
    expect(r.next.kind).toBe("failed");
    expect((r.next as { reason: string }).reason).toMatch(/需人工/);
    expect((r.next as { reason: string }).reason).toContain("sg-plat");
    expect((r.next as { reason: string }).reason).toContain("us-east-1");
    expect(r.evidence).toMatchObject({ outcome: "needs-manual", eniCount: 1 });
    expect(h.cmds.filter((c) => c.startsWith("delete"))).toHaveLength(0);
  });
  it("④ Describe 后又挂上网卡(Delete 报 DependencyViolation)⇒ wait,不算失败", async () => {
    h.depFail = true;
    const r = await sgCleanupJobHandler.step(ctx(job()));
    expect(r.next).toEqual({ kind: "wait", delayMs: SG_CLEANUP_WAIT_MS });
  });
  it("⑤ Describe 读失败 ⇒ retry(可恢复),不是 failed", async () => {
    h.describeEniError = Object.assign(new Error("throttled"), { name: "RequestLimitExceeded" });
    const r = await sgCleanupJobHandler.step(ctx(job()));
    expect(r.next.kind).toBe("retry");
  });
  it("⑥ state 缺 region ⇒ failed 不可恢复;组名不是本源平台组 ⇒ skipped-not-platform 也收口成功且不发 Delete", async () => {
    const bad = await sgCleanupJobHandler.step(ctx(job({}, { sgId: "sg-plat", datasourceId: DSID })));
    expect(bad.next.kind).toBe("failed");
    const cust = await sgCleanupJobHandler.step(ctx(job({}, { sgId: "sg-cust", region: "us-east-1", datasourceId: DSID })));
    expect(cust.next).toEqual({ kind: "succeeded" });
    expect(cust.evidence).toMatchObject({ outcome: "skipped-not-platform" });
    expect(h.cmds.filter((c) => c === "delete sg-cust")).toHaveLength(0);
  });
});
