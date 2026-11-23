// 复制实例的生命周期判据:实例会被空闲回收(或人工删除)再由下一次「启动」重建,取 ARN 的两个入口必须跟得上。
//
// 2026-11-16 真环境:实例被回收之后,同一平台进程里再点 DMS「启动」⇒ 日志「Replication Instance ARN … does not exist」、任务落到异常,
//   平台不重启就一直失败 —— 取 ARN 的函数把第一次查到的 ARN 记在进程里,实例删了也不失效。
//   同一处的相邻缺口:实例正在删除时点「启动」被当成「状态异常」拒掉,而不是等它删完再建。
//
// 只 mock 真外部(DMS / EC2 SDK)。假 DMS 与真服务同形:
//   · 按 id 查不到是**抛** ResourceNotFoundFault,不是回空数组;
//   · 同名实例还在(含删除中)时 Create 抛 ResourceAlreadyExistsFault;
//   · 每次新建换一个 ARN;创建中 / 删除中都要读过若干次才变。
// 等待按产品真实的节奏与预算在假时钟里跑(20 秒一轮;冷建 30 分钟、等删除 20 分钟),不给产品加旋钮。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { homeDmsPlace, regionDmsPlace } from "./fixtures/dms-place";

const h = vi.hoisted(() => ({
  /** null = 实例不存在 */
  inst: null as null | { arn: string; status: string },
  gen: 0,
  /** 还要读到几次「创建中」才变 available(Create 时装填) */
  creatingReads: 2,
  creatingLeft: 0,
  /** 还要读到几次「删除中」实例才消失(0 = 一直删不完) */
  deletingLeft: 0,
  calls: [] as string[],
  /** 每次 Create 到达那一刻实例的状态(「missing」= 确实不存在) */
  createSeenAt: [] as string[],
  /** Create 到达服务的那一瞬先发生的事(造「另一条启动抢先建了」) */
  onCreate: null as null | (() => void),
  sg: "sg-dms" as string | null,
  /** 每次调用打到哪个区(客户端按落点的区建;同名对象在别的区互不可见) */
  regions: [] as string[],
  /** 最近一次 Create 的入参 / 最近一次按名查安全组的入参 */
  lastCreate: null as null | Record<string, unknown>,
  lastSgFilter: null as null | { region: string; names: string[] },
}));

vi.mock("@aws-sdk/client-database-migration-service", () => {
  const mk = (n: string) => { const C = class { constructor(public input: any) {} }; Object.defineProperty(C, "name", { value: n }); return C; };
  const fault = (name: string, msg: string) => { const e: any = new Error(msg); e.name = name; return e; };
  class DatabaseMigrationServiceClient {
    constructor(public cfg: any) {}
    async send(cmd: any) {
      const n = cmd.constructor.name as string;
      h.calls.push(n);
      h.regions.push(String(this.cfg?.region));
      if (n === "DescribeReplicationInstancesCommand") {
        if (h.inst?.status === "deleting" && h.deletingLeft > 0 && --h.deletingLeft === 0) h.inst = null;
        if (!h.inst) throw fault("ResourceNotFoundFault", "No Replication Instances found matching the filter criteria");
        if (h.inst.status === "creating") {
          if (h.creatingLeft > 0) h.creatingLeft--;
          else h.inst.status = "available";
        }
        return { ReplicationInstances: [{ ReplicationInstanceArn: h.inst.arn, ReplicationInstanceStatus: h.inst.status }] };
      }
      if (n === "CreateReplicationInstanceCommand") {
        h.createSeenAt.push(h.inst?.status ?? "missing");
        h.lastCreate = cmd.input;
        h.onCreate?.();
        if (h.inst) throw fault("ResourceAlreadyExistsFault", `Replication instance ${cmd.input.ReplicationInstanceIdentifier} already exists`);
        h.inst = { arn: `arn:dms:rep:GEN${++h.gen}`, status: "creating" };
        h.creatingLeft = h.creatingReads;
        return {};
      }
      return {};
    }
  }
  const names = [
    "CreateEndpointCommand", "DescribeEndpointsCommand", "ModifyEndpointCommand", "CreateReplicationTaskCommand", "ModifyReplicationTaskCommand",
    "DescribeReplicationTasksCommand", "StartReplicationTaskCommand", "StopReplicationTaskCommand", "DeleteReplicationTaskCommand",
    "TestConnectionCommand", "DescribeConnectionsCommand", "DescribeTableStatisticsCommand", "DescribeReplicationInstancesCommand",
    "CreateReplicationInstanceCommand", "DeleteEndpointCommand",
  ];
  return { DatabaseMigrationServiceClient, ...Object.fromEntries(names.map((x) => [x, mk(x)])) };
});
vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client {
    constructor(public cfg: any) {}
    async send(cmd: any) {
      h.lastSgFilter = { region: String(this.cfg?.region), names: cmd.input?.Filters?.[0]?.Values ?? [] };
      return { SecurityGroups: h.sg ? [{ GroupId: h.sg }] : [] };
    }
  }
  class DescribeSecurityGroupsCommand { constructor(public input: any) {} }
  return { EC2Client, DescribeSecurityGroupsCommand };
});

