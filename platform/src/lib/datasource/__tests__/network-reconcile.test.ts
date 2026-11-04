// 序 61 B-133 —— 数据源外部网络对象核对自愈(唯一作者 lib/datasource/network-reconcile.ts)的判据。
//
// 🔴 只 mock 真外部:按区 SDK 客户端工厂(EC2 / Glue / RDS / Secrets Manager)、DDB、审计出口、告警中心出口。
//    network-reconcile ↔ datasource-service ↔ ds-place ↔ ds-patch 之间**一律不 mock**(接缝就在这里:事实读取 ⇒ 重建 ⇒ 接回 ⇒ 落行)。
// 判据钉**事实**:发出的 AWS 调用及其参数(标签逐字)、源行落了什么、审计 / 告警带什么;不钉形态。
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DataSource } from "@/types/datasource";

type Call = { svc: string; cmd: string; input: any };
const h = vi.hoisted(() => ({
  calls: [] as Call[],
  patches: [] as any[],
  sgs: {} as Record<string, { GroupName: string; Tags: Array<{ Key: string; Value: string }> }>,
  subnets: new Set<string>(),
  conn: null as null | { SubnetId?: string; SecurityGroupIdList?: string[]; AvailabilityZone?: string },
  secretMissing: false,
  throttle: false,
  createdSg: 0,
}));

function fake(svc: string, answer: (cmd: string, input: any) => any) {
  return { send: async (c: any) => { const cmd = c.constructor.name; h.calls.push({ svc, cmd, input: c.input }); return answer(cmd, c.input); } };
}
function err(name: string, message = name) { const e: any = new Error(message); e.name = name; return e; }

vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real: any = await orig();
  const ec2 = fake("ec2", (cmd, input) => {
    if (cmd === "DescribeSecurityGroupsCommand") {
      if (h.throttle) throw err("RequestLimitExceeded", "Request limit exceeded.");
      const ids: string[] = input.GroupIds ?? input.Filters?.find((f: any) => f.Name === "group-id")?.Values ?? [];
      const names: string[] = input.Filters?.find((f: any) => f.Name === "group-name")?.Values ?? [];
      const hit = Object.entries(h.sgs).filter(([id, g]) => ids.includes(id) || names.includes(g.GroupName));
      return { SecurityGroups: hit.map(([id, g]) => ({ GroupId: id, GroupName: g.GroupName, Tags: g.Tags })) };
    }
    if (cmd === "DescribeSubnetsCommand") {
      const ids: string[] = input.SubnetIds ?? input.Filters?.find((f: any) => f.Name === "subnet-id")?.Values ?? [];
      // 子网 ↔ 可用区按子网各异:subnet-default 在 1b,其余在 1a —— 判据才能分辨「AZ 来自子网事实」与「来自环境变量 DEFAULT_AZ / 源行」
      return { Subnets: ids.filter((x) => h.subnets.has(x)).map((x) => ({ SubnetId: x, VpcId: "vpc-1", AvailabilityZone: x === "subnet-default" ? "us-east-1b" : "us-east-1a" })) };
    }
    if (cmd === "CreateSecurityGroupCommand") {
      const id = `sg-new-${++h.createdSg}`;
      h.sgs[id] = { GroupName: input.GroupName, Tags: input.TagSpecifications?.[0]?.Tags ?? [] };
      return { GroupId: id };
    }
    if (cmd === "DescribeVpcsCommand") return { Vpcs: [{ VpcId: input.VpcIds[0], CidrBlock: "10.0.0.0/16" }] };
    if (cmd === "CreateTagsCommand") { for (const r of input.Resources) if (h.sgs[r]) h.sgs[r].Tags = input.Tags; return {}; }
    return {};
  });
  const glue = fake("glue", (cmd, input) => {
    if (cmd === "GetConnectionCommand") {
      if (!h.conn) throw err("EntityNotFoundException", `Connection ${input.Name} not found`);
      return { Connection: { Name: input.Name, ConnectionType: "JDBC", ConnectionProperties: { JDBC_CONNECTION_URL: "jdbc:mysql://x" }, PhysicalConnectionRequirements: { ...h.conn } } };
    }
    if (cmd === "UpdateConnectionCommand" || cmd === "CreateConnectionCommand") { h.conn = { ...(input.ConnectionInput?.PhysicalConnectionRequirements ?? {}) }; return {}; }
    return {};
  });
  const rds = fake("rds", () => ({ DBInstances: [] }));
  const sm = fake("sm", (cmd) => {
    if (cmd === "GetSecretValueCommand") {
      if (h.secretMissing) throw err("ResourceNotFoundException", "Secrets Manager can't find the specified secret.");
      return { SecretString: JSON.stringify({ username: "u", password: "p" }) };
    }
    return {};
  });
  return { ...real, ec2ClientFor: async () => ec2, glueClientFor: async () => glue, rdsClientFor: async () => rds, secretsClientFor: async () => sm, homeRegion: () => "us-east-1" };
});
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { DATASOURCES: "bgp-datasources" },
  docClient: { send: vi.fn(async (cmd: any) => { if (cmd.constructor.name === "UpdateCommand") h.patches.push(cmd.input); return {}; }) },
}));
const audit = vi.hoisted(() => ({ writeAuditRecord: vi.fn(async () => undefined) }));
vi.mock("@/lib/audit", () => ({ writeAuditRecord: audit.writeAuditRecord, recordAudit: vi.fn(async () => undefined) }));
const alerts = vi.hoisted(() => ({ putEventIfNew: vi.fn(async () => null) }));
vi.mock("@/lib/alerting/events", () => ({ putEventIfNew: alerts.putEventIfNew }));

