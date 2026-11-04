// 序 38 → 序 50 第二批 —— /api/governance/sync-redshift-schema 装配层判据:200(做完)/ 202(统一长操作协议 + GET /api/long-ops 轮询)/ 并发 409 / 500 / 403。
// 【缺陷原形】s38 复跑 71d:同步长调用超 ALB 60s 墙 ⇒ 504,而治理目录里表已经有了 ⇒ 用户按一次看到「同步失败」。
// 【序 50 第二批】治理专用的 202 `{ runId, state:"running", joined }` 协议退役:POST 经 submitLongOp(kind governance-schema-sync),
//   45s 内做完 ⇒ 200 逐字同旧契约;没做完 ⇒ 202 `protocol:"long-op/1"`,页面拦截器轮询 GET /api/long-ops/[taskId];
//   第二个人同时点 ⇒ 对象租约 governance:schema-sync 挡成 409 LONG_OP_IN_PROGRESS(不再「并入」);GET 读「最近一次同步」的运行记录不变。
// 【只 mock 真外部】DDB(settings 表自己假、bgp-long-ops 交给内存夹具真求值条件写)、身份、OpenMetadata 推送(om-push)、血缘重推(lineage-service)。
//   schema-sync-run / 执行体 / 驱动器 / 租约一律不 mock。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => {
  // 驱动器的进程内等待预算是 import 时读的 env(产品值 45s);判据把它缩到 30ms,把「做得慢」逼进 202 路径
  process.env.LONG_OPS_SYNC_WAIT_MS = "30";
  return {
    rows: new Map<string, Record<string, any>>(),
    admin: true,
    rs: null as null | (() => Promise<{ tables: number; columns: number }>),
    s3: null as null | (() => Promise<{ tables: number; columns: number }>),
    lineage: 0,
  };
});
vi.mock("@/lib/aws/dynamodb", async () => {
  const mem = await import("@/lib/long-ops/__tests__/fixtures/mem-long-ops");
  return {
    TABLES: { SETTINGS: "bgp-settings", LONG_OPS: "bgp-long-ops" },
    docClient: {
      send: vi.fn(async (cmd: any) => {
        const input = cmd.input as Record<string, any>;
        if (input.TableName === "bgp-long-ops") return mem.docClient.send(cmd);
        const n = cmd.constructor.name;
        if (n === "GetCommand") { const it = h.rows.get(input.Key.sk); return it ? { Item: { ...it } } : {}; }
        if (n === "PutCommand") {
          const cur = h.rows.get(input.Item.sk);
          if (input.ConditionExpression && cur && cur.state === "running") { const e = new Error("cond"); e.name = "ConditionalCheckFailedException"; throw e; }
          h.rows.set(input.Item.sk, { ...input.Item }); return {};
        }
        return {};
      }),
    },
  };
});
vi.mock("@/lib/auth/identity", () => {
  const identity = () => ({ username: "admin", sub: "s", groups: ["bgp-admin"], isPlatformAdmin: h.admin });
  return {
    resolveIdentity: vi.fn(async () => identity()),
    requireIdentity: vi.fn(async () => identity()),
  };
});
vi.mock("@/lib/openmetadata/om-push", () => ({
  pushRedshiftSchemaToOpenMetadata: vi.fn(async () => (h.rs ? h.rs() : { tables: 1, columns: 5 })),
  pushS3TablesSchemaToOpenMetadata: vi.fn(async () => (h.s3 ? h.s3() : { tables: 2, columns: 15 })),
}));
vi.mock("@/lib/governance/lineage-service", () => ({
  repushSyncLineageToOM: vi.fn(async () => { h.lineage++; }),
  backfillComputeLineageToOM: vi.fn(async () => { h.lineage++; }),
}));

function deferred<T>() { let resolve!: (v: T) => void; const p = new Promise<T>((res) => { resolve = res; }); return { p, resolve }; }
const req = (method = "POST") => new NextRequest("http://x/api/governance/sync-redshift-schema", { method });
async function body(res: Response) { return res.json(); }
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { h.rows.clear(); h.admin = true; h.rs = null; h.s3 = null; h.lineage = 0; vi.resetModules(); });