const realSetTimeout = globalThis.setTimeout;
/** 在假时钟里把一次调用跑到返回 / 抛错(每轮推进 10 秒虚拟时间,再让出真事件循环);回结果与虚拟耗时。 */
async function run<T>(fn: () => Promise<T>, maxMin = 90): Promise<{ ok: true; value: T; virtualMs: number } | { ok: false; error: Error; virtualMs: number }> {
  vi.useFakeTimers();
  try {
    const t0 = Date.now();
    let out: { ok: true; value: T } | { ok: false; error: Error } | null = null;
    fn().then((value) => { out = { ok: true, value }; }, (error) => { out = { ok: false, error }; });
    for (let i = 0; i < maxMin * 6 && !out; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      await new Promise((r) => realSetTimeout(r, 0));
    }
    if (!out) throw new Error(`调用在 ${maxMin} 分钟虚拟时间内没有结束(calls=${h.calls.slice(-6).join(",")})`);
    return { ...(out as { ok: true; value: T } | { ok: false; error: Error }), virtualMs: Date.now() - t0 };
  } finally {
    vi.useRealTimers();
  }
}
const creates = () => h.calls.filter((c) => c === "CreateReplicationInstanceCommand").length;
const svc = () => import("../dms-service");
// 落点夹具(主控区 / 一个执行区),形态与落点解析器产出的一致
const HOME = homeDmsPlace();
const USW2 = regionDmsPlace();

beforeEach(() => {
  h.inst = null; h.gen = 0; h.creatingReads = 2; h.creatingLeft = 0; h.deletingLeft = 0;
  h.calls.length = 0; h.createSeenAt = []; h.onCreate = null; h.sg = "sg-dms";
  h.regions.length = 0; h.lastCreate = null; h.lastSgFilter = null;
  vi.resetModules();
});
afterEach(() => { vi.useRealTimers(); });

