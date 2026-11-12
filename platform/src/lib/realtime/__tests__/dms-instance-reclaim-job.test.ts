// DMS 复制实例持久回收作业的 handler 判据(与 runner / 删除路由的装配在 app/api/sync/__tests__/teardown-guard.test.ts)。
//   只 mock 真外部(DMS 客户端工厂、DynamoDB 文档客户端);handler ↔ audit / dataplane-jobs store 之间不 mock。
//   判据:
//     ① 实例已不在(Describe 抛 ResourceNotFoundFault)⇒ succeeded,outcome=gone,**不发 Delete**;
//     ② 实例上仍有复制任务(哪怕全是 stopped)⇒ succeeded,outcome=kept-in-use,**不发 Delete**(停止态任务的 CDC 检查点就在那里);
//     ③ 零任务但有任务停在「启动中」⇒ wait,不发 Delete;超预算仍如此 ⇒ failed 点名需人工;
//     ④ 零任务但实例 modifying ⇒ wait;超预算 ⇒ failed 需人工;deleting ⇒ 只等;
//     ⑤ 零任务、available、未过空闲宽限 ⇒ wait,证据写预计回收时刻 = 入队 + 宽限,不发 Delete;
//     ⑥ 过了宽限 ⇒ DeleteReplicationInstance(带实例 ARN)⇒ succeeded,outcome=deleted,审计一条(系统主体、动作名、实例 id);
//     ⑦ Delete 撞 InvalidResourceStateFault(Describe 与 Delete 之间又挂上任务)⇒ wait,不算失败;
//     ⑧ Describe 读失败(AccessDenied)⇒ retry(可恢复);state 缺字段 ⇒ failed(不可恢复);
//     ⑨ 入队:同实例已有未终态作业 ⇒ 原样返回不新建;终态了 ⇒ 开新的一条(实例会被下一次启动重建);
//     ⑩ 作业种类已登记进闭合清单 / runner / 对外 DTO(对外形态带 instanceId / waitingFor / outcome)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DataplaneJobRow } from "@/lib/dataplane-jobs/model";

const h = vi.hoisted(() => ({
  instance: null as null | { ReplicationInstanceArn: string; ReplicationInstanceStatus: string; ReplicationInstanceClass: string },
  tasks: [] as Array<{ Status: string }>,
  describeError: null as Error | null,
  deleteError: null as Error | null,
  provisioningRows: 0,
  cmds: [] as string[],
  puts: [] as Array<{ table: string; item: Record<string, unknown>; cond?: string }>,
  queryRows: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real: any = await orig();
  const dms = {
    send: async (cmd: any) => {
      const n = cmd.constructor.name;
      h.cmds.push(n);
      if (n === "DescribeReplicationInstancesCommand") {
        if (h.describeError) throw h.describeError;
        if (!h.instance) { const e: any = new Error("not found"); e.name = "ResourceNotFoundFault"; throw e; }
        expect(cmd.input.Filters).toEqual([{ Name: "replication-instance-id", Values: ["bgp-dms"] }]);
        return { ReplicationInstances: [h.instance] };
      }
      if (n === "DescribeReplicationTasksCommand") {
        expect(cmd.input.Filters).toEqual([{ Name: "replication-instance-arn", Values: [h.instance!.ReplicationInstanceArn] }]);
        return { ReplicationTasks: h.tasks };
      }
      if (n === "DeleteReplicationInstanceCommand") {
        expect(cmd.input.ReplicationInstanceArn).toBe(h.instance!.ReplicationInstanceArn);
        if (h.deleteError) throw h.deleteError;
        return {};
      }
      throw new Error(`unexpected ${n}`);
    },
  };
  return { ...real, dmsClientFor: async (region: string) => { h.cmds.push(`client:${region}`); return dms; } };
});
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    docClient: {
      send: async (cmd: any) => {
        const n = cmd.constructor.name;
        if (n === "ScanCommand") {
          expect(cmd.input.TableName).toBe("bgp-sync-tasks");
          expect(cmd.input.FilterExpression).toContain(":prov");
          return { Items: Array.from({ length: h.provisioningRows }, (_, i) => ({ taskId: `t${i}` })) };
        }
        if (n === "PutCommand") {
          h.puts.push({ table: cmd.input.TableName, item: cmd.input.Item, cond: cmd.input.ConditionExpression });
          return {};
        }
        if (n === "QueryCommand") return { Items: h.queryRows };
        if (n === "GetCommand") return {};
        throw new Error(`unexpected ddb ${n}`);
      },
    },
  };
});

