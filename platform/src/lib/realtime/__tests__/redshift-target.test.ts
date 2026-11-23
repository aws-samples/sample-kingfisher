// DMS → 数仓目标侧准备(lib/realtime/redshift-target.ts)的判据:每一步都按任务落点的那个区做。
//   只 mock 两个出口:受控 DDL 执行器(管理员 DDL 的唯一通道;它自己的准入 / 审计 / 语句在 lib/exec-env/__tests__/admin-ddl-executor.test.ts,
//   两者不 mock 的全链在本目录 dms-pushdown-assembly.test.ts)与该区的 Redshift Serverless 客户端工厂。
//   判据:
//     ① 专用用户:缺省「有则复用」、只在明说时才重设口令;请求带的是落点的执行环境;返回密钥名与「是不是这次新供给的」;
//     ② 同一个区的并发首次启动排队(后到的等前一条写完,不会两条同时建用户 / 写密钥);不同区互不等待;前一条失败不连累后一条;
//     ③ 目标 schema 经受控通道的固定模板建在落点的区;
//     ④ 访问角色关联:命名空间名从该区工作组的事实里取(不读环境变量、不猜名字),已关联不重复写,命名空间被占用时退避重试。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  provisions: [] as Array<{ reason: string; targetId: string; rotate: boolean }>,
  ddl: [] as Array<{ reason: string; request: Record<string, unknown> }>,
  /** 供给入口此刻在途的调用数(按区)与出现过的最大并发 */
  inflight: {} as Record<string, number>,
  maxInflight: {} as Record<string, number>,
  /** 每次供给要等的毫秒数(假时钟推进)与要抛的错(用一次) */
  provisionDelayMs: 0,
  provisionErrors: [] as Array<Error | null>,
  outcome: "reused" as "reused" | "provisioned",
  rsCalls: [] as Array<{ region: string; cmd: string; input: Record<string, any> }>,
  /** region → 工作组名 → 命名空间名 */
  workgroups: {} as Record<string, Record<string, string | undefined>>,
  /** region → 命名空间名 → 已关联角色(Redshift 回的形态:`IamRole(applyStatus=in-sync, iamRoleArn=…)`) */
  namespaces: {} as Record<string, Record<string, string[]>>,
  updateConflicts: 0,
}));

vi.mock("@/lib/exec-env/admin-ddl-executor", () => ({
  systemActor: (reason: string) => ({ actor: `system:${reason}`, isPlatformAdmin: true, reason }),
  provisionDmsIngestUser: vi.fn(async (actor: { reason: string }, req: { targetId: string; rotate?: boolean }) => {
    h.provisions.push({ reason: actor.reason, targetId: req.targetId, rotate: req.rotate === true });
    h.inflight[req.targetId] = (h.inflight[req.targetId] ?? 0) + 1;
    h.maxInflight[req.targetId] = Math.max(h.maxInflight[req.targetId] ?? 0, h.inflight[req.targetId]);
    try {
      if (h.provisionDelayMs) await new Promise((r) => setTimeout(r, h.provisionDelayMs));
      const err = h.provisionErrors.shift();
      if (err) throw err;
      return { secretName: "bgp/dms/redshift-target", outcome: req.rotate ? "provisioned" : h.outcome };
    } finally {
      h.inflight[req.targetId]--;
    }
  }),
  executeAdminDdl: vi.fn(async (actor: { reason: string }, request: Record<string, unknown>) => {
    h.ddl.push({ reason: actor.reason, request });
    return { auditId: "a1" };
  }),
}));
vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    redshiftServerlessClientFor: async (region: string) => ({
      send: async (cmd: any) => {
        const n = cmd.constructor.name as string;
        h.rsCalls.push({ region, cmd: n, input: cmd.input });
        if (n === "GetWorkgroupCommand") {
          const ns = h.workgroups[region]?.[cmd.input.workgroupName];
          return { workgroup: ns === undefined ? undefined : { workgroupName: cmd.input.workgroupName, namespaceName: ns } };
        }
        if (n === "GetNamespaceCommand") return { namespace: { namespaceName: cmd.input.namespaceName, iamRoles: h.namespaces[region]?.[cmd.input.namespaceName] ?? [] } };
        if (n === "UpdateNamespaceCommand") {
          if (h.updateConflicts > 0) {
            h.updateConflicts--;
            throw Object.assign(new Error("There is an operation running on the namespace"), { name: "ConflictException" });
          }
          (h.namespaces[region] ??= {})[cmd.input.namespaceName] = cmd.input.iamRoles.map((arn: string) => `IamRole(applyStatus=in-sync, iamRoleArn=${arn})`);
          return {};
        }
        throw new Error(`unexpected ${n}`);
      },
    }),
  };
});