describe("复制实例被回收之后,下一次启动要能把它重新建出来", () => {
  it("🔴🔴 同一进程里:取到过 ARN → 实例被删 → 再取 ⇒ 重新懒创建并回**新** ARN(改动前回的是已删实例的 ARN)", async () => {
    const { getReplicationInstanceArn, probeReplicationInstance } = await svc();
    h.inst = { arn: "arn:dms:rep:OLD", status: "available" };
    const first = await run(() => getReplicationInstanceArn(HOME));
    expect(first).toMatchObject({ ok: true, value: "arn:dms:rep:OLD" });
    // 空闲回收把它删掉了(删完了)
    h.inst = null;
    const probe = await probeReplicationInstance(HOME);
    expect(probe, "请求路径那一眼也必须看到真实现状:实例没了 ⇒ 发起懒创建").toMatchObject({ status: "creating", requestedCreate: true });
    expect(probe.arn).toBe("arn:dms:rep:GEN1");
    const second = await run(() => getReplicationInstanceArn(HOME));
    expect(second).toMatchObject({ ok: true, value: "arn:dms:rep:GEN1" });
    expect(creates(), "只建一次").toBe(1);
  });

  it("每次取都问服务:实例换了 ARN(删后重建)⇒ 下一次取到的就是新的,不会停在旧的上", async () => {
    const { getReplicationInstanceArn } = await svc();
    h.inst = { arn: "arn:dms:rep:A", status: "available" };
    expect((await run(() => getReplicationInstanceArn(HOME)))).toMatchObject({ value: "arn:dms:rep:A" });
    h.inst = { arn: "arn:dms:rep:B", status: "available" };
    expect((await run(() => getReplicationInstanceArn(HOME)))).toMatchObject({ value: "arn:dms:rep:B" });
  });

  it("🔴 实例正在删除:那一眼如实回 deleting、不发 Create;后台等它删完 → 建 → 就位,回新 ARN(Create 只在旧实例消失之后发)", async () => {
    const { getReplicationInstanceArn, probeReplicationInstance, REPLICATION_INSTANCE_BROKEN_STATUSES } = await svc();
    expect(REPLICATION_INSTANCE_BROKEN_STATUSES, "删除中是回收之后的正常过渡态,不是坏了").not.toContain("deleting");
    h.inst = { arn: "arn:dms:rep:OLD", status: "deleting" }; h.deletingLeft = 20;      // 约 6 分半
    const probe = await probeReplicationInstance(HOME);
    expect(probe).toMatchObject({ status: "deleting", requestedCreate: false });
    expect(creates()).toBe(0);
    h.creatingReads = 40;                                                              // 约 13 分钟
    const r = await run(() => getReplicationInstanceArn(HOME));
    expect(r).toMatchObject({ ok: true, value: "arn:dms:rep:GEN1" });
    expect(h.createSeenAt, "旧实例还占着这个 id 时不许去建").toEqual(["missing"]);
    expect(r.virtualMs).toBeGreaterThan(15 * 60_000);
  });

  it("两段预算分开计:删除用掉 19 分钟,之后的冷建仍有完整的 30 分钟(合计 48 分钟也能等到)", async () => {
    const { getReplicationInstanceArn, REPLICATION_INSTANCE_WAIT, REPLICATION_INSTANCE_DELETE_WAIT } = await svc();
    const delMin = (REPLICATION_INSTANCE_DELETE_WAIT.intervalMs * REPLICATION_INSTANCE_DELETE_WAIT.maxAttempts) / 60_000;
    expect(delMin, "等删除的预算要盖住实测的 5–8 分钟并留余量,且有上限").toBeGreaterThanOrEqual(15);
    expect(delMin).toBeLessThanOrEqual(30);
    h.inst = { arn: "arn:dms:rep:OLD", status: "deleting" }; h.deletingLeft = 19 * 3;
    h.creatingReads = 29 * 3;
    const r = await run(() => getReplicationInstanceArn(HOME));
    expect(r).toMatchObject({ ok: true, value: "arn:dms:rep:GEN1" });
    expect(r.virtualMs).toBeGreaterThan(REPLICATION_INSTANCE_WAIT.intervalMs * REPLICATION_INSTANCE_WAIT.maxAttempts);
  });

  it("一直删不完 ⇒ 等满删除预算后如实抛「未就绪(当前状态 deleting …可稍后重试)」,期间一次 Create 都不发", async () => {
    const { getReplicationInstanceArn, REPLICATION_INSTANCE_DELETE_WAIT } = await svc();
    h.inst = { arn: "arn:dms:rep:OLD", status: "deleting" }; h.deletingLeft = 0;
    const r = await run(() => getReplicationInstanceArn(HOME));
    expect(r.ok).toBe(false);
    expect(String((r as { error: Error }).error.message)).toMatch(/未就绪\(当前状态 deleting,可稍后重试\)/);
    expect(creates()).toBe(0);
    const budget = REPLICATION_INSTANCE_DELETE_WAIT.intervalMs * REPLICATION_INSTANCE_DELETE_WAIT.maxAttempts;
    expect(r.virtualMs).toBeGreaterThanOrEqual(budget);
    expect(r.virtualMs).toBeLessThan(budget + 60_000);
  });

  it("一直建不好 ⇒ 等满冷建预算后如实抛「未就绪(当前状态 creating …)」", async () => {
    const { getReplicationInstanceArn, REPLICATION_INSTANCE_WAIT } = await svc();
    h.creatingReads = 100_000;
    const r = await run(() => getReplicationInstanceArn(HOME));
    expect(r.ok).toBe(false);
    expect(String((r as { error: Error }).error.message)).toMatch(/未就绪\(当前状态 creating,可稍后重试\)/);
    expect(creates()).toBe(1);
    const budget = REPLICATION_INSTANCE_WAIT.intervalMs * REPLICATION_INSTANCE_WAIT.maxAttempts;
    expect(r.virtualMs).toBeGreaterThanOrEqual(budget);
    expect(r.virtualMs).toBeLessThan(budget + 60_000);
  });

  it("实例 failed ⇒ 立刻抛「状态异常」,不等(等也不会自己好)", async () => {
    const { getReplicationInstanceArn } = await svc();
    h.inst = { arn: "arn:dms:rep:BAD", status: "failed" };
    const r = await run(() => getReplicationInstanceArn(HOME));
    expect(r.ok).toBe(false);
    expect(String((r as { error: Error }).error.message)).toMatch(/状态异常:failed/);
    expect(r.virtualMs).toBeLessThan(15_000);
  });

  it("🔴 两条启动同时看到实例不存在:后到的那次 Create 撞「已存在」⇒ 不是失败,读现状(创建中)照常往下等", async () => {
    const { probeReplicationInstance, getReplicationInstanceArn } = await svc();
    h.onCreate = () => { if (!h.inst) { h.inst = { arn: "arn:dms:rep:OTHER", status: "creating" }; h.creatingLeft = 3; } };
    const probe = await probeReplicationInstance(HOME);
    expect(probe, "这次没建成是因为别人先建了 ⇒ 不算本次发起").toMatchObject({ status: "creating", requestedCreate: false, arn: "arn:dms:rep:OTHER" });
    h.onCreate = null;
    const r = await run(() => getReplicationInstanceArn(HOME));
    expect(r).toMatchObject({ ok: true, value: "arn:dms:rep:OTHER" });
    expect(creates(), "实例已经在建,不再发第二次 Create").toBe(1);
  });

  it("Create 被服务拒(不是「已存在」)⇒ 照抛,不吞", async () => {
    const { probeReplicationInstance } = await svc();
    h.onCreate = () => { const e: any = new Error("not authorized to perform dms:CreateReplicationInstance"); e.name = "AccessDeniedException"; throw e; };
    await expect(probeReplicationInstance(HOME)).rejects.toThrow(/not authorized/);
  });

  it("实例不存在且安全组也没有(实时基建没部署)⇒ 如实报基建未就绪,不发 Create", async () => {
    const { probeReplicationInstance } = await svc();
    h.sg = null;
    await expect(probeReplicationInstance(HOME)).rejects.toThrow(/未就绪/);
    expect(creates()).toBe(0);
  });
});

