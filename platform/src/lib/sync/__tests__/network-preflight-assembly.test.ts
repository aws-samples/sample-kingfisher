// 序 61 B-133 —— 同步启动核心 ensureGlueSyncJob ↔ 数据源网络对象核对自愈的装配层判据(真调用序列)。
//
// 【缺陷原形(2026-10-28 测试账号)】平台为数据源建的安全组被平台外删除 ⇒ 之后每次同步启动 / 定时运行都失败,运行行只有 AWS 原话;
//   源仍显示「已连接」;编辑不重建组;产品里没有修复入口。
// 【规则】ensureGlueSyncJob 在**任何副作用之前**(建命名空间 / 写脚本桶 / 建作业)核对源的外部网络对象:平台组缺 ⇒ 重建并把连接接回,
//   然后照常建作业;用户自带的组缺 ⇒ 409 DATASOURCE_NETWORK_BROKEN 且零副作用;事实读不到 ⇒ 不拦。
// 🔴 只 mock 真外部:按区 SDK 客户端工厂(Glue / S3 / S3 Tables / EC2 / RDS / Secrets Manager)、落点解析、DDB、审计 / 告警出口、OM 推送。
//    start-run ↔ network-reconcile ↔ datasource-service ↔ ds-place ↔ ds-patch 之间一律不 mock。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GOLDEN_SHAPES } from "./golden-shapes";
import type { DataSource } from "@/types/datasource";

type Call = { svc: string; cmd: string; input: any };
const h = vi.hoisted(() => ({
  calls: [] as Call[],
  patches: [] as any[],
  sgs: {} as Record<string, { GroupName: string; Tags: Array<{ Key: string; Value: string }> }>,
  conn: null as null | { SubnetId?: string; SecurityGroupIdList?: string[]; AvailabilityZone?: string },
  throttle: false,
}));
function fake(svc: string, answer: (cmd: string, input: any) => any) {
  return { send: async (c: any) => { const cmd = c.constructor.name; h.calls.push({ svc, cmd, input: c.input }); return answer(cmd, c.input); } };
}
function err(name: string, message = name) { const e: any = new Error(message); e.name = name; return e; }

vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real: any = await orig();
  const glue = fake("glue", (cmd, input) => {
    if (cmd === "GetJobCommand") return { Job: { Name: input.JobName, GlueVersion: "5.1" } };
    if (cmd === "UpdateJobCommand") return { JobName: input.JobName };
    if (cmd === "GetConnectionCommand") {
      if (!h.conn) throw err("EntityNotFoundException", `Connection ${input.Name} not found`);
      return { Connection: { Name: input.Name, ConnectionType: "JDBC", ConnectionProperties: { JDBC_CONNECTION_URL: "jdbc:mysql://x" }, PhysicalConnectionRequirements: { ...h.conn } } };
    }
    if (cmd === "UpdateConnectionCommand" || cmd === "CreateConnectionCommand") { h.conn = { ...(input.ConnectionInput?.PhysicalConnectionRequirements ?? {}) }; return {}; }
    return {};
  });
  const s3 = fake("s3", () => ({}));
  const s3tables = fake("s3tables", (cmd) => {
    if (cmd === "ListTableBucketsCommand") return { tableBuckets: [{ name: "bgp-table-bucket", arn: "arn:aws:s3tables:us-east-1:123456789012:bucket/bgp-table-bucket" }] };
    if (cmd === "ListNamespacesCommand") return { namespaces: [{ namespace: ["gamedb"] }] };
    return {};
  });
  const ec2 = fake("ec2", (cmd, input) => {
    if (cmd === "DescribeSecurityGroupsCommand") {
      if (h.throttle) throw err("RequestLimitExceeded");
      const ids: string[] = input.GroupIds ?? input.Filters?.find((f: any) => f.Name === "group-id")?.Values ?? [];
      return { SecurityGroups: ids.filter((id) => h.sgs[id]).map((id) => ({ GroupId: id, GroupName: h.sgs[id].GroupName, Tags: h.sgs[id].Tags })) };
    }
    // B-133 第二刀:子网事实带 VPC / 可用区(写 Glue 连接前按它取 AZ;源行不存 AZ)
    if (cmd === "DescribeSubnetsCommand") return { Subnets: [{ SubnetId: "subnet-1", VpcId: "vpc-1", AvailabilityZone: "us-east-1a" }] };
    if (cmd === "CreateSecurityGroupCommand") { h.sgs["sg-rebuilt"] = { GroupName: input.GroupName, Tags: input.TagSpecifications?.[0]?.Tags ?? [] }; return { GroupId: "sg-rebuilt" }; }
    if (cmd === "DescribeVpcsCommand") return { Vpcs: [{ VpcId: input.VpcIds[0], CidrBlock: "10.0.0.0/16" }] };
    return {};
  });
  const rds = fake("rds", () => ({ DBInstances: [] }));
  const sm = fake("sm", () => ({ SecretString: JSON.stringify({ username: "u", password: "p" }) }));
  return {
    ...real,
    glueClientFor: async () => glue, s3ClientFor: async () => s3, s3tablesClientFor: async () => s3tables, logsClientFor: async () => fake("logs", () => ({})),
    ec2ClientFor: async () => ec2, rdsClientFor: async () => rds, secretsClientFor: async () => sm, homeRegion: () => "us-east-1",
  };
});
vi.mock("@/lib/exec-env/data-plane-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec-env/data-plane-target")>();
  return {
    ...actual,
    resolveGlueBinding: vi.fn(async () => ({
      targetId: "tgt_home", region: "us-east-1", scriptsBucket: "bgp-glue-scripts-123456789012", roleArn: "arn:aws:iam::123456789012:role/bgp-glue-role",
      datalakeBucket: "bgp-datalake-123456789012", tableBucket: "bgp-table-bucket", home: true, jurisdiction: "home",
    })),
    resolveRedshiftBinding: vi.fn(async () => ({ targetId: "tgt_home", region: "us-east-1", workgroup: "bgp-workgroup", database: "dev", secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:rs-AbC" })),
  };
});
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { DATASOURCES: "bgp-datasources", SYNC_TASKS: "bgp-sync-tasks", TASK_RUNS: "bgp-task-runs" },
  docClient: { send: vi.fn(async (cmd: any) => { if (cmd.constructor.name === "UpdateCommand") h.patches.push(cmd.input); return {}; }) },
}));
vi.mock("@/lib/audit", () => ({ writeAuditRecord: vi.fn(async () => undefined), recordAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/alerting/events", () => ({ putEventIfNew: vi.fn(async () => null) }));
vi.mock("@/lib/openmetadata/om-push", () => ({ pushSyncToOpenMetadata: vi.fn(async () => {}) }));
vi.mock("@/lib/openmetadata/om-sync-backfill", () => ({ backfillSyncOmAfterSuccess: vi.fn(async () => {}) }));
vi.mock("@/lib/scheduler/dependency", () => ({ fireDownstreamOnce: vi.fn(async () => {}) }));

import { ensureGlueSyncJob } from "@/lib/sync/start-run";

const DS_ID = "01HXAAAAAAAAAAAAAAAADS0133";
const CONN = "bgp-conn-AAAAAADS0133";
const base = GOLDEN_SHAPES[0].ds as unknown as Record<string, unknown>;
const platformDs = () => ({
  ...base, datasourceId: DS_ID, glueConnectionName: CONN, secretArn: "arn:aws:secretsmanager:us-east-1:000000000000:secret:bgp/datasource/x",
  // 与建源真落库同形:没有 availabilityZone(2.1.2 及之前从不落;B-133 第二刀起连接的 AZ 按子网事实取)
  networkConfig: { vpcId: "vpc-1", subnetId: "subnet-1", securityGroupId: "sg-plat", isRds: false },
}) as unknown as DataSource;
const userDs = () => ({
  ...(platformDs() as unknown as Record<string, unknown>),
  networkConfig: { vpcId: "vpc-1", subnetId: "subnet-1", securityGroupId: "sg-user-1", securityGroupIds: ["sg-user-1", "sg-user-2"], isRds: false },
}) as unknown as DataSource;
const TASK_ID = "01TASKNETPRE0000000A1";
const task = () => ({
  userId: "default-user", taskId: TASK_ID, name: "players-s3", datasourceId: DS_ID,
  channel: "glue", syncMode: "full", writeMode: "append", targetType: "s3-tables",
  sourceDatabase: "gamedb", sourceTables: ["players"], s3Config: { namespace: "gamedb" }, projectId: "default",
  glueConfig: { glueVersion: "5.1", numberOfWorkers: 2, workerType: "G.1X" },
});
const idx = (svc: string, cmd: string) => h.calls.findIndex((c) => c.svc === svc && c.cmd === cmd);
const ec2Writes = () => h.calls.filter((c) => c.svc === "ec2" && /^(Create|Authorize|Revoke|Delete|Modify)/.test(c.cmd));

beforeEach(() => {
  h.calls.length = 0; h.patches.length = 0; h.throttle = false;
  h.sgs = { "sg-plat": { GroupName: "bgp-ds-AADS0133", Tags: [{ Key: "bgp:managed", Value: "datasource" }] }, "sg-user-1": { GroupName: "a", Tags: [] }, "sg-user-2": { GroupName: "b", Tags: [] } };
  h.conn = { SubnetId: "subnet-1", SecurityGroupIdList: ["sg-plat"], AvailabilityZone: "us-east-1a" };
  process.env.AWS_ACCOUNT_ID = "123456789012";
});

describe("ensureGlueSyncJob ↔ 网络对象核对自愈(B-133 装配)", () => {
  it("平台组被删 ⇒ 先 CreateSecurityGroup(带标签)+ UpdateConnection,再建命名空间 / 写脚本 / 建作业 ⇒ ok:true", async () => {
    delete h.sgs["sg-plat"];
    const r = await ensureGlueSyncJob({ task: task(), taskId: TASK_ID, ds: platformDs(), tid: "tgt_home" });
    expect(r.ok).toBe(true);
    const create = idx("ec2", "CreateSecurityGroupCommand");
    const rewire = idx("glue", "UpdateConnectionCommand");
    expect(create).toBeGreaterThan(-1);
    expect(rewire).toBeGreaterThan(create);
    for (const [svc, cmd] of [["s3tables", "ListTableBucketsCommand"], ["s3", "PutObjectCommand"], ["glue", "GetJobCommand"], ["glue", "UpdateJobCommand"]] as const) {
      const i = idx(svc, cmd);
      expect(i, `${svc}.${cmd} 必须发生且在接回之后`).toBeGreaterThan(rewire);
    }
    const createInput = h.calls[create].input;
    expect(createInput.TagSpecifications[0].Tags).toEqual([{ Key: "bgp:managed", Value: "datasource" }, { Key: "bgp:datasourceId", Value: DS_ID }, { Key: "bgp:targetId", Value: "tgt_home" }]);
    expect(h.calls[rewire].input.ConnectionInput.PhysicalConnectionRequirements.SecurityGroupIdList).toEqual(["sg-rebuilt"]);
    // 作业定义仍只引用连接名(组的变化对作业透明)
    const upd = h.calls.find((c) => c.svc === "glue" && c.cmd === "UpdateJobCommand")!;
    expect(upd.input.JobUpdate.Connections).toEqual({ Connections: [CONN] });
    expect(h.patches).toHaveLength(1);
  });

  it("用户自带的组被删 ⇒ 409 DATASOURCE_NETWORK_BROKEN 点名对象,零副作用(不建命名空间 / 不写脚本 / 不碰作业 / 不建组)", async () => {
    delete h.sgs["sg-user-2"];
    h.conn = { SubnetId: "subnet-1", SecurityGroupIdList: ["sg-user-1", "sg-user-2"], AvailabilityZone: "us-east-1a" };
    const r = await ensureGlueSyncJob({ task: task(), taskId: TASK_ID, ds: userDs(), tid: "tgt_home" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    expect(r.code).toBe("DATASOURCE_NETWORK_BROKEN");
    expect(r.message).toContain("sg-user-2");
    expect(r.message).toContain("网络配置");
    expect(h.calls.filter((c) => c.svc === "s3tables" || c.svc === "s3")).toHaveLength(0);
    expect(h.calls.filter((c) => c.svc === "glue" && c.cmd.endsWith("JobCommand"))).toHaveLength(0);
    expect(ec2Writes()).toHaveLength(0);
    expect(h.calls.filter((c) => c.svc === "glue" && /^(Create|Update)Connection/.test(c.cmd))).toHaveLength(0);
    // 源行如实:status=error + broken
    expect(h.patches).toHaveLength(1);
    expect(JSON.stringify(h.patches[0].ExpressionAttributeValues)).toContain('"broken"');
  });

  it("对象都在 ⇒ 只读三样事实,零 EC2 写,作业照常建", async () => {
    const r = await ensureGlueSyncJob({ task: task(), taskId: TASK_ID, ds: platformDs(), tid: "tgt_home" });
    expect(r.ok).toBe(true);
    expect(ec2Writes()).toHaveLength(0);
    expect(h.calls.filter((c) => c.svc === "glue" && /^(Create|Update)Connection/.test(c.cmd))).toHaveLength(0);
    expect(idx("glue", "UpdateJobCommand")).toBeGreaterThan(-1);
    expect(h.patches).toHaveLength(0);
  });

  it("事实读不到(EC2 限流)⇒ 不拦业务:作业照常建,零写", async () => {
    h.throttle = true;
    const r = await ensureGlueSyncJob({ task: task(), taskId: TASK_ID, ds: platformDs(), tid: "tgt_home" });
    expect(r.ok).toBe(true);
    expect(ec2Writes()).toHaveLength(0);
    expect(idx("glue", "UpdateJobCommand")).toBeGreaterThan(-1);
  });

  it("没有网络配置的存量源(GOLDEN 形态)⇒ 零 EC2 调用,与改动前同序", async () => {
    const r = await ensureGlueSyncJob({ task: task(), taskId: TASK_ID, ds: { ...base, glueConnectionName: CONN } as unknown as DataSource, tid: "tgt_home" });
    expect(r.ok).toBe(true);
    expect(h.calls.filter((c) => c.svc === "ec2")).toHaveLength(0);
    expect(h.calls.filter((c) => c.svc === "glue" && c.cmd === "GetConnectionCommand")).toHaveLength(0);
  });
});