import {
  dmsInstanceReclaimJobHandler, enqueueDmsInstanceReclaim,
  DMS_INSTANCE_IDLE_GRACE_MS, DMS_RECLAIM_WAIT_MS, DMS_RECLAIM_BUDGET_MS, DMS_RECLAIM_AUDIT_ACTION, DMS_RECLAIM_ACTOR,
} from "@/lib/realtime/dms-instance-reclaim-job";
import { JOB_KINDS } from "@/lib/dataplane-jobs/schema";
import { toPublicJob } from "@/lib/dataplane-jobs/dto";

const T0 = Date.parse("2026-11-11T08:00:00.000Z");
const ARN = "arn:aws:dms:us-east-1:000000000000:rep:ABCDEFGHIJKLMNOPQRSTUVWXYZ12";
function job(over: Partial<DataplaneJobRow> = {}, state: Record<string, unknown> = { region: "us-east-1", instanceId: "bgp-dms", reason: "task-deleted" }): DataplaneJobRow {
  return {
    jobId: "dpj_test", kind: "dms-instance-reclaim", targetId: "tgt_home", idempotencyKey: "k1", phase: "queued",
    state, progress: { done: 0, total: 1, label: "reclaim-idle-dms-replication-instance" }, evidence: {}, attempts: 0, revision: 1,
    nextRunAt: 0, createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), createdBy: "user:t", ...over,
  };
}
const ctx = (j: DataplaneJobRow, nowMs: number) => ({ job: j, now: () => nowMs, deadline: nowMs + 45_000, sleep: async () => {} });
const available = () => ({ ReplicationInstanceArn: ARN, ReplicationInstanceStatus: "available", ReplicationInstanceClass: "dms.t3.small" });
const AFTER_GRACE = T0 + DMS_INSTANCE_IDLE_GRACE_MS + 1_000;

beforeEach(() => {
  h.instance = available(); h.tasks = []; h.describeError = null; h.deleteError = null; h.provisioningRows = 0;
  h.cmds.length = 0; h.puts.length = 0; h.queryRows = [];
});

