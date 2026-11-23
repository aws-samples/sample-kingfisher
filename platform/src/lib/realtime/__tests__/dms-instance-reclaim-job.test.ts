// DMS 复制实例持久回收作业的 handler 判据(与 runner / 删除路由的装配在 app/api/sync/__tests__/teardown-guard.test.ts)。
//   只 mock 真外部(DMS 客户端工厂、DynamoDB 文档客户端);handler ↔ 落点解析 / 服务层 / audit / dataplane-jobs store 之间不 mock。
//   假 DMS **按区分桶**(同名对象在两个区互不可见),状态机照真服务写:端点被复制任务引用时删不掉、实例上有任务时删不掉。
//   判据(实例那一侧):
//     ① 实例已不在(Describe 抛 ResourceNotFoundFault)⇒ succeeded,outcome=gone,**不发 Delete**;
//     ② 实例上仍有复制任务(哪怕全是 stopped)⇒ succeeded,outcome=kept-in-use,**不发 Delete**(停止态任务的 CDC 检查点就在那里);
//     ③ 零任务但本区有任务停在「启动中」⇒ wait,不发 Delete;超预算仍如此 ⇒ failed 点名需人工;「在不在本区」按任务绑定判;
//     ④ 零任务但实例 modifying ⇒ wait;超预算 ⇒ failed 需人工;deleting ⇒ 只等;
//     ⑤ 零任务、available、未过空闲宽限 ⇒ wait,证据写预计回收时刻 = 入队 + 宽限,不发 Delete;
//     ⑥ 过了宽限 ⇒ DeleteReplicationInstance(带实例 ARN)⇒ succeeded,outcome=deleted,审计一条(系统主体、动作名、实例 id);
//        执行区的作业:每一个 DMS 调用都打在那个区,主控区的实例一个不碰;
//     ⑦ Delete 撞 InvalidResourceStateFault(Describe 与 Delete 之间又挂上任务)⇒ wait,不算失败;
//     ⑧ Describe 读失败(AccessDenied)⇒ retry(可恢复);state 缺字段 / 与执行环境的落点不一致 ⇒ failed(不可恢复);
//     ⑨ 入队:同实例已有未终态作业 ⇒ 原样返回不新建;终态了 ⇒ 开新的一条(实例会被下一次启动重建);
//     ⑩ 作业种类已登记进闭合清单 / runner / 对外 DTO(对外形态带 instanceId / waitingFor / outcome / 端点清扫结果)。
//   判据(端点那一侧,每一步先做):
//     ⑪ 任务行已删、没有复制任务引用的平台端点 ⇒ 删 + 审计;任务行还在(哪怕停止态)的端点、名字不是平台形态的端点 ⇒ 不碰;
//     ⑫ 还被「删除中」的复制任务引用 ⇒ 不删、作业不收口(记下实例那一侧已有的结论),复制任务消失后的下一步清掉并以原结论收口;
//     ⑬ 任务行没了却还被一条没在删除的复制任务引用 ⇒ 只报告不删;
//     ⑭ 先列端点、后读任务表;任务表要读完才下结论(第二页的任务行也算数;读失败 ⇒ 一个都不删);
//     ⑮ 清扫出错不挡实例回收,但作业不收口;超预算 ⇒ failed 需人工。
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DataplaneJobRow } from "@/lib/dataplane-jobs/model";

interface FakeTask { Status: string; ReplicationInstanceArn: string; SourceEndpointArn: string; TargetEndpointArn: string }
interface FakeRegion {
  instanceId: string;
  instance: null | { ReplicationInstanceArn: string; ReplicationInstanceStatus: string; ReplicationInstanceClass: string };
  tasks: FakeTask[];
  endpoints: Array<{ EndpointIdentifier: string; EndpointArn: string }>;
}

const h = vi.hoisted(() => ({
  regions: {} as Record<string, FakeRegion>,
  describeError: null as Error | null,
  deleteError: null as Error | null,
  endpointsError: null as Error | null,
  deleteEndpointError: null as Error | null,
  /** 只让这一个端点的删除出错(不给 = 每个都出错) */
  deleteEndpointErrorOnly: null as string | null,
  scanError: null as Error | null,
  /** 任务表的每一页(行形态照真落库:新任务只写 `targets[]`,存量任务只有顶层 `targetId` 或两者都没有) */
  scanPages: [[]] as Array<Array<Record<string, unknown>>>,
  /** 注册表行(按 targetId) */
  registry: {} as Record<string, Record<string, unknown>>,
  /** 调用流水:`<区>:<命令名>` / `ddb:<命令名>` */
  calls: [] as string[],
  puts: [] as Array<{ table: string; item: Record<string, unknown>; cond?: string }>,
  queryRows: [] as Record<string, unknown>[],
}));

function fault(name: string, message = name): Error {
  const e = new Error(message) as Error & { name: string };
  e.name = name;
  return e;
}

vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real: any = await orig();
  const clientOf = (region: string) => ({
    send: async (cmd: any) => {
      const n = cmd.constructor.name;
      h.calls.push(`${region}:${n}`);
      const bucket = h.regions[region];
      if (!bucket) throw new Error(`判据没有给 ${region} 准备 DMS 事实`);
      if (n === "DescribeReplicationInstancesCommand") {
        if (h.describeError) throw h.describeError;
        const want = cmd.input.Filters?.[0];
        expect(want?.Name).toBe("replication-instance-id");
        if (!bucket.instance || want.Values[0] !== bucket.instanceId) throw fault("ResourceNotFoundFault", "not found");
        return { ReplicationInstances: [bucket.instance] };
      }
      if (n === "DescribeReplicationTasksCommand") {
        const f = cmd.input.Filters?.[0];
        if (!f) return { ReplicationTasks: bucket.tasks };
        expect(f.Name).toBe("replication-instance-arn");
        return { ReplicationTasks: bucket.tasks.filter((t) => t.ReplicationInstanceArn === f.Values[0]) };
      }
      if (n === "DeleteReplicationInstanceCommand") {
        expect(cmd.input.ReplicationInstanceArn).toBe(bucket.instance!.ReplicationInstanceArn);
        if (h.deleteError) throw h.deleteError;
        if (bucket.tasks.some((t) => t.ReplicationInstanceArn === cmd.input.ReplicationInstanceArn)) throw fault("InvalidResourceStateFault", "instance has tasks");
        bucket.instance = { ...bucket.instance!, ReplicationInstanceStatus: "deleting" };
        return {};
      }
      if (n === "DescribeEndpointsCommand") {
        if (h.endpointsError) throw h.endpointsError;
        return { Endpoints: bucket.endpoints };
      }
      if (n === "DeleteEndpointCommand") {
        const arn = cmd.input.EndpointArn;
        if (h.deleteEndpointError && (!h.deleteEndpointErrorOnly || h.deleteEndpointErrorOnly === arn)) throw h.deleteEndpointError;
        if (!bucket.endpoints.some((e) => e.EndpointArn === arn)) throw fault("ResourceNotFoundFault", "endpoint not found");
        if (bucket.tasks.some((t) => t.SourceEndpointArn === arn || t.TargetEndpointArn === arn)) throw fault("InvalidResourceStateFault", "endpoint is in use");
        bucket.endpoints = bucket.endpoints.filter((e) => e.EndpointArn !== arn);
        return {};
      }
      throw new Error(`unexpected ${n}`);
    },
  });
  return { ...real, dmsClientFor: async (region: string) => clientOf(region) };
});
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    docClient: {
      send: async (cmd: any) => {
        const n = cmd.constructor.name;
        h.calls.push(`ddb:${n}`);
        if (n === "ScanCommand") {
          expect(cmd.input.TableName).toBe("bgp-sync-tasks");
          // 「在不在本区」「是不是启动中」都在代码里按任务绑定判,查询条件里不许另写一份规则(写了就会漏掉只带 targets[] 的新任务)
          expect(cmd.input.FilterExpression).toBeUndefined();
          if (h.scanError) throw h.scanError;
          const page = Number((cmd.input.ExclusiveStartKey as { page?: number } | undefined)?.page ?? 0);
          return { Items: h.scanPages[page] ?? [], ...(page + 1 < h.scanPages.length ? { LastEvaluatedKey: { page: page + 1 } } : {}) };
        }
        if (n === "PutCommand") {
          h.puts.push({ table: cmd.input.TableName, item: cmd.input.Item, cond: cmd.input.ConditionExpression });
          return {};
        }
        if (n === "QueryCommand") return { Items: h.queryRows };
        if (n === "GetCommand") {
          if (cmd.input.TableName === "bgp-execution-envs") {
            expect(cmd.input.Key.pk).toBe("env");
            return { Item: h.registry[cmd.input.Key.sk] };
          }
          return {};
        }
        throw new Error(`unexpected ddb ${n}`);
      },
    },
  };
});

import {
  dmsInstanceReclaimJobHandler, enqueueDmsInstanceReclaim,
  DMS_INSTANCE_IDLE_GRACE_MS, DMS_RECLAIM_WAIT_MS, DMS_RECLAIM_BUDGET_MS, DMS_RECLAIM_AUDIT_ACTION, DMS_RECLAIM_ACTOR,
  DMS_ENDPOINT_SWEEP_AUDIT_ACTION,
} from "@/lib/realtime/dms-instance-reclaim-job";
import { JOB_KINDS } from "@/lib/dataplane-jobs/schema";
import { toPublicJob } from "@/lib/dataplane-jobs/dto";
import { __resetRegionCache } from "@/lib/exec-env/target-region";

const T0 = Date.parse("2026-11-11T08:00:00.000Z");
const HOME = "us-east-1";
const WEST = "us-west-2";
const WEST_TARGET = "tgt_usw2";
const WEST_INSTANCE = "bgp-dms-tgt-usw2";
const instanceArn = (region: string) => `arn:aws:dms:${region}:acct0000000a:rep:ABCDEFGHIJKLMNOPQRSTUVWXYZ12`;
const endpointArn = (region: string, id: string) => `arn:aws:dms:${region}:acct0000000a:endpoint:${id.toUpperCase().replace(/-/g, "")}`;
const ARN = instanceArn(HOME);
const HOME_STATE = { region: HOME, instanceId: "bgp-dms", reason: "task-deleted" };
const WEST_STATE = { region: WEST, instanceId: WEST_INSTANCE, reason: "task-deleted" };

function job(over: Partial<DataplaneJobRow> = {}, state: Record<string, unknown> = HOME_STATE): DataplaneJobRow {
  return {
    jobId: "dpj_test", kind: "dms-instance-reclaim", targetId: "tgt_home", idempotencyKey: "k1", phase: "queued",
    state, progress: { done: 0, total: 1, label: "reclaim-idle-dms-replication-instance" }, evidence: {}, attempts: 0, revision: 1,
    nextRunAt: 0, createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), createdBy: "user:t", ...over,
  };
}
const westJob = (over: Partial<DataplaneJobRow> = {}) => job({ targetId: WEST_TARGET, ...over }, WEST_STATE);
const ctx = (j: DataplaneJobRow, nowMs: number) => ({ job: j, now: () => nowMs, deadline: nowMs + 45_000, sleep: async () => {} });
const available = (region = HOME) => ({ ReplicationInstanceArn: instanceArn(region), ReplicationInstanceStatus: "available", ReplicationInstanceClass: "dms.t3.small" });
const AFTER_GRACE = T0 + DMS_INSTANCE_IDLE_GRACE_MS + 1_000;
const OVER_BUDGET = T0 + DMS_RECLAIM_BUDGET_MS + 60_000;