describe("🔴 sync-redshift-schema 路由(序 50 第二批:经统一长操作框架)", () => {
  const post = async () => { const m: any = await import("@/app/api/governance/sync-redshift-schema/route"); return m.POST(req("POST")); };
  const get = async () => { const m: any = await import("@/app/api/governance/sync-redshift-schema/route"); return m.GET(req("GET")); };
  const poll = async (taskId: string) => {
    const m: any = await import("@/app/api/long-ops/[taskId]/route");
    return body(await m.GET(new NextRequest(`http://x/api/long-ops/${taskId}`), { params: { taskId } }));
  };

  it("做得快 ⇒ 200,结果与文案逐字同旧契约(tables / columns / redshift / s3tables / message / runId / state),血缘后台重推", async () => {
    const r = await post(); const b: any = await body(r);
    expect(r.status).toBe(200);
    expect(b.success).toBe(true);
    expect(b.data).toMatchObject({ tables: 3, columns: 20, redshift: { tables: 1, columns: 5 }, s3tables: { tables: 2, columns: 15 }, state: "succeeded" });
    expect(String(b.data.message)).toContain("已回填 3 张表、20 个字段");
    expect(typeof b.data.runId).toBe("string");
    expect(typeof b.data.startedAt).toBe("string");
    expect(typeof b.data.finishedAt).toBe("string");
    // 旧协议字段一个不许回来
    expect(b.data.joined).toBeUndefined();
    await tick();
    expect(h.lineage).toBe(2);
    // 运行记录照旧落 settings 表,GET「最近一次同步」读到 succeeded
    const g: any = await body(await get());
    expect(g.data).toMatchObject({ state: "succeeded", runId: b.data.runId });
  }, 20_000);

  it("做得慢 ⇒ 202 统一协议(taskId / kind / label / protocol long-op/1,不再是治理专用 runId 协议);GET /api/long-ops 先 running、做完后 succeeded 带同形结果;GET 运行记录同步跟上", async () => {
    const d = deferred<{ tables: number; columns: number }>();
    h.rs = () => d.p;
    const r = await post(); const b: any = await body(r);
    expect(r.status).toBe(202);
    expect(b.success).toBe(true);
    expect(b.data).toMatchObject({ kind: "governance-schema-sync", label: "同步列信息到数据目录", status: "running", async: true, protocol: "long-op/1" });
    expect(typeof b.data.taskId).toBe("string");
    expect(b.data.runId, "治理专用 202 协议已退役").toBeUndefined();
    const p1: any = await poll(b.data.taskId);
    expect(p1.data).toMatchObject({ taskId: b.data.taskId, status: "running" });
    const g1: any = await body(await get());
    expect(g1.data.state).toBe("running");
    d.resolve({ tables: 1, columns: 5 }); await tick(30);
    const p2: any = await poll(b.data.taskId);
    expect(p2.data).toMatchObject({ status: "succeeded" });
    expect(p2.data.resultStatus, "执行体没给 resultStatus ⇒ 客户端整形按 200(与同步路径 apiOk 缺省一致)").toBeUndefined();
    expect(p2.data.result).toMatchObject({ tables: 3, columns: 20, redshift: { tables: 1, columns: 5 }, s3tables: { tables: 2, columns: 15 }, state: "succeeded" });
    expect(String(p2.data.result.message)).toContain("已回填 3 张表");
    const g2: any = await body(await get());
    expect(g2.data).toMatchObject({ state: "succeeded", runId: p2.data.result.runId, result: { tables: 3, columns: 20 } });
  }, 20_000);

  it("🔴 已有一次在跑 ⇒ 再点一次 409 LONG_OP_IN_PROGRESS(对象租约 governance:schema-sync),OpenMetadata 只被推一遍;做完后再点才放行", async () => {
    const d = deferred<{ tables: number; columns: number }>();
    const rs = vi.fn(() => d.p); h.rs = rs;
    const r1 = await post(); const b1: any = await body(r1);
    expect(r1.status).toBe(202);
    const r2 = await post(); const b2: any = await body(r2);
    expect(r2.status).toBe(409);
    expect(b2.error.code).toBe("LONG_OP_IN_PROGRESS");
    expect(String(b2.error.message)).toContain("「同步列信息到数据目录」正在进行中");
    expect(b2.error.detail).toMatchObject({ taskId: b1.data.taskId, kind: "governance-schema-sync" });
    expect(rs).toHaveBeenCalledTimes(1);
    d.resolve({ tables: 1, columns: 5 }); await tick(30);
    h.rs = null;
    const r3 = await post();
    expect(r3.status, "终态释放租约后再点要能放行").toBe(200);
  }, 20_000);

  it("Redshift 回填报错 ⇒ 500「同步失败: …」带 runId(S3 Tables 回填失败仍只是忽略)", async () => {
    h.rs = async () => { throw new Error("Redshift resume timeout"); };
    const r = await post(); const b: any = await body(r);
    expect(r.status).toBe(500);
    expect(b.error.message).toContain("同步失败: Redshift resume timeout");
    expect(typeof b.error.detail?.runId).toBe("string");
    // 运行记录如实 failed(GET 读到原话)
    const g: any = await body(await get());
    expect(g.data).toMatchObject({ state: "failed", error: "Redshift resume timeout" });
    h.rs = null; h.s3 = async () => { throw new Error("athena down"); };
    h.rows.clear();
    const r2 = await post(); const b2: any = await body(r2);
    expect(r2.status).toBe(200);
    expect(b2.data.s3tables).toEqual({ tables: 0, columns: 0 });
  }, 20_000);

  it("非平台管理员 ⇒ 403(不建任务、不占租约);GET 没有记录 ⇒ state=none", async () => {
    h.admin = false;
    expect((await post()).status).toBe(403);
    const mem = await import("@/lib/long-ops/__tests__/fixtures/mem-long-ops");
    expect(mem.rows.size).toBe(0);
    h.admin = true;
    const g: any = await body(await get());
    expect(g.data).toEqual({ state: "none" });
  }, 20_000);
});
