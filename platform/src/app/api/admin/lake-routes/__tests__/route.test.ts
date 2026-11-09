// 数据湖路由规范接口 /api/admin/lake-routes 的状态矩阵(设计稿 §6.10.1–6.10.4):
//   GET 路由集(含隐式平台路由)· POST 登记(文法 / 保留别名 / 别名冲突 / 平台表桶 / 命名空间冲突 / 归属声明放行)·
//   PATCH|PUT 修改(平台路由不可改 / 没登记 404 / 改别名要确认 DECISION_REQUIRED)· DELETE 撤销(被引用 409 / 平台路由 400 / 没登记 404)· 守卫 401 / 403 / 落点 400。
// 只 mock 真外部(身份 / 审计 / 注册表 / DDB / S3 Tables);路由文件 → 共用处理器 → 路由作者整条走真实现。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import "@aws-sdk/client-s3tables";

const h = vi.hoisted(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCOUNT_ID = "123456789012";
  return {
    identity: { username: "admin", isPlatformAdmin: true } as { username: string; isPlatformAdmin: boolean } | null,
    rows: new Map<string, Record<string, unknown>>(),
    /** 每个桶里实际存在的命名空间(ListNamespaces) */
    nsByBucket: {} as Record<string, string[]>,
    /** 引用扫描:按表名给行 */
    scans: {} as Record<string, Array<Record<string, unknown>>>,
    audits: [] as string[],
    s3tCalls: [] as string[],
  };
});

vi.mock("@/lib/auth/identity", () => ({ resolveIdentity: vi.fn(async () => h.identity) }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async (_req: unknown, action: string) => { h.audits.push(action); }) }));
vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    getTargetRaw: vi.fn(async (id: string) => (["tgt_home", "tgt_usw2_a"].includes(id) ? { targetId: id, ready: true } : null)),
    descriptorViolation: vi.fn(() => null),
    requireReadyTarget: vi.fn(async (id: string) => ({ targetId: id, region: "us-west-2", resources: { tableBucket: "bgp-table-bucket-usw2" } })),
  };
});
vi.mock("@/lib/aws/clients", () => ({
  sdkClient: vi.fn(() => ({
    send: vi.fn(async (cmd: any) => {
      const n = cmd.constructor.name;
      h.s3tCalls.push(n);
      const bucket = String(cmd.input?.tableBucketARN ?? "").split("/").pop() ?? "";
      if (n === "GetTableBucketCommand") return { arn: cmd.input.tableBucketARN, name: bucket };
      if (n === "ListNamespacesCommand") return { namespaces: (h.nsByBucket[bucket] ?? []).map((x) => ({ namespace: [x] })) };
      return {};
    }),
  })),
}));
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SETTINGS: "bgp-settings", SYNC_TASKS: "bgp-sync-tasks", ETL_JOBS: "bgp-etl-jobs", ENGINE_JOBS: "bgp-engine-jobs" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const input = (cmd.input || {}) as Record<string, any>;
      const n = cmd.constructor.name;
      if (n === "QueryCommand") {
        const prefix = String(input.ExpressionAttributeValues[":prefix"]);
        return { Items: [...h.rows.values()].filter((r) => String(r.sk).startsWith(prefix)) };
      }
      if (n === "PutCommand") {
        const item = input.Item as Record<string, unknown>;
        if (h.rows.has(String(item.sk))) { const e = new Error("cond"); e.name = "ConditionalCheckFailedException"; throw e; }
        h.rows.set(String(item.sk), item);
        return {};
      }
      if (n === "UpdateCommand") {
        const sk = String(input.Key.sk);
        const row = h.rows.get(sk);
        if (!row) { const e = new Error("cond"); e.name = "ConditionalCheckFailedException"; throw e; }
        // 只认本路由会发出的 SET 形态:`SET a = :a, #ns = :ns, …`
        const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
        for (const part of String(input.UpdateExpression).replace(/^SET\s+/, "").split(",")) {
          const [lhs, rhs] = part.split("=").map((s) => s.trim());
          const field = names[lhs] ?? lhs;
          const v = input.ExpressionAttributeValues[rhs];
          if (v === null) delete row[field]; else row[field] = v;
        }
        return {};
      }
      if (n === "DeleteCommand") { const sk = String(input.Key.sk); const old = h.rows.get(sk); h.rows.delete(sk); return { Attributes: old }; }
      if (n === "ScanCommand") return { Items: h.scans[String(input.TableName)] ?? [] };
      return {};
    }),
  },
}));

import { GET, POST, PATCH, PUT, DELETE } from "../route";
import { forgetLakeRoutesMemo } from "@/lib/lake/routes";