/** 任务 id(真形态:`sync_` + 26 位)与它在 DMS 里的短名(末 12 位小写去非字母数字)。 */
const TASK_A = "sync_01JCA7M2Q8V4T6N0R3X5Z9B1AA";
const TASK_B = "sync_01JCA7M2Q8V4T6N0R3X5Z9B2BB";
const shortOf = (taskId: string) => taskId.slice(-12).toLowerCase().replace(/[^a-z0-9]/g, "");
const srcId = (taskId: string) => `bgp-src-${shortOf(taskId)}`;
const tgtId = (taskId: string) => `bgp-tgt-${shortOf(taskId)}`;
/** 一条任务的两个平台端点(放进某个区的桶里)。 */
function endpointsOf(region: string, taskId: string) {
  return [srcId(taskId), tgtId(taskId)].map((id) => ({ EndpointIdentifier: id, EndpointArn: endpointArn(region, id) }));
}
/** 一条复制任务(挂在该区的实例上;给了 taskId 就引用那条任务的两个端点)。 */
function repTask(status: string, region = HOME, taskId?: string): FakeTask {
  return {
    Status: status,
    ReplicationInstanceArn: instanceArn(region),
    SourceEndpointArn: endpointArn(region, taskId ? srcId(taskId) : "bgp-src-zzzzzzzzzzzz"),
    TargetEndpointArn: endpointArn(region, taskId ? tgtId(taskId) : "bgp-tgt-zzzzzzzzzzzz"),
  };
}
/** 同步任务表里的一行(新任务只写 `targets[]`)。 */
const taskRow = (taskId: string, status: string, targets: string[] = ["tgt_home"]) => ({ taskId, channel: "dms", status, targets });
const dmsCalls = (region: string) => h.calls.filter((c) => c.startsWith(`${region}:`)).map((c) => c.slice(region.length + 1));
const sweepAudit = () => h.puts.filter((p) => p.table === "bgp-audit" && p.item.action === DMS_ENDPOINT_SWEEP_AUDIT_ACTION);

beforeEach(() => {
  h.regions = {
    [HOME]: { instanceId: "bgp-dms", instance: available(HOME), tasks: [], endpoints: [] },
    [WEST]: { instanceId: WEST_INSTANCE, instance: available(WEST), tasks: [], endpoints: [] },
  };
  h.describeError = null; h.deleteError = null; h.endpointsError = null; h.deleteEndpointError = null; h.deleteEndpointErrorOnly = null; h.scanError = null;
  h.scanPages = [[]];
  h.registry = { [WEST_TARGET]: { pk: "env", sk: WEST_TARGET, targetId: WEST_TARGET, region: WEST, status: "active" } };
  h.calls.length = 0; h.puts.length = 0; h.queryRows = [];
  __resetRegionCache();
});

