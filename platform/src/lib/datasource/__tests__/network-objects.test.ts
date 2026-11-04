// 系统设置「数据源网络对象」清单与孤儿清理(唯一作者 lib/datasource/network-objects.ts)的判据。
//
// 🔴 只 mock 真外部:EC2 事实读取(datasource-service 的三个只读函数)、注册表、DDB、作业表存储。
//    network-objects ↔ sg-cleanup-job(入队)之间不 mock:入队走真的 enqueueSgCleanup ⇒ createJob(作业表存储被 mock)。
// 判据钉:归属 = 源行引用(不是标签);孤儿才查网卡;读不到的区如实列出;清理前服务端重核三条件;占位 datasourceId 末 8 位 == 组名后缀。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  sgByRegion: {} as Record<string, Array<{ groupId: string; groupName: string; vpcId?: string; tags: Record<string, string> }>>,
  unreadable: new Set<string>(),
  eni: {} as Record<string, number>,
  dsRows: [] as Array<Record<string, unknown>>,
  jobs: [] as any[],
  created: [] as any[],
}));

vi.mock("@/lib/aws/datasource-service", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    listPlatformDsSecurityGroups: vi.fn(async (region: string) => { if (h.unreadable.has(region)) throw new Error("UnauthorizedOperation"); return h.sgByRegion[region] ?? []; }),
    describeSecurityGroupsById: vi.fn(async (ids: string[], region: string) => new Map((h.sgByRegion[region] ?? []).filter((g) => ids.includes(g.groupId)).map((g) => [g.groupId, g]))),
    countNetworkInterfacesInSecurityGroup: vi.fn(async (sgId: string) => h.eni[sgId] ?? 0),
  };
});
vi.mock("@/lib/exec-env/registry", () => ({
  listTargetsRaw: vi.fn(async () => [{ targetId: "tgt_home", region: "us-east-1", status: "active" }, { targetId: "tgt_usw2_a", region: "us-west-2", status: "active" }]),
}));
vi.mock("@/lib/dataplane-jobs/store", () => ({
  listJobsByTarget: vi.fn(async (targetId: string) => h.jobs.filter((j) => j.targetId === targetId)),
  getJob: vi.fn(async () => null),
  createJob: vi.fn(async (input: any) => { h.created.push(input); return { created: true, job: { jobId: `dpj_${input.idempotencyKey}`, phase: "queued" } }; }),
}));
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { DATASOURCES: "bgp-datasources", DATAPLANE_JOBS: "bgp-dataplane-jobs" },
  docClient: { send: vi.fn(async (cmd: any) => (cmd.constructor.name === "ScanCommand" ? { Items: h.dsRows } : {})) },
}));

import { listDatasourceNetworkObjects, requestOrphanSgCleanup, securityGroupRefsOfRow, NetworkObjectError } from "@/lib/datasource/network-objects";
import { countNetworkInterfacesInSecurityGroup } from "@/lib/aws/datasource-service";

beforeEach(() => {
  h.created.length = 0; h.unreadable = new Set(); h.eni = {};
  h.sgByRegion = {
    "us-east-1": [
      { groupId: "sg-0000000000000001", groupName: "bgp-ds-AADS0001", vpcId: "vpc-1", tags: { "bgp:managed": "datasource", "bgp:datasourceId": "01HXAAAAAAAAAAAAAAAADS0001" } },
      { groupId: "sg-0000000000000002", groupName: "bgp-ds-AADS0002", vpcId: "vpc-1", tags: {} },
      { groupId: "sg-0000000000000003", groupName: "bgp-ds-AADS0003", vpcId: "vpc-1", tags: { "bgp:managed": "datasource", "bgp:datasourceId": "01HXAAAAAAAAAAAAAAAADS0003" } },
      { groupId: "sg-0000000000000004", groupName: "custom-name", vpcId: "vpc-1", tags: { "bgp:managed": "datasource" } },
    ],
    "us-west-2": [],
  };
  h.dsRows = [
    { datasourceId: "01HXAAAAAAAAAAAAAAAADS0001", name: "GameData-MySQL", networkConfig: { securityGroupId: "sg-0000000000000001", subnetId: "subnet-1" } },
    { datasourceId: "01HXAAAAAAAAAAAAAAAADS0009", name: "UserNet", networkConfig: { securityGroupId: "sg-u1", securityGroupIds: ["sg-u1", "sg-u2"], platformSecurityGroupId: "sg-legacy" } },
  ];
  h.jobs = [{ jobId: "dpj_x", targetId: "tgt_home", kind: "sg-cleanup", phase: "waiting", createdAt: "2026-10-28T10:00:00Z", state: { sgId: "sg-0000000000000003" }, evidence: {} }];
  (countNetworkInterfacesInSecurityGroup as any).mockClear();
});

describe("securityGroupRefsOfRow:源行引用的全部组", () => {
  it("主组 / 用户指定的全部 / 存量多建的平台组各带角色,去重", () => {
    expect(securityGroupRefsOfRow(h.dsRows[1])).toEqual([
      { sgId: "sg-u1", role: "primary" }, { sgId: "sg-u2", role: "user-specified" }, { sgId: "sg-legacy", role: "legacy-platform" },
    ]);
    expect(securityGroupRefsOfRow({})).toEqual([]);
  });
});