const U = "http://x/api/admin/lake-routes";
const json = (method: string, body: unknown) => new NextRequest(U, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const get = (qs: string) => GET(new NextRequest(`${U}${qs}`));
const post = (body: unknown) => POST(json("POST", body));
const patch = (body: unknown) => PATCH(json("PATCH", body));
const put = (body: unknown) => PUT(json("PUT", body));
const del = (qs: string) => DELETE(new NextRequest(`${U}${qs}`, { method: "DELETE" }));
const bodyOf = async (r: Response) => (await r.json()) as { success: boolean; data?: any; error?: { code?: string; message?: string; detail?: any } };

beforeEach(() => {
  h.identity = { username: "admin", isPlatformAdmin: true };
  h.rows.clear(); h.audits.length = 0; h.s3tCalls.length = 0; h.scans = {};
  h.nsByBucket = { "bgp-table-bucket": ["ods", "gamedata"], "cust-agg": ["agg"], "cust-ods": ["ods"] };
  forgetLakeRoutesMemo();
});

describe("GET /api/admin/lake-routes", () => {
  it("路由集:targetId / region / home / routes[];第一条是隐式平台路由(别名固定 s3tablescatalog / 可写 / platform=true),不下发 bucketArn;任何登录用户可读", async () => {
    h.identity = { username: "viewer", isPlatformAdmin: false };
    const r = await get("?targetId=tgt_home");
    expect(r.status).toBe(200);
    const d = (await bodyOf(r)).data;
    expect(d).toMatchObject({ targetId: "tgt_home", region: "us-east-1", home: true });
    expect(d.routes).toHaveLength(1);
    expect(d.routes[0]).toMatchObject({ bucket: "bgp-table-bucket", alias: "s3tablescatalog", tier: "other", writable: true, platform: true, catalogRef: "s3tablescatalog/bgp-table-bucket" });
    expect(d.routes[0]).not.toHaveProperty("bucketArn");
  });
  it("非 home 执行环境:平台路由 = 描述符资源袋里的表桶、区 = 该区", async () => {
    const d = (await bodyOf(await get("?targetId=tgt_usw2_a"))).data;
    expect(d).toMatchObject({ targetId: "tgt_usw2_a", region: "us-west-2", home: false });
    expect(d.routes[0]).toMatchObject({ bucket: "bgp-table-bucket-usw2", alias: "s3tablescatalog" });
  });
  it("未登录 401;落点缺 400(不默认主控区)", async () => {
    expect((await get("")).status).toBe(400);
    h.identity = null;
    expect((await get("?targetId=tgt_home")).status).toBe(401);
  });
});

describe("POST /api/admin/lake-routes(登记)", () => {
  it("全套字段登记 ⇒ 201 原样回显;GET 变成 2 条(平台在前);审计 lake.route.register", async () => {
    const r = await post({ targetId: "tgt_home", bucket: "cust-agg", alias: "agg", tier: "agg", writable: true, namespaces: ["agg"], label: "聚合层" });
    expect(r.status, await r.clone().text()).toBe(201);
    expect((await bodyOf(r)).data).toMatchObject({ bucket: "cust-agg", alias: "agg", tier: "agg", writable: true, namespaces: ["agg"], label: "聚合层", platform: false, addedBy: "admin", region: "us-east-1" });
    const d = (await bodyOf(await get("?targetId=tgt_home"))).data;
    expect(d.routes.map((x: any) => `${x.alias}→${x.bucket}`)).toEqual(["s3tablescatalog→bgp-table-bucket", "agg→cust-agg"]);
    expect(h.audits).toEqual(["lake.route.register"]);
  });
  it("别名不给 ⇒ 按桶名派生;分层不给 ⇒ other;可写不给 ⇒ true", async () => {
    const r = await post({ targetId: "tgt_home", bucket: "cust-agg" });
    expect(r.status).toBe(201);
    expect((await bodyOf(r)).data).toMatchObject({ alias: "cust_agg", tier: "other", writable: true });
  });
  it("文法 400 VALIDATION_FAILED:保留别名 / 别名大写 / 分层不在清单 / writable 非布尔 / namespaces 非数组;都不落库、不调 s3tables", async () => {
    for (const body of [
      { targetId: "tgt_home", bucket: "cust-agg", alias: "s3tablescatalog" },
      { targetId: "tgt_home", bucket: "cust-agg", alias: "Agg" },
      { targetId: "tgt_home", bucket: "cust-agg", tier: "gold" },
      { targetId: "tgt_home", bucket: "cust-agg", writable: "yes" },
      { targetId: "tgt_home", bucket: "cust-agg", namespaces: "agg" },
    ]) {
      const r = await post(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect((await bodyOf(r)).error?.code).toBe("VALIDATION_FAILED");
    }
    expect(h.rows.size).toBe(0);
    expect(h.s3tCalls.filter((c) => c === "GetTableBucketCommand")).toHaveLength(0);
  });
  it("别名已被另一条路由占用 ⇒ 409 LAKE_ROUTE_ALIAS_CONFLICT(detail 点名占用它的桶)", async () => {
    expect((await post({ targetId: "tgt_home", bucket: "cust-agg", alias: "agg" })).status).toBe(201);
    const r = await post({ targetId: "tgt_home", bucket: "cust-ods", alias: "agg", namespaces: ["ods"] });
    expect(r.status).toBe(409);
    expect((await bodyOf(r)).error).toMatchObject({ code: "LAKE_ROUTE_ALIAS_CONFLICT", detail: { alias: "agg", bucket: "cust-agg" } });
  });
  it("平台表桶 ⇒ 409 CONFLICT;同一桶登记两次 ⇒ 409 CONFLICT", async () => {
    expect((await bodyOf(await post({ targetId: "tgt_home", bucket: "bgp-table-bucket" }))).error?.code).toBe("CONFLICT");
    expect((await post({ targetId: "tgt_home", bucket: "cust-agg" })).status).toBe(201);
    expect((await bodyOf(await post({ targetId: "tgt_home", bucket: "cust-agg" }))).error?.code).toBe("CONFLICT");
  });
  it("🔴 命名空间冲突:新桶里实际有 ods、平台表桶里也有 ods、没人声明归属 ⇒ 409 LAKE_ROUTE_NAMESPACE_CONFLICT(detail.conflicts 列两只桶);新桶声明 namespaces=[ods] ⇒ 201(归属已定)", async () => {
    const r = await post({ targetId: "tgt_home", bucket: "cust-ods" });
    expect(r.status).toBe(409);
    const e = (await bodyOf(r)).error!;
    expect(e.code).toBe("LAKE_ROUTE_NAMESPACE_CONFLICT");
    expect(e.detail).toEqual({ conflicts: [{ namespace: "ods", buckets: ["bgp-table-bucket", "cust-ods"] }] });
    expect(e.message).toContain("ods");
    expect(h.rows.size).toBe(0);
    const ok = await post({ targetId: "tgt_home", bucket: "cust-ods", namespaces: ["ods"] });
    expect(ok.status, await ok.clone().text()).toBe(201);
  });
  it("非平台管理员 403 RBAC_DENIED;未登录 401;落点缺 400", async () => {
    h.identity = { username: "u", isPlatformAdmin: false };
    expect((await bodyOf(await post({ targetId: "tgt_home", bucket: "cust-agg" }))).error?.code).toBe("RBAC_DENIED");
    h.identity = null;
    expect((await post({ targetId: "tgt_home", bucket: "cust-agg" })).status).toBe(401);
    h.identity = { username: "admin", isPlatformAdmin: true };
    expect((await post({ bucket: "cust-agg" })).status).toBe(400);
    expect(h.rows.size).toBe(0);
  });
});

describe("PATCH / PUT /api/admin/lake-routes(修改)", () => {
  beforeEach(async () => { expect((await post({ targetId: "tgt_home", bucket: "cust-agg", alias: "agg", tier: "agg" })).status).toBe(201); h.audits.length = 0; });

  it("改分层 / 可写 / 备注 ⇒ 200 回显新值,行里带 updatedBy / updatedAt;PUT 与 PATCH 同义;审计 lake.route.update", async () => {
    const r = await patch({ targetId: "tgt_home", bucket: "cust-agg", tier: "result", writable: false, label: "结果层" });
    expect(r.status, await r.clone().text()).toBe(200);
    expect((await bodyOf(r)).data).toMatchObject({ bucket: "cust-agg", alias: "agg", tier: "result", writable: false, label: "结果层", updatedBy: "admin" });
    const r2 = await put({ targetId: "tgt_home", bucket: "cust-agg", writable: true });
    expect(r2.status).toBe(200);
    expect((await bodyOf(r2)).data).toMatchObject({ tier: "result", writable: true });
    expect(h.audits).toEqual(["lake.route.update", "lake.route.update"]);
    const d = (await bodyOf(await get("?targetId=tgt_home"))).data;
    expect(d.routes[1]).toMatchObject({ tier: "result", writable: true, label: "结果层" });
  });
  it("🔴 改别名不带确认 ⇒ 409 DECISION_REQUIRED(detail 带 from / to);带 confirmAliasChange=true ⇒ 200;改成别的路由在用的别名 ⇒ 409 LAKE_ROUTE_ALIAS_CONFLICT", async () => {
    const r = await patch({ targetId: "tgt_home", bucket: "cust-agg", alias: "agg2" });
    expect(r.status).toBe(409);
    expect((await bodyOf(r)).error).toMatchObject({ code: "DECISION_REQUIRED", detail: { alias: { from: "agg", to: "agg2" } } });
    const ok = await patch({ targetId: "tgt_home", bucket: "cust-agg", alias: "agg2", confirmAliasChange: true });
    expect(ok.status).toBe(200);
    expect((await bodyOf(ok)).data.alias).toBe("agg2");
    const clash = await patch({ targetId: "tgt_home", bucket: "cust-agg", alias: "s3tablescatalog", confirmAliasChange: true });
    expect(clash.status).toBe(400); // 保留名先被文法拒
    expect((await post({ targetId: "tgt_home", bucket: "cust-ods", alias: "ods_alias", namespaces: ["ods"] })).status).toBe(201);
    const clash2 = await patch({ targetId: "tgt_home", bucket: "cust-agg", alias: "ods_alias", confirmAliasChange: true });
    expect((await bodyOf(clash2)).error?.code).toBe("LAKE_ROUTE_ALIAS_CONFLICT");
  });
  it("平台表桶的隐式路由不接受修改 ⇒ 400;没登记的桶 ⇒ 404 NOT_FOUND;非 admin 403", async () => {
    expect((await bodyOf(await patch({ targetId: "tgt_home", bucket: "bgp-table-bucket", tier: "agg" }))).error?.code).toBe("VALIDATION_FAILED");
    expect((await patch({ targetId: "tgt_home", bucket: "never-registered", tier: "agg" })).status).toBe(404);
    h.identity = { username: "u", isPlatformAdmin: false };
    expect((await patch({ targetId: "tgt_home", bucket: "cust-agg", tier: "agg" })).status).toBe(403);
  });
});

describe("DELETE /api/admin/lake-routes(撤销)", () => {
  beforeEach(async () => { expect((await post({ targetId: "tgt_home", bucket: "cust-agg", alias: "agg" })).status).toBe(201); h.audits.length = 0; });

  it("🔴 仍被同步任务 / 作业引用 ⇒ 409 CONFLICT,detail 列出引用者,行不删;去掉引用后 ⇒ 200,再撤销 404;审计 lake.route.revoke", async () => {
    h.scans["bgp-sync-tasks"] = [{ taskId: "T1", name: "ods 入湖", targets: ["tgt_home"], s3Config: { tableBucket: "cust-agg" } }];
    h.scans["bgp-etl-jobs"] = [{ jobId: "J1", name: "agg 作业", targets: ["tgt_home"], glueConfig: { lakeBuckets: [{ bucket: "cust-agg", access: "write" }] } }];
    h.scans["bgp-engine-jobs"] = [{ jobId: "E1", name: "别的区的作业", targets: ["tgt_usw2_a"], lakeBuckets: [{ bucket: "cust-agg", access: "read" }] }];
    const r = await del("?targetId=tgt_home&bucket=cust-agg");
    expect(r.status).toBe(409);
    const e = (await bodyOf(r)).error!;
    expect(e.code).toBe("CONFLICT");
    expect(e.detail).toEqual({ syncTasks: [{ taskId: "T1", name: "ods 入湖" }], jobs: [{ kind: "etl", jobId: "J1", name: "agg 作业" }] }); // 别的区的引用不算
    expect(e.message).toContain("ods 入湖");
    expect(h.rows.size).toBe(1);
    h.scans = {};
    expect((await del("?targetId=tgt_home&bucket=cust-agg")).status).toBe(200);
    expect((await del("?targetId=tgt_home&bucket=cust-agg")).status).toBe(404);
    expect(h.audits).toEqual(["lake.route.revoke"]);
  });
  it("平台表桶 ⇒ 400;落点缺 400;非 admin 403", async () => {
    expect((await bodyOf(await del("?targetId=tgt_home&bucket=bgp-table-bucket"))).error?.code).toBe("VALIDATION_FAILED");
    expect((await del("?bucket=cust-agg")).status).toBe(400);
    h.identity = { username: "u", isPlatformAdmin: false };
    expect((await del("?targetId=tgt_home&bucket=cust-agg")).status).toBe(403);
    expect(h.rows.size).toBe(1);
  });
});