describe("DMS 复制实例回收作业:只按事实动手,停止态任务一个不碰", () => {
  it("① 实例已不在 ⇒ succeeded / gone,不发 Delete", async () => {
    h.regions[HOME].instance = null;
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.next).toEqual({ kind: "succeeded" });
    expect(r.evidence).toMatchObject({ outcome: "gone", instanceId: "bgp-dms", region: HOME });
    expect(h.calls).not.toContain(`${HOME}:DeleteReplicationInstanceCommand`);
  });

  it("② 实例上仍有复制任务(全是 stopped)⇒ kept-in-use,不发 Delete,证据记任务数", async () => {
    h.regions[HOME].tasks = [repTask("stopped"), repTask("stopped")];
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.next).toEqual({ kind: "succeeded" });
    expect(r.evidence).toMatchObject({ outcome: "kept-in-use", tasks: 2 });
    expect(String(r.evidence.note)).toContain("保留 CDC 检查点");
    expect(h.calls).not.toContain(`${HOME}:DeleteReplicationInstanceCommand`);
  });

  it("②b 实例上只剩「正在删除中」的任务 ⇒ 不是在用:wait 等它消失(真环境删任务 9 秒后入队就撞到);混着 stopped ⇒ 仍 kept-in-use 且只数在用的", async () => {
    h.regions[HOME].tasks = [repTask("deleting")];
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.next).toEqual({ kind: "wait", delayMs: DMS_RECLAIM_WAIT_MS });
    expect(r.evidence).toMatchObject({ waitingFor: "task-deleting", deleting: 1, tasks: 0 });
    expect(r.evidence.outcome).toBeUndefined();
    expect(h.calls).not.toContain(`${HOME}:DeleteReplicationInstanceCommand`);
    h.regions[HOME].tasks = [repTask("stopped"), repTask("deleting")];
    const r2 = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r2.next).toEqual({ kind: "succeeded" });
    expect(r2.evidence).toMatchObject({ outcome: "kept-in-use", tasks: 1 });
    // 删除中的任务卡死超预算 ⇒ failed 需人工,不许永远等
    h.regions[HOME].tasks = [repTask("deleting")];
    const r3 = await dmsInstanceReclaimJobHandler.step(ctx(job(), OVER_BUDGET));
    expect(r3.next.kind).toBe("failed");
    expect(r3.evidence).toMatchObject({ outcome: "needs-manual", deleting: 1 });
  });

  it("③ 零任务但本区有任务停在「启动中」⇒ wait;超预算 ⇒ failed 需人工", async () => {
    h.scanPages = [[taskRow(TASK_A, "provisioning")]];
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.next).toEqual({ kind: "wait", delayMs: DMS_RECLAIM_WAIT_MS });
    expect(r.evidence).toMatchObject({ waitingFor: "provisioning-task", provisioning: 1 });
    const late = await dmsInstanceReclaimJobHandler.step(ctx(job(), OVER_BUDGET));
    expect(late.next.kind).toBe("failed");
    expect((late.next as { reason: string }).reason).toContain("需人工");
    expect(late.evidence).toMatchObject({ outcome: "needs-manual" });
    expect(h.calls).not.toContain(`${HOME}:DeleteReplicationInstanceCommand`);
  });

  it("③b 「启动中」按任务绑定的区算:别的区在启动的任务不挡本区回收;存量行(只有顶层 targetId / 两者都没有)算主控区", async () => {
    // 执行区有一条在启动 ⇒ 主控区的回收照常删
    h.scanPages = [[taskRow(TASK_A, "provisioning", [WEST_TARGET])]];
    const home = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(home.evidence).toMatchObject({ outcome: "deleted" });
    // 同一份任务表,执行区的作业看它就是「本区有任务在启动」⇒ 等
    const west = await dmsInstanceReclaimJobHandler.step(ctx(westJob(), AFTER_GRACE));
    expect(west.next).toEqual({ kind: "wait", delayMs: DMS_RECLAIM_WAIT_MS });
    expect(west.evidence).toMatchObject({ waitingFor: "provisioning-task", provisioning: 1 });
    // 存量行两种形态都算主控区:挡主控区、不挡执行区
    h.regions[HOME].instance = available(HOME);
    h.scanPages = [[
      { taskId: TASK_A, channel: "dms", status: "provisioning", targetId: "tgt_home" },
      { taskId: TASK_B, channel: "dms", status: "provisioning" },
    ]];
    const home2 = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(home2.evidence).toMatchObject({ waitingFor: "provisioning-task", provisioning: 2 });
    const west2 = await dmsInstanceReclaimJobHandler.step(ctx(westJob(), AFTER_GRACE));
    expect(west2.evidence).toMatchObject({ outcome: "deleted" });
    // 不是 DMS 通道的「启动中」不算
    h.regions[HOME].instance = available(HOME);
    h.scanPages = [[{ taskId: TASK_A, channel: "glue", status: "provisioning", targets: ["tgt_home"] }]];
    const home3 = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(home3.evidence).toMatchObject({ outcome: "deleted" });
  });

  it("④ 实例 modifying ⇒ wait;超预算 ⇒ failed;deleting ⇒ 只等不判失败", async () => {
    h.regions[HOME].instance = { ...available(), ReplicationInstanceStatus: "modifying" };
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.next).toEqual({ kind: "wait", delayMs: DMS_RECLAIM_WAIT_MS });
    expect(r.evidence).toMatchObject({ waitingFor: "instance-available", instanceStatus: "modifying" });
    const late = await dmsInstanceReclaimJobHandler.step(ctx(job(), OVER_BUDGET));
    expect(late.next.kind).toBe("failed");
    h.regions[HOME].instance = { ...available(), ReplicationInstanceStatus: "deleting" };
    const del = await dmsInstanceReclaimJobHandler.step(ctx(job(), OVER_BUDGET));
    expect(del.next.kind).toBe("wait");
    expect(h.calls).not.toContain(`${HOME}:DeleteReplicationInstanceCommand`);
  });

  it("⑤ 零任务、available、未过空闲宽限 ⇒ wait,预计回收时刻 = 入队 + 宽限,不发 Delete", async () => {
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), T0 + 60_000));
    expect(r.next.kind).toBe("wait");
    expect((r.next as { delayMs: number }).delayMs).toBeLessThanOrEqual(DMS_RECLAIM_WAIT_MS);
    expect(r.evidence).toMatchObject({ waitingFor: "idle-grace", tasks: 0, reclaimAt: new Date(T0 + DMS_INSTANCE_IDLE_GRACE_MS).toISOString() });
    expect(h.calls).not.toContain(`${HOME}:DeleteReplicationInstanceCommand`);
  });

  it("⑥ 过了宽限 ⇒ Delete(实例 ARN)⇒ succeeded / deleted + 一条系统审计", async () => {
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.next).toEqual({ kind: "succeeded" });
    expect(r.evidence).toMatchObject({ outcome: "deleted", tasks: 0, instanceClass: "dms.t3.small" });
    expect(r.progress).toMatchObject({ done: 1, total: 1 });
    expect(dmsCalls(HOME).filter((c) => c === "DeleteReplicationInstanceCommand")).toHaveLength(1);
    const audit = h.puts.find((p) => p.table === "bgp-audit");
    expect(audit?.item).toMatchObject({ action: DMS_RECLAIM_AUDIT_ACTION, actor: DMS_RECLAIM_ACTOR, resourceType: "dms-instance", resourceId: "bgp-dms" });
    expect((audit?.item.detail as Record<string, unknown>)).toMatchObject({ region: HOME, reason: "task-deleted", idleMin: expect.any(Number) });
    expect(JSON.stringify(h.puts)).not.toContain("secret");
  });

  it("⑥b 执行区的作业:区从注册表按执行环境解析,每一个 DMS 调用都打在那个区;主控区的实例与端点一个不碰", async () => {
    // 两个区各有一台实例、各有一对同一条(已删)任务留下的端点:只清执行区的
    h.regions[HOME].endpoints = endpointsOf(HOME, TASK_A);
    h.regions[WEST].endpoints = endpointsOf(WEST, TASK_A);
    const r = await dmsInstanceReclaimJobHandler.step(ctx(westJob(), AFTER_GRACE));
    expect(r.next).toEqual({ kind: "succeeded" });
    expect(r.evidence).toMatchObject({ outcome: "deleted", instanceId: WEST_INSTANCE, region: WEST, endpointsDeleted: [srcId(TASK_A), tgtId(TASK_A)] });
    expect(dmsCalls(WEST)).toContain("DeleteReplicationInstanceCommand");
    expect(dmsCalls(HOME)).toEqual([]);
    expect(h.regions[HOME].instance?.ReplicationInstanceStatus).toBe("available");
    expect(h.regions[HOME].endpoints).toHaveLength(2);
    expect(h.regions[WEST].endpoints).toHaveLength(0);
    const audit = h.puts.find((p) => p.table === "bgp-audit" && p.item.action === DMS_RECLAIM_AUDIT_ACTION);
    expect(audit?.item).toMatchObject({ resourceId: WEST_INSTANCE });
    expect(audit?.item.detail as Record<string, unknown>).toMatchObject({ region: WEST, targetId: WEST_TARGET });
  });

  it("⑥c 注册表里读不到这个执行环境的区 ⇒ retry,零 DMS 调用(不知道它在哪,就哪个区都不动)", async () => {
    h.registry = {};
    const r = await dmsInstanceReclaimJobHandler.step(ctx(westJob(), AFTER_GRACE));
    expect(r.next.kind).toBe("retry");
    expect(dmsCalls(HOME)).toEqual([]);
    expect(dmsCalls(WEST)).toEqual([]);
  });

  it("⑦ Delete 撞 InvalidResourceStateFault ⇒ wait,不算失败", async () => {
    h.deleteError = fault("InvalidResourceStateFault", "has tasks");
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.next).toEqual({ kind: "wait", delayMs: DMS_RECLAIM_WAIT_MS });
    expect(r.evidence).toMatchObject({ lastDelete: "invalid-resource-state" });
  });

  it("⑧ Describe 读失败 ⇒ retry(可恢复);state 缺字段 ⇒ failed(不可恢复)", async () => {
    h.describeError = fault("AccessDeniedException", "not authorized");
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.next.kind).toBe("retry");
    const bad = await dmsInstanceReclaimJobHandler.step(ctx(job({}, { region: HOME }), AFTER_GRACE));
    expect(bad.next.kind).toBe("failed");
    expect(h.calls).not.toContain(`${HOME}:DeleteReplicationInstanceCommand`);
  });

  it("⑧b 作业记的区 / 实例名与执行环境解析出的落点不一致 ⇒ failed,零 DMS 调用(绝不拿着错的名字去删)", async () => {
    // 执行区的作业却记着主控区的区与实例名
    const wrongRegion = await dmsInstanceReclaimJobHandler.step(ctx(job({ targetId: WEST_TARGET }, HOME_STATE), AFTER_GRACE));
    expect(wrongRegion.next.kind).toBe("failed");
    expect((wrongRegion.next as { reason: string }).reason).toContain("不一致");
    // 区对、实例名不对
    const wrongName = await dmsInstanceReclaimJobHandler.step(ctx(job({ targetId: WEST_TARGET }, { ...WEST_STATE, instanceId: "bgp-dms" }), AFTER_GRACE));
    expect(wrongName.next.kind).toBe("failed");
    expect(dmsCalls(HOME)).toEqual([]);
    expect(dmsCalls(WEST)).toEqual([]);
  });

  it("⑨ 入队:同实例已有未终态作业 ⇒ 原样返回;终态 ⇒ 新建一条(条件写 attribute_not_exists)", async () => {
    h.queryRows = [{ ...job({ jobId: "dpj_inflight", phase: "waiting" }) }];
    const dup = await enqueueDmsInstanceReclaim({ targetId: "tgt_home", region: HOME, instanceId: "bgp-dms", reason: "task-deleted", createdBy: "user:t", now: T0 });
    expect(dup).toEqual({ jobId: "dpj_inflight", created: false, phase: "waiting" });
    expect(h.puts).toHaveLength(0);
    h.queryRows = [{ ...job({ jobId: "dpj_done", phase: "succeeded" }) }];
    const fresh = await enqueueDmsInstanceReclaim({ targetId: "tgt_home", region: HOME, instanceId: "bgp-dms", reason: "start-failed", createdBy: "system:realtime-start", now: T0 + 1 });
    expect(fresh.created).toBe(true);
    expect(fresh.jobId).not.toBe("dpj_done");
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0].cond).toContain("attribute_not_exists(jobId)");
    expect(h.puts[0].item).toMatchObject({ kind: "dms-instance-reclaim", targetId: "tgt_home", phase: "queued", state: { region: HOME, instanceId: "bgp-dms", reason: "start-failed" } });
  });

  it("⑩ 种类已登记进闭合清单;对外 DTO 透出 instanceId / waitingFor / outcome 与端点清扫结果,乱值丢弃", () => {
    expect(JOB_KINDS).toContain("dms-instance-reclaim");
    const pub = toPublicJob(job({ phase: "waiting", evidence: { instanceId: "bgp-dms", region: HOME, waitingFor: "idle-grace", reclaimAt: "2026-11-11T08:10:00.000Z", outcome: "bogus", tasks: 0 } }));
    expect(pub.kind).toBe("dms-instance-reclaim");
    expect(pub.evidence).toEqual({ instanceId: "bgp-dms", region: HOME, waitingFor: "idle-grace", reclaimAt: "2026-11-11T08:10:00.000Z", tasks: 0 });
    // 端点那一侧的证据:两种等待原因、三份清单、出错原因都透出;不像端点标识的值、空清单、私有键(settledOutcome)不出去
    const sweeping = toPublicJob(job({ phase: "waiting", evidence: {
      instanceId: "bgp-dms", region: HOME, waitingFor: "endpoint-in-use", settledOutcome: "kept-in-use",
      endpointsDeleted: [srcId(TASK_A), 7, "has space", "x".repeat(65)], endpointsPending: [tgtId(TASK_A)], endpointsBlocked: [], endpointSweepError: "AccessDenied",
    } }));
    expect(sweeping.evidence).toEqual({
      instanceId: "bgp-dms", region: HOME, waitingFor: "endpoint-in-use",
      endpointsDeleted: [srcId(TASK_A)], endpointsPending: [tgtId(TASK_A)], endpointSweepError: "AccessDenied",
    });
    expect(toPublicJob(job({ evidence: { waitingFor: "endpoint-sweep-retry", endpointsBlocked: [srcId(TASK_B)] } })).evidence)
      .toEqual({ waitingFor: "endpoint-sweep-retry", endpointsBlocked: [srcId(TASK_B)] });
  });
});