import { reconcileDatasourceNetwork, noteNetworkDriftFromRunError, NETWORK_DRIFT_ALERT_RULE_ID, AUDIT_ACTION_HEALED, AUDIT_ACTION_BROKEN } from "@/lib/datasource/network-reconcile";
import { updateGlueConnectionNetwork } from "@/lib/aws/datasource-service";

const DS_ID = "01HXAAAAAAAAAAAAAAAADS0133";
const CONN = "bgp-conn-AAAAAADS0133";
const SECRET = "arn:aws:secretsmanager:us-east-1:000000000000:secret:bgp/datasource/x";
const TAGS = [{ Key: "bgp:managed", Value: "datasource" }, { Key: "bgp:datasourceId", Value: DS_ID }, { Key: "bgp:targetId", Value: "tgt_home" }];

const platformDs = (over: Record<string, unknown> = {}) => ({
  datasourceId: DS_ID, name: "GameData-MySQL", type: "mysql", host: "db.example.internal", port: 3306, database: "gamedb",
  secretArn: SECRET, glueConnectionName: CONN, status: "active",
  // 🔴 与建源真落库同形:networkConfig **没有** availabilityZone(2.1.2 及之前建源从不落它;B-133 第二刀起新行才带)——
  //    夹具若自带 AZ,「重建的连接丢了可用区」这一刀永远测不到(10-29 …4916 页面驱动 B133-7 真撞后改)
  networkConfig: { vpcId: "vpc-1", subnetId: "subnet-1", securityGroupId: "sg-plat-old", isRds: false },
  ...over,
}) as unknown as DataSource;
const userDs = (over: Record<string, unknown> = {}) => platformDs({
  networkConfig: { vpcId: "vpc-1", subnetId: "subnet-1", securityGroupId: "sg-user-1", securityGroupIds: ["sg-user-1", "sg-user-2"], isRds: false },
  ...over,
});