describe("listDatasourceNetworkObjects", () => {
  it("归属按源行引用;孤儿 / 待清理 / 在用三态;只对非在用的组查网卡;无标签存量组 tagged=false", async () => {
    h.eni["sg-0000000000000002"] = 0;
    const v = await listDatasourceNetworkObjects();
    const by = Object.fromEntries(v.objects.map((o) => [o.sgId, o]));
    expect(by["sg-0000000000000001"]).toMatchObject({ status: "in-use", owner: { datasourceId: "01HXAAAAAAAAAAAAAAAADS0001", name: "GameData-MySQL", role: "primary" }, tagged: true, region: "us-east-1", targetId: "tgt_home" });
    expect(by["sg-0000000000000001"].eniCount).toBeUndefined();
    expect(by["sg-0000000000000002"]).toMatchObject({ status: "orphan", owner: null, tagged: false, eniCount: 0 });
    expect(by["sg-0000000000000003"]).toMatchObject({ status: "pending-cleanup", owner: null, cleanupJob: { jobId: "dpj_x", phase: "waiting" } });
    expect(by["sg-0000000000000004"]).toMatchObject({ status: "orphan", tagged: true, groupName: "custom-name" });
    const eniCalls = (countNetworkInterfacesInSecurityGroup as any).mock.calls.map((c: any[]) => c[0]).sort();
    expect(eniCalls).toEqual(["sg-0000000000000002", "sg-0000000000000003", "sg-0000000000000004"]);
    expect(v.unreadableRegions).toEqual([]);
    // 在用排最后
    expect(v.objects[v.objects.length - 1].sgId).toBe("sg-0000000000000001");
  });
  it("某区读不到 ⇒ 如实进 unreadableRegions,别的区照常列", async () => {
    h.unreadable.add("us-west-2");
    const v = await listDatasourceNetworkObjects();
    expect(v.unreadableRegions).toEqual([{ targetId: "tgt_usw2_a", region: "us-west-2", error: "UnauthorizedOperation" }]);
    expect(v.objects.length).toBe(4);
  });
});

describe("requestOrphanSgCleanup:服务端重核三条件,过了才入清理作业", () => {
  const ok = { region: "us-east-1", targetId: "tgt_home", createdBy: "admin" };
  it("参数形态 / 不存在 / 不是平台组 / 仍被源行引用 / 仍有网卡 ⇒ 各自 400 / 404 / 409,零入队", async () => {
    await expect(requestOrphanSgCleanup({ ...ok, sgId: "nope" })).rejects.toMatchObject({ status: 400 });
    await expect(requestOrphanSgCleanup({ ...ok, sgId: "sg-00000000000000ff" })).rejects.toMatchObject({ status: 404 });
    h.sgByRegion["us-east-1"].push({ groupId: "sg-00000000000000c1", groupName: "my-own", tags: {} });
    await expect(requestOrphanSgCleanup({ ...ok, sgId: "sg-00000000000000c1" })).rejects.toMatchObject({ status: 409 });
    h.sgByRegion["us-east-1"].push({ groupId: "sg-00000000000000c2", groupName: "bgp-ds-AADS0001", tags: {} });
    h.dsRows.push({ datasourceId: "x", name: "Still-Used", networkConfig: { securityGroupId: "sg-00000000000000c2" } });
    const e = await requestOrphanSgCleanup({ ...ok, sgId: "sg-00000000000000c2" }).catch((x) => x);
    expect(e).toBeInstanceOf(NetworkObjectError);
    expect(e.status).toBe(409);
    expect(e.message).toContain("Still-Used");
    h.sgByRegion["us-east-1"].push({ groupId: "sg-00000000000000c3", groupName: "bgp-ds-AADS0007", tags: {} });
    h.eni["sg-00000000000000c3"] = 2;
    await expect(requestOrphanSgCleanup({ ...ok, sgId: "sg-00000000000000c3" })).rejects.toMatchObject({ status: 409 });
    expect(h.created).toHaveLength(0);
  });
  it("真孤儿 ⇒ 入队:有标签取标签里的源 id;无标签用组名后缀构造占位 id(末 8 位相同,清理作业的归属判定才能过)", async () => {
    h.sgByRegion["us-east-1"].push({ groupId: "sg-00000000000000c5", groupName: "bgp-ds-AADS0005", tags: { "bgp:managed": "datasource", "bgp:datasourceId": "01HXAAAAAAAAAAAAAAAADS0005" } });
    const r1 = await requestOrphanSgCleanup({ ...ok, sgId: "sg-00000000000000c5" });
    expect(r1).toMatchObject({ created: true, phase: "queued", datasourceId: "01HXAAAAAAAAAAAAAAAADS0005" });
    expect(h.created[0]).toMatchObject({ kind: "sg-cleanup", targetId: "tgt_home", subject: "01HXAAAAAAAAAAAAAAAADS0005", state: { sgId: "sg-00000000000000c5", region: "us-east-1", datasourceId: "01HXAAAAAAAAAAAAAAAADS0005" }, createdBy: "admin" });
    const r2 = await requestOrphanSgCleanup({ ...ok, sgId: "sg-0000000000000002" });
    expect(r2.datasourceId).toBe("orphan-AADS0002");
    expect(r2.datasourceId.slice(-8)).toBe("AADS0002");
    expect(h.created[1].state.datasourceId).toBe("orphan-AADS0002");
  });
});