import { ensureRedshiftDmsUser, ensureRoleAssociatedToNamespace, ensureTargetSchema } from "@/lib/realtime/redshift-target";
import { homeDmsPlace, regionDmsPlace } from "@/lib/realtime/__tests__/fixtures/dms-place";

const HOME = homeDmsPlace();
const WEST = regionDmsPlace();
const realSetTimeout = globalThis.setTimeout;
/** 假时钟走 n 毫秒(每 500ms 让出一次真事件循环)。 */
async function advance(ms: number) {
  for (let t = 0; t < ms; t += 500) { await vi.advanceTimersByTimeAsync(500); await new Promise((r) => realSetTimeout(r, 0)); }
}

beforeEach(() => {
  h.provisions.length = 0; h.ddl.length = 0; h.inflight = {}; h.maxInflight = {}; h.provisionDelayMs = 0; h.provisionErrors = [];
  h.outcome = "reused"; h.rsCalls.length = 0; h.updateConflicts = 0;
  h.workgroups = { "us-east-1": { "bgp-workgroup": "bgp-namespace" }, "us-west-2": { "bgp-workgroup-tgt-usw2": "bgp-namespace-tgt-usw2" } };
  h.namespaces = { "us-east-1": { "bgp-namespace": [] }, "us-west-2": { "bgp-namespace-tgt-usw2": [] } };
});
afterEach(() => { vi.useRealTimers(); });

describe("目标数仓的专用用户与密钥:按落点的区,经受控通道", () => {
  it("① 缺省不重设口令;请求带落点的执行环境;密钥在 ⇒ provisioned=false,新供给 ⇒ true", async () => {
    expect(await ensureRedshiftDmsUser(WEST)).toEqual({ secretId: "bgp/dms/redshift-target", provisioned: false });
    h.outcome = "provisioned";
    expect(await ensureRedshiftDmsUser(HOME)).toEqual({ secretId: "bgp/dms/redshift-target", provisioned: true });
    expect(h.provisions).toEqual([
      { reason: "dms-ingest-bootstrap", targetId: "tgt_usw2", rotate: false },
      { reason: "dms-ingest-bootstrap", targetId: "tgt_home", rotate: false },
    ]);
  });

  it("①b 明说 rotate 才重设口令(目标端连通性测试失败后由启动编排有界地调一次)", async () => {
    expect(await ensureRedshiftDmsUser(WEST, { rotate: true })).toEqual({ secretId: "bgp/dms/redshift-target", provisioned: true });
    expect(h.provisions).toEqual([{ reason: "dms-ingest-bootstrap", targetId: "tgt_usw2", rotate: true }]);
  });

  it("② 🔴 同一个区两条任务同时首次启动 ⇒ 排队,任何时刻该区只有一条在供给(改动前:每次启动各自重设口令并覆盖密钥,口令与密钥可能对不上)", async () => {
    vi.useFakeTimers();
    h.provisionDelayMs = 3_000;
    const all = Promise.all([ensureRedshiftDmsUser(WEST), ensureRedshiftDmsUser(WEST), ensureRedshiftDmsUser(WEST)]);
    await advance(10_000);
    await all;
    expect(h.provisions).toHaveLength(3);
    expect(h.maxInflight.tgt_usw2).toBe(1);
  });

  it("②b 不同区互不等待;同区前一条失败不连累后一条(各自如实成败)", async () => {
    vi.useFakeTimers();
    h.provisionDelayMs = 3_000;
    const both = Promise.all([ensureRedshiftDmsUser(WEST), ensureRedshiftDmsUser(HOME)]);
    await advance(3_500);
    await both; // 两个区并行:3 秒多一点两条都做完(排队的话要 6 秒)
    expect(h.maxInflight).toEqual({ tgt_usw2: 1, tgt_home: 1 });
    h.provisionErrors = [new Error("数仓正在恢复"), null];
    const first = ensureRedshiftDmsUser(WEST).then(() => "ok", (e) => String((e as Error).message));
    const second = ensureRedshiftDmsUser(WEST).then((r) => r.secretId, (e) => String((e as Error).message));
    await advance(7_000);
    expect(await first).toBe("数仓正在恢复");
    expect(await second).toBe("bgp/dms/redshift-target");
  });

  it("③ 目标 schema:受控通道的固定模板,带落点的执行环境与 schema 名", async () => {
    await ensureTargetSchema(WEST, "gamedata");
    expect(h.ddl).toEqual([{ reason: "dms-ingest-bootstrap", request: { operation: "dms-ingest-bootstrap", targetId: "tgt_usw2", schema: "gamedata" } }]);
  });
});