describe("🔴 复制实例建在落点说的那个区,用那个区的名字(主控区与执行区同一条路)", () => {
  it("执行区落点:查 / 建都打在该区;实例名、子网组、安全组名都是该区的;主控区一次调用都没有", async () => {
    const { getReplicationInstanceArn } = await svc();
    const r = await run(() => getReplicationInstanceArn(USW2));
    expect(r).toMatchObject({ ok: true, value: "arn:dms:rep:GEN1" });
    expect(new Set(h.regions), "有调用打到了落点以外的区").toEqual(new Set(["us-west-2"]));
    expect(h.lastSgFilter).toEqual({ region: "us-west-2", names: ["bgp-dms-sg-tgt-usw2"] });
    expect(h.lastCreate).toMatchObject({
      ReplicationInstanceIdentifier: "bgp-dms-tgt-usw2",
      ReplicationSubnetGroupIdentifier: "bgp-dms-subnet-group-tgt-usw2",
      VpcSecurityGroupIds: ["sg-dms"],
      PubliclyAccessible: false,
    });
  });

  it("主控区落点:名字与改动前的字面缺省逐字相同(bgp-dms / bgp-dms-subnet-group / bgp-dms-sg),调用都在主控区", async () => {
    const { getReplicationInstanceArn } = await svc();
    await run(() => getReplicationInstanceArn(HOME));
    expect(new Set(h.regions)).toEqual(new Set(["us-east-1"]));
    expect(h.lastSgFilter).toEqual({ region: "us-east-1", names: ["bgp-dms-sg"] });
    expect(h.lastCreate).toMatchObject({ ReplicationInstanceIdentifier: "bgp-dms", ReplicationSubnetGroupIdentifier: "bgp-dms-subnet-group" });
  });

  it("执行区的安全组还没有(升级后没重新部署)⇒ 报错原话指路「重新部署」,不发 Create", async () => {
    const { probeReplicationInstance } = await svc();
    h.sg = null;
    await expect(probeReplicationInstance(USW2)).rejects.toThrow(/bgp-dms-sg-tgt-usw2 未就绪.*us-west-2.*执行环境.*tgt_usw2.*重新部署/);
    expect(creates()).toBe(0);
  });
});
