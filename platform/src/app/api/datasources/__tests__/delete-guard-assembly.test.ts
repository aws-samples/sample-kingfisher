// 序 58 B-130 / 序 59 B-131 —— 删数据源路由的装配层判据
//   (路由 ↔ lib/datasource/references ↔ lib/datasource/sg-cleanup-job ↔ dataplane-jobs store / runner ↔ datasource-service ↔ SDK)。
// 🔴 只 mock 真外部:DDB(内存假表,真求值条件写)、EC2 / Glue / RDS / Secrets / S3 客户端工厂、项目守卫、审计。平台模块之间一律不 mock。
//
// 判据:
//   B-131 ① 仍被同步任务引用 ⇒ 409 DATASOURCE_IN_USE,文案点名任务,源行还在,一个 AWS 删除调用都没发、没有入队;② 实时计算作业引用同理;
//   B-130 ③ 无引用、平台自建组、同步删组成功 ⇒ 200 deleted 无 pendingCleanup;**入队发生在动任何资源之前**;作业行 kind=sg-cleanup / queued /
//            state 带 sgId · region · datasourceId;审计 securityGroupCleanup=deleted;泵推进一步 ⇒ 组已不在 ⇒ succeeded(gone);
//         ④ 同步删组撞 DependencyViolation ⇒ 200 带 pendingCleanup + cleanupJobIds,审计 scheduled;泵:网卡 1 ⇒ waiting(eniCount=1),
//            网卡 0 ⇒ Delete ⇒ succeeded(deleted);
//         ⑤ 用户指定网络 ⇒ 不入队、不碰组,审计 none;
//         ⑥ 入队失败 ⇒ 502,源行还在,连接 / 密钥 / 组一个都没动(绝不出现「源删了、组没人管」);
//         ⑦ enqueueSgCleanup 幂等:同一组再入队回同一条、created=false。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Call = { svc: string; cmd: string; input: any };
const h = vi.hoisted(() => ({
  ddb: null as any,
  calls: [] as Call[],
  events: [] as string[],
  groups: {} as Record<string, string>,
  depFail: false,
  enis: 0,
  failEnqueue: false,
  audits: [] as any[],
}));

function fake(svc: string, answer: (cmd: string, input: any) => any) {
  return {
    send: async (c: any) => {
      const cmd = c.constructor.name;
      h.calls.push({ svc, cmd, input: c.input });
      if (/^(Delete|Create|Authorize|Revoke|Modify|Stop)/.test(cmd)) h.events.push(`${svc}.${cmd}`);
      return answer(cmd, c.input);
    },
  };
}

vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    docClient: {
      send: async (c: any) => {
        const table = c.input?.TableName;
        if (table === "bgp-long-ops") return {}; // 模块 55 对象租约:没有租约 = 空
        if (table === "bgp-dataplane-jobs" && c.constructor.name === "PutCommand") {
          if (h.failEnqueue) throw Object.assign(new Error("ddb down"), { name: "InternalServerError" });
          h.events.push("enqueue");
        }
        if (table === "bgp-datasources" && c.constructor.name === "DeleteCommand") h.events.push("row.delete");
        return h.ddb.send(c);
      },
    },
  };
});
vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real: any = await orig();
  const ec2 = fake("ec2", (cmd, input) => {
    if (cmd === "DescribeSecurityGroupsCommand") {
      const id = input.GroupIds[0];
      if (!(id in h.groups)) { const e: any = new Error("nf"); e.name = "InvalidGroup.NotFound"; throw e; }
      return { SecurityGroups: [{ GroupId: id, GroupName: h.groups[id] }] };
    }
    if (cmd === "DeleteSecurityGroupCommand") {
      if (h.depFail) { const e: any = new Error("has a dependent object"); e.name = "DependencyViolation"; throw e; }
      delete h.groups[input.GroupId];
      return {};
    }
    if (cmd === "DescribeNetworkInterfacesCommand") {
      return { NetworkInterfaces: Array.from({ length: h.enis }, (_, i) => ({ NetworkInterfaceId: `eni-${i}` })) };
    }
    return {};
  });
  const glue = fake("glue", () => ({}));
  const s3 = fake("s3", () => ({}));
  const sm = fake("sm", () => ({}));
  const rds = fake("rds", () => ({}));
  return {
    ...real,
    ec2ClientFor: async () => ec2,
    glueClientFor: async () => glue,
    s3ClientFor: async () => s3,
    secretsClientFor: async () => sm,
    rdsClientFor: async () => rds,
    homeRegion: () => "us-east-1",
  };
});
vi.mock("@/lib/projects/guard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects/guard")>("@/lib/projects/guard");
  return {
    ...actual,
    guardResourceAccess: vi.fn(async () => ({ identity: { username: "tester", sub: "s" }, projectId: "proj-a", role: "editor" })),
  };
});
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async (_req: unknown, action: string, opts: unknown) => { h.audits.push({ action, opts }); }) }));

import { FakeDdb, DDB_SPECS } from "@/lib/dataplane-jobs/__tests__/fake-ddb";
import { DELETE } from "../[id]/route";
import { runJobStep } from "@/lib/dataplane-jobs/runner";
import { enqueueSgCleanup } from "@/lib/datasource/sg-cleanup-job";