describe("回收作业每一步先清扫本区的遗留端点:只删「任务行已经没了、也没有复制任务引用」的平台端点", () => {
  it("⑪ 任务已删的端点被清并记审计;任务行还在(停止态)的端点、名字不是平台形态的端点一个不碰", async () => {
    const custom = { EndpointIdentifier: "customer-mysql-prod", EndpointArn: endpointArn(HOME, "customer-mysql-prod") };
    const lookalike = { EndpointIdentifier: "bgp-src-with-more-parts-than-ours", EndpointArn: endpointArn(HOME, "bgp-src-with-more-parts-than-ours") };
    h.regions[HOME].endpoints = [...endpointsOf(HOME, TASK_A), ...endpointsOf(HOME, TASK_B), custom, lookalike];
    // B 还在(停止态,复制任务也在);A 的任务行与复制任务都已经没了
    h.scanPages = [[taskRow(TASK_B, "stopped")]];
    h.regions[HOME].tasks = [repTask("stopped", HOME, TASK_B)];
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.next).toEqual({ kind: "succeeded" });
    expect(r.evidence).toMatchObject({ outcome: "kept-in-use", tasks: 1, endpointsDeleted: [srcId(TASK_A), tgtId(TASK_A)] });
    expect(r.evidence.endpointsPending).toBeUndefined();
    expect(r.evidence.endpointsBlocked).toBeUndefined();
    expect(h.regions[HOME].endpoints.map((e) => e.EndpointIdentifier)).toEqual([srcId(TASK_B), tgtId(TASK_B), "customer-mysql-prod", "bgp-src-with-more-parts-than-ours"]);
    expect(dmsCalls(HOME).filter((c) => c === "DeleteEndpointCommand")).toHaveLength(2);
    const audits = sweepAudit();
    expect(audits).toHaveLength(1);
    expect(audits[0].item).toMatchObject({ actor: DMS_RECLAIM_ACTOR, resourceType: "dms-endpoint", resourceId: "bgp-dms" });
    expect(audits[0].item.detail as Record<string, unknown>).toMatchObject({ region: HOME, targetId: "tgt_home", endpoints: [srcId(TASK_A), tgtId(TASK_A)], jobId: "dpj_test" });
  });

  it("⑪b 没有遗留端点 ⇒ 不列复制任务全表、不写清扫审计(每一步多出来的只有一次端点清单与一次任务表读取)", async () => {
    h.regions[HOME].endpoints = endpointsOf(HOME, TASK_B);
    h.scanPages = [[taskRow(TASK_B, "running")]];
    h.regions[HOME].tasks = [repTask("running", HOME, TASK_B)];
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.evidence).toMatchObject({ outcome: "kept-in-use", endpointsDeleted: [] });
    expect(dmsCalls(HOME)).toEqual(["DescribeEndpointsCommand", "DescribeReplicationInstancesCommand", "DescribeReplicationTasksCommand"]);
    expect(sweepAudit()).toHaveLength(0);
  });

  it("⑫ 端点还被「删除中」的复制任务引用 ⇒ 不删、作业不收口并记下实例那一侧已有的结论;复制任务消失后的下一步清掉、以原结论收口,实例那一侧不重判", async () => {
    // 删掉任务 A(行已删、复制任务在 DMS 里消失中);B 还在这台实例上
    h.regions[HOME].endpoints = [...endpointsOf(HOME, TASK_A), ...endpointsOf(HOME, TASK_B)];
    h.scanPages = [[taskRow(TASK_B, "stopped")]];
    h.regions[HOME].tasks = [repTask("deleting", HOME, TASK_A), repTask("stopped", HOME, TASK_B)];
    const first = await dmsInstanceReclaimJobHandler.step(ctx(job(), T0 + 9_000));
    expect(first.next).toEqual({ kind: "wait", delayMs: DMS_RECLAIM_WAIT_MS });
    expect(first.evidence).toMatchObject({
      settledOutcome: "kept-in-use", waitingFor: "endpoint-in-use",
      endpointsPending: [srcId(TASK_A), tgtId(TASK_A)], endpointsDeleted: [],
    });
    expect(first.progress).toMatchObject({ done: 0 });
    expect(dmsCalls(HOME)).not.toContain("DeleteEndpointCommand");
    expect(h.regions[HOME].endpoints).toHaveLength(4);
    // 下一步:复制任务 A 已从 DMS 消失
    h.calls.length = 0;
    h.regions[HOME].tasks = [repTask("stopped", HOME, TASK_B)];
    const second = await dmsInstanceReclaimJobHandler.step(ctx(job({ phase: "waiting", evidence: first.evidence }), T0 + 70_000));
    expect(second.next).toEqual({ kind: "succeeded" });
    expect(second.evidence).toMatchObject({ outcome: "kept-in-use", tasks: 1, endpointsDeleted: [srcId(TASK_A), tgtId(TASK_A)] });
    expect(second.evidence.settledOutcome).toBeUndefined();
    expect(second.evidence.waitingFor).toBeUndefined();
    expect(second.evidence.endpointsPending).toBeUndefined();
    expect(second.progress).toMatchObject({ done: 1 });
    expect(h.regions[HOME].endpoints.map((e) => e.EndpointIdentifier)).toEqual([srcId(TASK_B), tgtId(TASK_B)]);
    expect(dmsCalls(HOME)).not.toContain("DescribeReplicationInstancesCommand");
    expect(sweepAudit()).toHaveLength(1);
  });

  it("⑫b 列复制任务时没看到引用、去删时 DMS 说端点仍在用(两次读取之间挂上了引用)⇒ 当作待清,下一步再看,不算失败", async () => {
    h.regions[HOME].endpoints = endpointsOf(HOME, TASK_A);
    h.regions[HOME].instance = null;
    h.deleteEndpointError = fault("InvalidResourceStateFault", "endpoint is in use by a replication task");
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.next).toEqual({ kind: "wait", delayMs: DMS_RECLAIM_WAIT_MS });
    expect(r.evidence).toMatchObject({ settledOutcome: "gone", waitingFor: "endpoint-in-use", endpointsPending: [srcId(TASK_A), tgtId(TASK_A)], endpointsDeleted: [] });
    expect(h.regions[HOME].endpoints).toHaveLength(2);
    expect(sweepAudit()).toHaveLength(0);
    // 去删时端点已经没了(别人先删了)⇒ 算清掉;其它错(没权限)⇒ 这一步的清扫记为出错,等着重试
    h.deleteEndpointError = fault("ResourceNotFoundFault", "endpoint not found");
    const gone = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(gone.next).toEqual({ kind: "succeeded" });
    expect(gone.evidence).toMatchObject({ outcome: "gone", endpointsDeleted: [srcId(TASK_A), tgtId(TASK_A)] });
    h.deleteEndpointError = fault("AccessDeniedException", "not authorized to perform dms:DeleteEndpoint");
    const denied = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(denied.next).toEqual({ kind: "wait", delayMs: DMS_RECLAIM_WAIT_MS });
    expect(denied.evidence).toMatchObject({ settledOutcome: "gone", waitingFor: "endpoint-sweep-retry", endpointSweepError: expect.stringContaining("DeleteEndpoint") });
  });

  it("⑫c 删到一半出错 ⇒ 已经删掉的那个照样进证据与审计(真删了就要有记录),剩下的下一步清", async () => {
    h.regions[HOME].endpoints = endpointsOf(HOME, TASK_A);
    h.regions[HOME].instance = null;
    h.deleteEndpointError = fault("ThrottlingException", "Rate exceeded");
    h.deleteEndpointErrorOnly = endpointArn(HOME, tgtId(TASK_A));
    const first = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(first.next).toEqual({ kind: "wait", delayMs: DMS_RECLAIM_WAIT_MS });
    expect(first.evidence).toMatchObject({ settledOutcome: "gone", waitingFor: "endpoint-sweep-retry", endpointsDeleted: [srcId(TASK_A)], endpointSweepError: expect.stringContaining("Rate exceeded") });
    expect(h.regions[HOME].endpoints.map((e) => e.EndpointIdentifier)).toEqual([tgtId(TASK_A)]);
    expect(sweepAudit()).toHaveLength(1);
    expect(sweepAudit()[0].item.detail as Record<string, unknown>).toMatchObject({ endpoints: [srcId(TASK_A)] });
    h.deleteEndpointError = null;
    const second = await dmsInstanceReclaimJobHandler.step(ctx(job({ phase: "waiting", evidence: first.evidence }), AFTER_GRACE + 60_000));
    expect(second.next).toEqual({ kind: "succeeded" });
    expect(second.evidence).toMatchObject({ outcome: "gone", endpointsDeleted: [srcId(TASK_A), tgtId(TASK_A)] });
    expect(second.evidence.endpointSweepError).toBeUndefined();
    expect(sweepAudit()).toHaveLength(2);
  });

  it("⑬ 任务行已经没了、却还被一条没在删除的复制任务引用 ⇒ 只报告不删(那条复制任务是用户对象,本作业不删复制任务)", async () => {
    h.regions[HOME].endpoints = endpointsOf(HOME, TASK_A);
    h.regions[HOME].tasks = [repTask("stopped", HOME, TASK_A)];
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.next).toEqual({ kind: "succeeded" });
    expect(r.evidence).toMatchObject({ outcome: "kept-in-use", endpointsBlocked: [srcId(TASK_A), tgtId(TASK_A)], endpointsDeleted: [] });
    expect(dmsCalls(HOME)).not.toContain("DeleteEndpointCommand");
    expect(h.regions[HOME].endpoints).toHaveLength(2);
    expect(sweepAudit()).toHaveLength(0);
  });

  it("⑭ 先列端点、后读任务表;任务表读完才下结论 —— 任务行在第二页的端点照样保留", async () => {
    h.regions[HOME].endpoints = [...endpointsOf(HOME, TASK_A), ...endpointsOf(HOME, TASK_B)];
    h.scanPages = [[taskRow(TASK_A, "stopped")], [taskRow(TASK_B, "stopped")]];
    h.regions[HOME].tasks = [repTask("stopped", HOME, TASK_A), repTask("stopped", HOME, TASK_B)];
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.evidence).toMatchObject({ outcome: "kept-in-use", endpointsDeleted: [] });
    expect(r.evidence.endpointsBlocked).toBeUndefined();
    expect(h.regions[HOME].endpoints).toHaveLength(4);
    expect(h.calls.filter((c) => c === "ddb:ScanCommand")).toHaveLength(2);
    expect(h.calls.indexOf(`${HOME}:DescribeEndpointsCommand`)).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf(`${HOME}:DescribeEndpointsCommand`)).toBeLessThan(h.calls.indexOf("ddb:ScanCommand"));
  });

  it("⑭b 任务表读失败 ⇒ 一个端点都不删(「没读到这条任务」不等于「这条任务不存在」);实例那一侧有结论时作业等着重试,超预算 ⇒ failed 需人工", async () => {
    h.regions[HOME].endpoints = endpointsOf(HOME, TASK_A);
    h.regions[HOME].tasks = [repTask("stopped", HOME, TASK_B)];
    h.scanError = fault("ProvisionedThroughputExceededException", "throttled");
    const r = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(r.next).toEqual({ kind: "wait", delayMs: DMS_RECLAIM_WAIT_MS });
    expect(r.evidence).toMatchObject({ settledOutcome: "kept-in-use", waitingFor: "endpoint-sweep-retry", endpointSweepError: expect.stringContaining("throttled"), endpointsDeleted: [] });
    expect(dmsCalls(HOME)).not.toContain("DeleteEndpointCommand");
    expect(h.regions[HOME].endpoints).toHaveLength(2);
    const late = await dmsInstanceReclaimJobHandler.step(ctx(job({ phase: "waiting", evidence: r.evidence }), OVER_BUDGET));
    expect(late.next.kind).toBe("failed");
    expect((late.next as { reason: string }).reason).toContain("需人工");
    expect(h.regions[HOME].endpoints).toHaveLength(2);
    // 实例上零任务、要靠任务表判「有没有任务在启动」时,读不到就整步重试:不许按「零条在启动」去删实例
    h.regions[HOME].tasks = [];
    h.calls.length = 0;
    const noFacts = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(noFacts.next.kind).toBe("retry");
    expect(dmsCalls(HOME)).not.toContain("DeleteReplicationInstanceCommand");
  });

  it("⑮ 列端点失败不挡实例回收(实例照常删、只删一次),但作业不收口;端点清单恢复后以「已回收」收口;一直失败到超预算 ⇒ failed 需人工", async () => {
    h.endpointsError = fault("AccessDeniedException", "not authorized to perform dms:DescribeEndpoints");
    const first = await dmsInstanceReclaimJobHandler.step(ctx(job(), AFTER_GRACE));
    expect(first.next).toEqual({ kind: "wait", delayMs: DMS_RECLAIM_WAIT_MS });
    expect(first.evidence).toMatchObject({ settledOutcome: "deleted", waitingFor: "endpoint-sweep-retry", endpointSweepError: expect.stringContaining("DescribeEndpoints") });
    expect(dmsCalls(HOME).filter((c) => c === "DeleteReplicationInstanceCommand")).toHaveLength(1);
    // 仍然失败且超预算 ⇒ 如实判失败(实例已删这件事留在证据里)
    const late = await dmsInstanceReclaimJobHandler.step(ctx(job({ phase: "waiting", evidence: first.evidence }), OVER_BUDGET));
    expect(late.next.kind).toBe("failed");
    expect((late.next as { reason: string }).reason).toContain("bgp-src-*");
    expect(late.evidence).toMatchObject({ outcome: "deleted" });
    // 恢复之后的一步:清扫照做、以原结论收口,不再发第二次删实例
    h.endpointsError = null;
    h.regions[HOME].endpoints = endpointsOf(HOME, TASK_A);
    const second = await dmsInstanceReclaimJobHandler.step(ctx(job({ phase: "waiting", evidence: first.evidence }), AFTER_GRACE + 60_000));
    expect(second.next).toEqual({ kind: "succeeded" });
    expect(second.evidence).toMatchObject({ outcome: "deleted", endpointsDeleted: [srcId(TASK_A), tgtId(TASK_A)] });
    expect(second.evidence.endpointSweepError).toBeUndefined();
    expect(second.evidence.waitingFor).toBeUndefined();
    expect(dmsCalls(HOME).filter((c) => c === "DeleteReplicationInstanceCommand")).toHaveLength(1);
  });

  it("⑯ 实例还在等空闲宽限的那几步里,遗留端点已经被清掉、累计进证据(页面在等待期间就看得到)", async () => {
    h.regions[HOME].endpoints = endpointsOf(HOME, TASK_A);
    const first = await dmsInstanceReclaimJobHandler.step(ctx(job(), T0 + 60_000));
    expect(first.next.kind).toBe("wait");
    expect(first.evidence).toMatchObject({ waitingFor: "idle-grace", endpointsDeleted: [srcId(TASK_A), tgtId(TASK_A)] });
    expect(h.regions[HOME].endpoints).toHaveLength(0);
    // 之后又冒出一对遗留端点(更早留下的)⇒ 累计,不覆盖
    h.regions[HOME].endpoints = endpointsOf(HOME, TASK_B);
    const second = await dmsInstanceReclaimJobHandler.step(ctx(job({ phase: "waiting", evidence: first.evidence }), T0 + 120_000));
    expect(second.evidence).toMatchObject({ waitingFor: "idle-grace", endpointsDeleted: [srcId(TASK_A), tgtId(TASK_A), srcId(TASK_B), tgtId(TASK_B)] });
    expect(sweepAudit()).toHaveLength(2);
  });
});