describe("把访问角色关联到落点那个区的数仓命名空间", () => {
  it("④ 命名空间名取该区工作组的事实;角色写进该区的命名空间,主控区一个调用都没有", async () => {
    await ensureRoleAssociatedToNamespace(WEST);
    expect(h.rsCalls.map((c) => `${c.region}:${c.cmd}`)).toEqual(["us-west-2:GetWorkgroupCommand", "us-west-2:GetNamespaceCommand", "us-west-2:UpdateNamespaceCommand"]);
    expect(h.rsCalls[0].input).toEqual({ workgroupName: "bgp-workgroup-tgt-usw2" });
    expect(h.rsCalls[2].input).toEqual({ namespaceName: "bgp-namespace-tgt-usw2", iamRoles: [WEST.roleArn] });
    expect(h.namespaces["us-east-1"]["bgp-namespace"]).toEqual([]);
  });

  it("④b 已有别的角色 ⇒ 追加不覆盖;已关联 ⇒ 不再写", async () => {
    const other = "arn:aws:iam::123456789012:role/BgpExecEnv-tgt-usw2-redshift-copy-role";
    h.namespaces["us-west-2"]["bgp-namespace-tgt-usw2"] = [`IamRole(applyStatus=in-sync, iamRoleArn=${other})`];
    await ensureRoleAssociatedToNamespace(WEST);
    expect(h.rsCalls[2].input.iamRoles).toEqual([other, WEST.roleArn]);
    h.rsCalls.length = 0;
    await ensureRoleAssociatedToNamespace(WEST);
    expect(h.rsCalls.map((c) => c.cmd)).toEqual(["GetWorkgroupCommand", "GetNamespaceCommand"]);
  });

  it("④c 查不到工作组所属的命名空间 ⇒ 抛并点名工作组与区(不拿一个猜的名字去写)", async () => {
    h.workgroups["us-west-2"] = {};
    await expect(ensureRoleAssociatedToNamespace(WEST)).rejects.toThrow(/bgp-workgroup-tgt-usw2.*us-west-2/);
    expect(h.rsCalls.map((c) => c.cmd)).toEqual(["GetWorkgroupCommand"]);
  });

  it("④d 命名空间正被别的变更占着(刚建完用户 / schema)⇒ 退避后重试到成功", async () => {
    vi.useFakeTimers();
    h.updateConflicts = 2;
    const p = ensureRoleAssociatedToNamespace(HOME);
    await advance(12_000);
    await p;
    expect(h.rsCalls.filter((c) => c.cmd === "UpdateNamespaceCommand")).toHaveLength(3);
    expect(h.namespaces["us-east-1"]["bgp-namespace"]).toEqual([`IamRole(applyStatus=in-sync, iamRoleArn=${HOME.roleArn})`]);
  });
});