h.ddb = new FakeDdb({
  ...DDB_SPECS,
  "bgp-datasources": { hash: "userId", range: "datasourceId" },
  "bgp-flink-jobs": { hash: "userId", range: "jobId" },
});

const DSID = "01HXAAAAAAAAAAAAAAAA12345678"; // 平台组名 = bgp-ds-12345678
const USER = "default-user";
const SECRET = "arn:aws:secretsmanager:us-east-1:000000000000:secret:bgp/datasource/x";
function seedDatasource(networkConfig: Record<string, unknown>) {
  h.ddb.put("bgp-datasources", {
    userId: USER, datasourceId: DSID, name: "订单库", type: "mysql", host: "db.internal", port: 3306, database: "orders",
    projectId: "proj-a", ownerTargetId: "tgt_home", glueConnectionName: "bgp-conn-AAAA12345678", secretArn: SECRET,
    networkConfig, status: "active", createdAt: "2026-10-28T08:00:00.000Z",
  });
}
const PLATFORM_NET = { subnetId: "subnet-1", securityGroupId: "sg-plat", availabilityZone: "us-east-1a" };
const USER_NET = { subnetId: "subnet-1", securityGroupId: "sg-cust", securityGroupIds: ["sg-cust"], availabilityZone: "us-east-1a" };
const del = () => DELETE(new NextRequest(`https://x.test/api/datasources/${DSID}`, { method: "DELETE" }), { params: { id: DSID } });
const dsRow = () => h.ddb.get("bgp-datasources", { userId: USER, datasourceId: DSID });
const jobRows = () => h.ddb.all("bgp-dataplane-jobs").filter((r: any) => r.kind === "sg-cleanup");
const awsDeletes = () => h.calls.filter((c) => /^Delete/.test(c.cmd)).map((c) => `${c.svc}.${c.cmd}`);

beforeEach(() => {
  h.ddb = new FakeDdb({
    ...DDB_SPECS,
    "bgp-datasources": { hash: "userId", range: "datasourceId" },
    "bgp-flink-jobs": { hash: "userId", range: "jobId" },
  });
  h.calls.length = 0; h.events.length = 0; h.audits.length = 0;
  h.groups = { "sg-plat": "bgp-ds-12345678", "sg-cust": "customer-db-access" };
  h.depFail = false; h.enis = 0; h.failEnqueue = false;
});

describe("🔴 B-131 删源前核引用", () => {
  it("① 仍被同步任务引用 ⇒ 409 DATASOURCE_IN_USE 点名任务;源行还在;零 AWS 删除调用;不入队", async () => {
    seedDatasource(PLATFORM_NET);
    h.ddb.put("bgp-sync-tasks", { userId: USER, taskId: "t1", name: "orders 日同步", datasourceId: DSID, channel: "glue", status: "idle" });
    h.ddb.put("bgp-sync-tasks", { userId: USER, taskId: "t2", name: "别的源的任务", datasourceId: "other", channel: "glue" });
    const res = await del();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("DATASOURCE_IN_USE");
    expect(body.error.message).toContain("同步任务「orders 日同步」");
    expect(body.error.message).not.toContain("别的源的任务");
    expect(body.error.detail.syncTasks).toEqual([{ id: "t1", name: "orders 日同步", kind: "sync-task", status: "idle", channel: "glue" }]);
    expect(dsRow()).toBeTruthy();
    expect(awsDeletes()).toEqual([]);
    expect(jobRows()).toHaveLength(0);
  });
  it("② 被实时计算作业(sink)引用 ⇒ 409,文案点名实时计算作业", async () => {
    seedDatasource(PLATFORM_NET);
    h.ddb.put("bgp-flink-jobs", { userId: USER, jobId: "f1", name: "rt-sink", sinkDatasourceId: DSID, sourceDatasourceId: null, status: "stopped" });
    const res = await del();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toContain("实时计算作业「rt-sink」");
    expect(body.error.detail.flinkJobs).toEqual([{ id: "f1", name: "rt-sink", kind: "flink-job", status: "stopped" }]);
    expect(dsRow()).toBeTruthy();
  });
});