describe("DMS 复制实例回收作业:只按事实动手,停止态任务一个不碰", () => {
  it("① 实例已不在 ⇒ succeeded / gone,不发 Delete", async () => {
    h.instance = null;
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.next).toEqual({ kind: "succeeded" });
    expect(r.evidence).toMatchObject({ outcome: "gone", instanceId: "bgp-dms", region: "us-east-1" });
    expect(h.cmds).not.toContain("DeleteReplicationInstanceCommand");
  });

  it("② 实例上仍有复制任务(全是 stopped)⇒ kept-in-use,不发 Delete,证据记任务数", async () => {
    h.tasks = [{ Status: "stopped" }, { Status: "stopped" }];
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.next).toEqual({ kind: "succeeded" });
    expect(r.evidence).toMatchObject({ outcome: "kept-in-use", tasks: 2 });
    expect(String(r.evidence.note)).toContain("保留 CDC 检查点");
    expect(h.cmds).not.toContain("DeleteReplicationInstanceCommand");
  });

  it("②b 实例上只剩「正在删除中」的任务 ⇒ 不是在用:wait 等它消失(真环境删任务 9 秒后入队就撞到);混着 stopped ⇒ 仍 kept-in-use 且只数在用的", async () => {
    h.tasks = [{ Status: "deleting" }];
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.next).toEqual({ kind: "wait", delayMs: DMS_RECLAIM_WAIT_MS });
    expect(r.evidence).toMatchObject({ waitingFor: "task-deleting", deleting: 1, tasks: 0 });
    expect(r.evidence.outcome).toBeUndefined();
    expect(h.cmds).not.toContain("DeleteReplicationInstanceCommand");
    h.tasks = [{ Status: "stopped" }, { Status: "deleting" }];
    const r2 = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r2.next).toEqual({ kind: "succeeded" });
    expect(r2.evidence).toMatchObject({ outcome: "kept-in-use", tasks: 1 });
    // 删除中的任务卡死超预算 ⇒ failed 需人工,不许永远等
    h.tasks = [{ Status: "deleting" }];
    const r3 = await dmsInstanceReclaimJobHandler.step(ctx(job(), T0 + DMS_RECLAIM_BUDGET_MS + 60_000));
    expect(r3.next.kind).toBe("failed");
    expect(r3.evidence).toMatchObject({ outcome: "needs-manual", deleting: 1 });
  });

  it("③ 零任务但有任务停在「启动中」⇒ wait;超预算 ⇒ failed 需人工", async () => {
    h.provisioningRows = 1;
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.next).toEqual({ kind: "wait", delayMs: DMS_RECLAIM_WAIT_MS });
    expect(r.evidence).toMatchObject({ waitingFor: "provisioning-task", provisioning: 1 });
    const late = await dmsInstanceReclaimJobHandler.step(ctx(job(), T0 + DMS_RECLAIM_BUDGET_MS + 60_000));
    expect(late.next.kind).toBe("failed");
    expect((late.next as { reason: string }).reason).toContain("需人工");
    expect(late.evidence).toMatchObject({ outcome: "needs-manual" });
    expect(h.cmds).not.toContain("DeleteReplicationInstanceCommand");
  });

  it("④ 实例 modifying ⇒ wait;超预算 ⇒ failed;deleting ⇒ 只等不判失败", async () => {
    h.instance = { ...available(), ReplicationInstanceStatus: "modifying" };
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.next).toEqual({ kind: "wait", delayMs: DMS_RECLAIM_WAIT_MS });
    expect(r.evidence).toMatchObject({ waitingFor: "instance-available", instanceStatus: "modifying" });
    const late = await dmsInstanceReclaimJobHandler.step(ctx(job(), T0 + DMS_RECLAIM_BUDGET_MS + 60_000));
    expect(late.next.kind).toBe("failed");
    h.instance = { ...available(), ReplicationInstanceStatus: "deleting" };
    const del = await dmsInstanceReclaimJobHandler.step(ctx(job(), T0 + DMS_RECLAIM_BUDGET_MS + 60_000));
    expect(del.next.kind).toBe("wait");
    expect(h.cmds).not.toContain("DeleteReplicationInstanceCommand");
  });

  it("⑤ 零任务、available、未过空闲宽限 ⇒ wait,预计回收时刻 = 入队 + 宽限,不发 Delete", async () => {
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), T0 + 60_000));
    expect(r.next.kind).toBe("wait");
    expect((r.next as { delayMs: number }).delayMs).toBeLessThanOrEqual(DMS_RECLAIM_WAIT_MS);
    expect(r.evidence).toMatchObject({ waitingFor: "idle-grace", tasks: 0, reclaimAt: new Date(T0 + DMS_INSTANCE_IDLE_GRACE_MS).toISOString() });
    expect(h.cmds).not.toContain("DeleteReplicationInstanceCommand");
  });

  it("⑥ 过了宽限 ⇒ Delete(实例 ARN)⇒ succeeded / deleted + 一条系统审计", async () => {
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.next).toEqual({ kind: "succeeded" });
    expect(r.evidence).toMatchObject({ outcome: "deleted", tasks: 0, instanceClass: "dms.t3.small" });
    expect(r.progress).toMatchObject({ done: 1, total: 1 });
    expect(h.cmds.filter((c) => c === "DeleteReplicationInstanceCommand")).toHaveLength(1);
    const audit = h.puts.find((p) => p.table === "bgp-audit");
    expect(audit?.item).toMatchObject({ action: DMS_RECLAIM_AUDIT_ACTION, actor: DMS_RECLAIM_ACTOR, resourceType: "dms-instance", resourceId: "bgp-dms" });
    expect((audit?.item.detail as Record<string, unknown>)).toMatchObject({ region: "us-east-1", reason: "task-deleted", idleMin: expect.any(Number) });
    expect(JSON.stringify(h.puts)).not.toContain("secret");
  });

  it("⑥b 作业落在哪个区就用哪个区的 DMS 客户端", async () => {
    await dmsInstanceReclaimJobHandler.step(ctx(job({}, { region: "us-west-2", instanceId: "bgp-dms", reason: "task-deleted" }), AFTER_GRACE));
    expect(h.cmds[0]).toBe("client:us-west-2");
  });

  it("⑦ Delete 撞 InvalidResourceStateFault ⇒ wait,不算失败", async () => {
    const e: any = new Error("has tasks"); e.name = "InvalidResourceStateFault"; h.deleteError = e;
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.next).toEqual({ kind: "wait", delayMs: DMS_RECLAIM_WAIT_MS });
    expect(r.evidence).toMatchObject({ lastDelete: "invalid-resource-state" });
  });

  it("⑧ Describe 读失败 ⇒ retry(可恢复);state 缺字段 ⇒ failed(不可恢复)", async () => {
    const e: any = new Error("not authorized"); e.name = "AccessDeniedException"; h.describeError = e;
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.next.kind).toBe("retry");
    const bad = await dmsInstanceReclaimJobHandler.step(ctx(job({}, { region: "us-east-1" }), AFTER_GRACE));
    expect(bad.next.kind).toBe("failed");
    expect(h.cmds).not.toContain("DeleteReplicationInstanceCommand");
  });

  it("⑨ 入队:同实例已有未终态作业 ⇒ 原样返回;终态 ⇒ 新建一条(条件写 attribute_not_exists)", async () => {
    h.queryRows = [{ ...job({ jobId: "dpj_inflight", phase: "waiting" }) }];
    const dup = await enqueueDmsInstanceReclaim({ targetId: "tgt_home", region: "us-east-1", instanceId: "bgp-dms", reason: "task-deleted", createdBy: "user:t", now: T0 });
    expect(dup).toEqual({ jobId: "dpj_inflight", created: false, phase: "waiting" });
    expect(h.puts).toHaveLength(0);
    h.queryRows = [{ ...job({ jobId: "dpj_done", phase: "succeeded" }) }];
    const fresh = await enqueueDmsInstanceReclaim({ targetId: "tgt_home", region: "us-east-1", instanceId: "bgp-dms", reason: "start-failed", createdBy: "system:realtime-start", now: T0 + 1 });
    expect(fresh.created).toBe(true);
    expect(fresh.jobId).not.toBe("dpj_done");
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0].cond).toContain("attribute_not_exists(jobId)");
    expect(h.puts[0].item).toMatchObject({ kind: "dms-instance-reclaim", targetId: "tgt_home", phase: "queued", state: { region: "us-east-1", instanceId: "bgp-dms", reason: "start-failed" } });
  });

  it("⑩ 种类已登记进闭合清单;对外 DTO 透出 instanceId / waitingFor / outcome,乱值丢弃", () => {
    expect(JOB_KINDS).toContain("dms-instance-reclaim");
    const pub = toPublicJob(job({ phase: "waiting", evidence: { instanceId: "bgp-dms", region: "us-east-1", waitingFor: "idle-grace", reclaimAt: "2026-11-11T08:10:00.000Z", outcome: "bogus", tasks: 0 } }));
    expect(pub.kind).toBe("dms-instance-reclaim");
    expect(pub.evidence).toEqual({ instanceId: "bgp-dms", region: "us-east-1", waitingFor: "idle-grace", reclaimAt: "2026-11-11T08:10:00.000Z", tasks: 0 });
  });
});