/** patchDataSourceRow 的 UpdateCommand ⇒ { 键: 值 } */
function decodePatch(input: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [alias, key] of Object.entries(input.ExpressionAttributeNames as Record<string, string>)) out[key] = input.ExpressionAttributeValues[alias.replace("#k", ":v")];
  return out;
}
const ec2Writes = () => h.calls.filter((c) => c.svc === "ec2" && /^(Create|Authorize|Revoke|Delete|Modify)/.test(c.cmd));
const glueWrites = () => h.calls.filter((c) => c.svc === "glue" && /^(Create|Update|Delete)/.test(c.cmd));
const cmd = (svc: string, name: string) => h.calls.filter((c) => c.svc === svc && c.cmd === name);

beforeEach(() => {
  h.calls.length = 0; h.patches.length = 0; h.createdSg = 0; h.throttle = false; h.secretMissing = false;
  h.sgs = { "sg-plat-old": { GroupName: "bgp-ds-AADS0133", Tags: TAGS }, "sg-user-1": { GroupName: "user-a", Tags: [] }, "sg-user-2": { GroupName: "user-b", Tags: [] } };
  h.subnets = new Set(["subnet-1"]);
  h.conn = { SubnetId: "subnet-1", SecurityGroupIdList: ["sg-plat-old"], AvailabilityZone: "us-east-1a" };
  audit.writeAuditRecord.mockClear(); alerts.putEventIfNew.mockClear();
  process.env.DEFAULT_VPC_ID = "vpc-1"; process.env.DEFAULT_SUBNET_ID = "subnet-default"; process.env.DEFAULT_AZ = "us-east-1a";
});