describe("🔴 B-130 平台自建安全组:入队在前,按网卡事实收口", () => {
  it("③ 同步删组成功 ⇒ 200 无 pendingCleanup;入队先于任何资源删除;作业 queued 带 state;审计 deleted;泵推进 ⇒ gone ⇒ succeeded", async () => {
    seedDatasource(PLATFORM_NET);
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { deleted: true } });
    expect(dsRow()).toBeUndefined();
    // 时序:入队 → 撤发现作业 / 删连接 / 删密钥 / 删组 → 删行
    expect(h.events[0]).toBe("enqueue");
    expect(h.events.indexOf("enqueue")).toBeLessThan(h.events.indexOf("glue.DeleteConnectionCommand"));
    expect(h.events.indexOf("glue.DeleteConnectionCommand")).toBeLessThan(h.events.indexOf("row.delete"));
    expect(h.events).toContain("ec2.DeleteSecurityGroupCommand");
    const jobs = jobRows();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "sg-cleanup", targetId: "tgt_home", phase: "queued", createdBy: "user:tester",
      state: { sgId: "sg-plat", region: "us-east-1", datasourceId: DSID } });
    const audit = h.audits.find((a) => a.action === "datasource.delete");
    expect(audit.opts.detail).toMatchObject({ name: "订单库", securityGroupCleanup: "deleted", cleanupJobIds: [jobs[0].jobId] });
    // 泵推进一步:组已被同步路径删掉 ⇒ Describe 回 NotFound ⇒ gone ⇒ 终态成功
    const out = await runJobStep(jobs[0].jobId, { respectSchedule: false });
    expect(out.kind).toBe("advanced"); // runner:本轮推进到了终态(再推一次才是 terminal = 「已经是终态」)
    expect((out as { job: { phase: string } }).job.phase).toBe("succeeded");
    const after = jobRows()[0];
    expect(after.phase).toBe("succeeded");
    expect(after.evidence).toMatchObject({ outcome: "gone", sgId: "sg-plat" });
  });
  it("④ 同步删组撞 DependencyViolation ⇒ 200 带 pendingCleanup / cleanupJobIds,审计 scheduled;泵:网卡 1 ⇒ waiting,网卡 0 ⇒ 删 ⇒ succeeded", async () => {
    seedDatasource(PLATFORM_NET);
    h.depFail = true;
    const res = await del();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.deleted).toBe(true);
    expect(body.data.pendingCleanup).toEqual(["sg-plat"]);
    expect(body.data.cleanupJobIds).toHaveLength(1);
    expect(dsRow()).toBeUndefined();
    expect(h.audits.find((a) => a.action === "datasource.delete").opts.detail.securityGroupCleanup).toBe("scheduled");
    const jobId = body.data.cleanupJobIds[0];
    // 网卡还挂着 ⇒ 等(不发 Delete)
    h.enis = 1;
    const deletesBefore = h.calls.filter((c) => c.svc === "ec2" && c.cmd === "DeleteSecurityGroupCommand").length;
    const o1 = await runJobStep(jobId, { respectSchedule: false });
    expect(o1.kind).toBe("advanced");
    let row = jobRows()[0];
    expect(row.phase).toBe("waiting");
    expect(row.evidence).toMatchObject({ eniCount: 1 });
    expect(h.calls.filter((c) => c.svc === "ec2" && c.cmd === "DeleteSecurityGroupCommand")).toHaveLength(deletesBefore);
    // 网卡释放 ⇒ 删 ⇒ 成功
    h.enis = 0; h.depFail = false;
    const o2 = await runJobStep(jobId, { respectSchedule: false });
    expect(o2.kind).toBe("advanced");
    expect((o2 as { job: { phase: string } }).job.phase).toBe("succeeded");
    expect((await runJobStep(jobId, { respectSchedule: false })).kind).toBe("terminal"); // 终态行再推 = terminal,不再调 AWS
    row = jobRows()[0];
    expect(row.phase).toBe("succeeded");
    expect(row.evidence).toMatchObject({ outcome: "deleted", eniCount: 0 });
    expect("sg-plat" in h.groups).toBe(false);
  });
  it("⑤ 用户指定网络 ⇒ 不入队、不碰组;审计 none;其余(连接 / 密钥 / 行)照删", async () => {
    seedDatasource(USER_NET);
    const res = await del();
    expect(res.status).toBe(200);
    expect(jobRows()).toHaveLength(0);
    expect(h.events).not.toContain("enqueue");
    expect(h.events).not.toContain("ec2.DeleteSecurityGroupCommand");
    expect(h.events).toContain("glue.DeleteConnectionCommand");
    expect(h.events).toContain("row.delete");
    expect(h.audits.find((a) => a.action === "datasource.delete").opts.detail.securityGroupCleanup).toBe("none");
    expect("sg-cust" in h.groups).toBe(true);
  });
  it("⑥ 入队失败 ⇒ 502 UPSTREAM_ERROR;源行还在;连接 / 密钥 / 组一个都没动", async () => {
    seedDatasource(PLATFORM_NET);
    h.failEnqueue = true;
    const res = await del();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("UPSTREAM_ERROR");
    expect(body.error.message).toMatch(/源记录未删/);
    expect(dsRow()).toBeTruthy();
    expect(awsDeletes()).toEqual([]);
    expect(h.events).not.toContain("row.delete");
  });
  it("⑦ enqueueSgCleanup 幂等:同一 (target, datasource, sg) 再入队回同一条、created=false", async () => {
    const a = await enqueueSgCleanup({ sgId: "sg-plat", region: "us-east-1", targetId: "tgt_home", datasourceId: DSID, createdBy: "user:t" });
    const b = await enqueueSgCleanup({ sgId: "sg-plat", region: "us-east-1", targetId: "tgt_home", datasourceId: DSID, createdBy: "user:t" });
    expect(a.created).toBe(true);
    expect(b).toEqual({ jobId: a.jobId, created: false, phase: "queued" });
    expect(jobRows()).toHaveLength(1);
  });
});