describe("reconcileDatasourceNetwork —— 平台拥有的对象:缺了就按源行重建接回(响亮)", () => {
  it("平台组被删 ⇒ CreateSecurityGroup 带归属标签逐字 ⇒ UpdateConnection 指向新组 ⇒ 源行 healed/healCount/新 id ⇒ 审计 healed ⇒ 告警 P2", async () => {
    delete h.sgs["sg-plat-old"];
    h.conn = { SubnetId: "subnet-1", SecurityGroupIdList: ["sg-plat-old"], AvailabilityZone: "us-east-1a" };
    const r = await reconcileDatasourceNetwork(platformDs(), { via: "sync.ensure-job" });
    expect(r.kind).toBe("healed");
    if (r.kind !== "healed") return;
    expect(r.healed).toEqual([{ object: "security-group", from: "sg-plat-old", to: "sg-new-1" }, { object: "glue-connection", from: "subnet-1 / sg-plat-old", to: "subnet-1 / sg-new-1" }]);
    expect(r.healCount).toBe(1);
    const create = cmd("ec2", "CreateSecurityGroupCommand");
    expect(create).toHaveLength(1);
    expect(create[0].input.VpcId).toBe("vpc-1");
    expect(create[0].input.GroupName).toBe("bgp-ds-AADS0133");
    expect(create[0].input.TagSpecifications).toEqual([{ ResourceType: "security-group", Tags: TAGS }]);
    expect(cmd("ec2", "AuthorizeSecurityGroupIngressCommand")).toHaveLength(2);
    const upd = cmd("glue", "UpdateConnectionCommand");
    expect(upd).toHaveLength(1);
    expect(upd[0].input.Name).toBe(CONN);
    expect(upd[0].input.ConnectionInput.PhysicalConnectionRequirements.SecurityGroupIdList).toEqual(["sg-new-1"]);
    expect(upd[0].input.ConnectionInput.PhysicalConnectionRequirements.SubnetId).toBe("subnet-1");
    // B-133 第二刀:源行没有 AZ,接回的连接仍必须带子网的可用区(UpdateConnection 整体替换 PhysicalConnectionRequirements,缺了作业起不来)
    expect(upd[0].input.ConnectionInput.PhysicalConnectionRequirements.AvailabilityZone).toBe("us-east-1a");
    expect((decodePatch(h.patches[0]).networkConfig as any).availabilityZone).toBe("us-east-1a");
    expect(cmd("glue", "CreateConnectionCommand")).toHaveLength(0);
    expect(h.patches).toHaveLength(1);
    const p = decodePatch(h.patches[0]);
    expect(p.networkState).toBe("healed");
    expect(p.healCount).toBe(1);
    expect(p.networkIssue).toBeNull();
    expect((p.networkConfig as any).securityGroupId).toBe("sg-new-1");
    expect((p.networkConfig as any).subnetId).toBe("subnet-1");
    expect(typeof p.lastHealedAt).toBe("string");
    expect(h.patches[0].ConditionExpression).toBe("attribute_exists(datasourceId)");
    expect(audit.writeAuditRecord).toHaveBeenCalledTimes(1);
    expect((audit.writeAuditRecord.mock.calls[0] as any)[0]).toEqual({ actor: "system:datasource-network-reconcile" });
    expect((audit.writeAuditRecord.mock.calls[0] as any)[1]).toBe(AUDIT_ACTION_HEALED);
    expect((audit.writeAuditRecord.mock.calls[0] as any)[2].resourceId).toBe(DS_ID);
    expect(alerts.putEventIfNew).toHaveBeenCalledTimes(1);
    const ev = (alerts.putEventIfNew.mock.calls[0] as any)[0];
    expect(ev.ruleId).toBe(NETWORK_DRIFT_ALERT_RULE_ID);
    expect(ev.severity).toBe("P2");
    expect(ev.message).toContain("已自动重建并接回");
    expect(ev.message).toContain("bgp:managed");
  });

  it("请求内传 actor ⇒ 审计用它(不是系统身份);healCount 在源行已有值上 +1", async () => {
    delete h.sgs["sg-plat-old"];
    const r = await reconcileDatasourceNetwork(platformDs({ healCount: 3 }), { via: "ds.discovery", actor: { actor: "alice@example.com" } });
    expect(r.kind).toBe("healed");
    expect((audit.writeAuditRecord.mock.calls[0] as any)[0]).toEqual({ actor: "alice@example.com" });
    expect(decodePatch(h.patches[0]).healCount).toBe(4);
  });

  it("Glue 连接被删 ⇒ 由源行 + 密钥 CreateConnection 重建(名字 / 子网 / 组逐字),healed glue-connection", async () => {
    h.conn = null;
    const r = await reconcileDatasourceNetwork(platformDs(), { via: "sweep" });
    expect(r.kind).toBe("healed");
    if (r.kind !== "healed") return;
    expect(r.healed).toEqual([{ object: "glue-connection", to: CONN }]);
    const create = cmd("glue", "CreateConnectionCommand");
    expect(create).toHaveLength(1);
    expect(create[0].input.ConnectionInput.Name).toBe(CONN);
    // B-133 第二刀:源行没有 AZ ⇒ 重建的连接的 AvailabilityZone 来自子网事实(DescribeSubnets),不是 undefined
    expect(create[0].input.ConnectionInput.PhysicalConnectionRequirements).toEqual({ SubnetId: "subnet-1", SecurityGroupIdList: ["sg-plat-old"], AvailabilityZone: "us-east-1a" });
    expect(cmd("sm", "GetSecretValueCommand")).toHaveLength(1);
    expect(ec2Writes()).toHaveLength(0);
  });

  it("连接引用的组 / 子网与源行不一致(别人改了连接)⇒ UpdateConnection 接回,不建组", async () => {
    h.conn = { SubnetId: "subnet-1", SecurityGroupIdList: ["sg-stale"], AvailabilityZone: "us-east-1a" };
    const r = await reconcileDatasourceNetwork(platformDs(), { via: "sweep" });
    expect(r.kind).toBe("healed");
    expect(cmd("glue", "UpdateConnectionCommand")[0].input.ConnectionInput.PhysicalConnectionRequirements.SecurityGroupIdList).toEqual(["sg-plat-old"]);
    expect(ec2Writes()).toHaveLength(0);
  });

  it("平台探测选的子网被删 ⇒ 按建源同一探测重选(同 VPC)⇒ 连接接回新子网;VPC 变了 ⇒ 组也在新 VPC 重建", async () => {
    h.subnets = new Set(["subnet-default"]); // 源行的 subnet-1 没了;重选的缺省子网在(在 1b)
    process.env.DEFAULT_AZ = "us-east-1b"; // 部署接线里 DEFAULT_AZ 与 DEFAULT_SUBNET_ID 同一子网;两者若矛盾,写连接作者会抛(见下一条判据)
    const r1 = await reconcileDatasourceNetwork(platformDs(), { via: "sweep" });
    expect(r1.kind).toBe("healed");
    if (r1.kind !== "healed") return;
    expect(r1.healed.map((x) => x.object)).toEqual(["subnet", "glue-connection"]);
    expect(cmd("glue", "UpdateConnectionCommand")[0].input.ConnectionInput.PhysicalConnectionRequirements.SubnetId).toBe("subnet-default");
    // AZ 跟着**新子网的事实**走(1b),不是环境变量 DEFAULT_AZ(1a)也不是源行(没有)
    expect(cmd("glue", "UpdateConnectionCommand")[0].input.ConnectionInput.PhysicalConnectionRequirements.AvailabilityZone).toBe("us-east-1b");
    expect(ec2Writes()).toHaveLength(0);
    expect((decodePatch(h.patches[0]).networkConfig as any).subnetId).toBe("subnet-default");

    h.calls.length = 0; h.patches.length = 0;
    process.env.DEFAULT_VPC_ID = "vpc-2";
    const r2 = await reconcileDatasourceNetwork(platformDs(), { via: "sweep" });
    expect(r2.kind).toBe("healed");
    if (r2.kind !== "healed") return;
    expect(r2.healed.map((x) => x.object)).toEqual(["subnet", "security-group", "glue-connection"]);
    expect(cmd("ec2", "CreateSecurityGroupCommand")[0].input.VpcId).toBe("vpc-2");
    expect((decodePatch(h.patches[0]).networkConfig as any)).toMatchObject({ vpcId: "vpc-2", subnetId: "subnet-default", securityGroupId: "sg-new-1" });
  });

  it("B-133 第二刀:写连接的作者按子网事实取 AZ —— 调用方给的 AZ 与子网矛盾 ⇒ 拒绝写(零 UpdateConnection);子网不在 ⇒ 拒绝写", async () => {
    await expect(updateGlueConnectionNetwork(CONN, { subnetId: "subnet-1", securityGroupIds: ["sg-plat-old"], availabilityZone: "us-east-1z" }, "us-east-1"))
      .rejects.toThrow(/可用区矛盾.*us-east-1z.*us-east-1a/);
    expect(cmd("glue", "UpdateConnectionCommand")).toHaveLength(0);
    await expect(updateGlueConnectionNetwork(CONN, { subnetId: "subnet-gone", securityGroupIds: ["sg-plat-old"] }, "us-east-1"))
      .rejects.toThrow(/subnet-gone.*不存在.*拒绝写/);
    expect(cmd("glue", "UpdateConnectionCommand")).toHaveLength(0);
    // 调用方不给 AZ(改网络抽屉 / 自愈按源行)⇒ 按子网事实补齐
    await updateGlueConnectionNetwork(CONN, { subnetId: "subnet-1", securityGroupIds: ["sg-plat-old"] }, "us-east-1");
    expect(cmd("glue", "UpdateConnectionCommand")[0].input.ConnectionInput.PhysicalConnectionRequirements.AvailabilityZone).toBe("us-east-1a");
  });

  it("都在:有标签 ⇒ 零写零落行;存量无标签的平台组 ⇒ 只补 CreateTags(三个标签逐字),结论仍 intact", async () => {
    const r = await reconcileDatasourceNetwork(platformDs(), { via: "sweep" });
    expect(r).toEqual({ kind: "intact" });
    expect(ec2Writes()).toHaveLength(0); expect(glueWrites()).toHaveLength(0); expect(h.patches).toHaveLength(0);
    expect(audit.writeAuditRecord).not.toHaveBeenCalled(); expect(alerts.putEventIfNew).not.toHaveBeenCalled();

    h.calls.length = 0;
    h.sgs["sg-plat-old"].Tags = [];
    const r2 = await reconcileDatasourceNetwork(platformDs(), { via: "sweep" });
    expect(r2).toEqual({ kind: "intact" });
    const tag = cmd("ec2", "CreateTagsCommand");
    expect(tag).toHaveLength(1);
    expect(tag[0].input).toEqual({ Resources: ["sg-plat-old"], Tags: TAGS });
    expect(ec2Writes()).toEqual(tag);
    expect(h.patches).toHaveLength(0);
  });

  it("之前 broken、现在对象都在(有人恢复了)⇒ 源行改回 intact / networkIssue null", async () => {
    const r = await reconcileDatasourceNetwork(platformDs({ networkState: "broken", networkIssue: { object: "security-group", objectId: "sg-plat-old", userOwned: false, message: "旧", at: "2026-10-28T00:00:00Z" } }), { via: "sweep" });
    expect(r).toEqual({ kind: "intact" });
    expect(h.patches).toHaveLength(1);
    expect(decodePatch(h.patches[0])).toMatchObject({ networkState: "intact", networkIssue: null });
  });
});

describe("reconcileDatasourceNetwork —— 用户拥有的对象 / 密钥:一个不碰,broken 点名并指路", () => {
  it("用户指定的组之一被删 ⇒ 零 EC2 / Glue 写 ⇒ broken(userOwned,点名 sg-user-2,指到编辑 → 网络配置)⇒ 源行 status=error + broken ⇒ 审计 broken ⇒ 告警 P1", async () => {
    delete h.sgs["sg-user-2"];
    h.conn = { SubnetId: "subnet-1", SecurityGroupIdList: ["sg-user-1", "sg-user-2"], AvailabilityZone: "us-east-1a" };
    const r = await reconcileDatasourceNetwork(userDs(), { via: "sync.ensure-job" });
    expect(r.kind).toBe("broken");
    if (r.kind !== "broken") return;
    expect(r.issue).toMatchObject({ object: "security-group", objectId: "sg-user-2", userOwned: true });
    expect(r.message).toContain("sg-user-2");
    expect(r.message).toContain("不是平台建的");
    expect(r.message).toContain("网络配置");
    expect(ec2Writes()).toHaveLength(0); expect(glueWrites()).toHaveLength(0);
    expect(h.patches).toHaveLength(1);
    expect(decodePatch(h.patches[0])).toMatchObject({ status: "error", networkState: "broken", networkIssue: { object: "security-group", objectId: "sg-user-2", userOwned: true } });
    expect((audit.writeAuditRecord.mock.calls[0] as any)[1]).toBe(AUDIT_ACTION_BROKEN);
    expect((alerts.putEventIfNew.mock.calls[0] as any)[0]).toMatchObject({ ruleId: NETWORK_DRIFT_ALERT_RULE_ID, severity: "P1" });
  });

  it("用户指定的子网被删 ⇒ broken(subnet,userOwned),不探测不重选", async () => {
    h.subnets = new Set();
    const r = await reconcileDatasourceNetwork(userDs(), { via: "sweep" });
    expect(r.kind).toBe("broken");
    if (r.kind !== "broken") return;
    expect(r.issue).toMatchObject({ object: "subnet", objectId: "subnet-1", userOwned: true });
    expect(cmd("rds", "DescribeDBInstancesCommand")).toHaveLength(0);
    expect(ec2Writes()).toHaveLength(0); expect(glueWrites()).toHaveLength(0);
  });

  it("连接被删且凭证密钥也不在 ⇒ broken(secret),不建连接,文案指到「编辑 → 重新输入账号口令」", async () => {
    h.conn = null; h.secretMissing = true;
    const r = await reconcileDatasourceNetwork(platformDs(), { via: "sweep" });
    expect(r.kind).toBe("broken");
    if (r.kind !== "broken") return;
    expect(r.issue).toMatchObject({ object: "secret", userOwned: true });
    expect(r.message).toContain("重新输入账号口令");
    expect(cmd("glue", "CreateConnectionCommand")).toHaveLength(0);
  });

  it("同一个缺口已落过行(networkState=broken 且 issue 相同)⇒ 零写零审计零告警,只还原话(巡检 / 连点启动不刷屏)", async () => {
    delete h.sgs["sg-user-2"];
    const prev = { object: "security-group" as const, objectId: "sg-user-2", userOwned: true, message: "已登记过的原话", at: "2026-10-28T00:00:00Z" };
    const r = await reconcileDatasourceNetwork(userDs({ networkState: "broken", networkIssue: prev }), { via: "sweep" });
    expect(r).toEqual({ kind: "broken", issue: prev, message: "已登记过的原话" });
    expect(h.patches).toHaveLength(0);
    expect(audit.writeAuditRecord).not.toHaveBeenCalled(); expect(alerts.putEventIfNew).not.toHaveBeenCalled();
  });
});

describe("reconcileDatasourceNetwork —— 边界", () => {
  it("事实读失败(限流)⇒ unverifiable,零写零落行零审计(不拦业务,Glue 自己会报)", async () => {
    h.throttle = true;
    const r = await reconcileDatasourceNetwork(platformDs(), { via: "sync.ensure-job" });
    expect(r.kind).toBe("unverifiable");
    expect(ec2Writes()).toHaveLength(0); expect(glueWrites()).toHaveLength(0); expect(h.patches).toHaveLength(0);
    expect(audit.writeAuditRecord).not.toHaveBeenCalled();
  });
  it("非 JDBC / 没有 Glue 连接 / 没有网络配置 ⇒ intact skipped,零 AWS 调用", async () => {
    expect(await reconcileDatasourceNetwork(platformDs({ networkConfig: undefined }), { via: "x" })).toEqual({ kind: "intact", skipped: "non-jdbc-or-no-network-config" });
    expect(await reconcileDatasourceNetwork(platformDs({ glueConnectionName: undefined }), { via: "x" })).toEqual({ kind: "intact", skipped: "non-jdbc-or-no-network-config" });
    expect(await reconcileDatasourceNetwork(platformDs({ type: "s3", connection: { bucket: "b" } }), { via: "x" })).toEqual({ kind: "intact", skipped: "non-jdbc-or-no-network-config" });
    expect(h.calls).toHaveLength(0);
  });
});

describe("noteNetworkDriftFromRunError —— 运行终态原话命中漂移 ⇒ 源行标 broken", () => {
  it("Security Group Not Found ⇒ 分类 + 源行 networkState=broken 带 objectId;认不出的原话不落行", async () => {
    const raw = "failed to execute with exception Security Group Not Found The security group 'sg-07f9a7c9ddd9cb680' does not exist";
    const c = await noteNetworkDriftFromRunError({ datasourceId: DS_ID }, raw);
    expect(c.kind).toBe("network-drift-security-group");
    expect(h.patches).toHaveLength(1);
    expect(decodePatch(h.patches[0])).toMatchObject({ networkState: "broken", networkIssue: { object: "security-group", objectId: "sg-07f9a7c9ddd9cb680", userOwned: false } });
    h.patches.length = 0;
    expect((await noteNetworkDriftFromRunError({ datasourceId: DS_ID }, "OutOfMemoryError")).kind).toBe("unknown");
    expect(h.patches).toHaveLength(0);
  });
});
