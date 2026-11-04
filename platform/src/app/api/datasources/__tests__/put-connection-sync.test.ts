// `PUT /api/datasources/[id]`:改连接要素 / 登录名 / 口令必须先同步到该源所在区的 Glue 连接与 secret,再落库(台账)。
//
// 🔴 为什么必须可执行:修前改 host 只落库,Glue 连接(同步作业 / 发现作业 / 探测都走它)仍指旧库,页面却说「已更新」;只改登录名连 secret 都不动。
//   判据钉**调用参数与顺序**:① 改 host ⇒ Glue 连接按该源落点的区更新、带新 host、secret 不动、落库含 host;② 只改登录名 ⇒ 读旧口令 → Glue 带 username/password → secret 用旧口令 + 新登录名;
//   ③ 改口令 ⇒ Glue 与 secret 都拿到新口令,password 不落库;④ 只改名 ⇒ 两边都不碰;⑤ Glue 更新失败 ⇒ 502 且**没有** UpdateCommand(记录未改);
//   ⑥ 没有 Glue 连接的源(对象存储范式)改 connection ⇒ 不碰 Glue。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const sent: Array<{ name: string; input: Record<string, any> }> = [];
let CURRENT: Record<string, any> = {};
const JDBC = {
  userId: "default", datasourceId: "01M4Z0AHBYF5Y28STSE1TKS7EG", name: "b83-src", type: "mysql", host: "old-db.example.internal", port: 3306,
  database: "ecommerce", username: "app", status: "active", updatedAt: "2026-10-15T05:24:57.567Z",
  secretArn: "arn:aws:secretsmanager:us-west-2:acct0000ab42:secret:x", glueConnectionName: "bgp-conn-fixture0001", ownerTargetId: "tgt_usw2_a", projectId: "proj-default",
};
const S3 = { userId: "default", datasourceId: "01M4Z0AHBYF5Y28STSE1TKS7S3", name: "b83-s3", type: "s3", paradigm: "object-store", connection: { bucket: "b", prefix: "p/" }, status: "active", projectId: "proj-default" };

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { DATASOURCES: "bgp-datasources", LONG_OPS: "bgp-long-ops" },
  docClient: {
    send: vi.fn(async (cmd: { constructor: { name: string }; input?: Record<string, unknown> }) => {
      // PUT 先核对象租约(读 bgp-long-ops 的 lease 行)⇒ 没有租约 = 空
      if (cmd.input?.TableName === "bgp-long-ops") return {};
      sent.push({ name: cmd.constructor.name, input: (cmd.input ?? {}) as Record<string, any> });
      if (cmd.constructor.name === "GetCommand") return { Item: { ...CURRENT } };
      if (cmd.constructor.name === "UpdateCommand") return { Attributes: { ...CURRENT } };
      return {};
    }),
  },
}));
vi.mock("@/lib/projects/guard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects/guard")>("@/lib/projects/guard");
  return { ...actual, guardResourceAccess: vi.fn(async () => ({ identity: {}, projectId: "proj-default", role: "editor" })) };
});
const calls: Array<{ fn: string; args: unknown[] }> = [];
let glueThrows: string | undefined;
vi.mock("@/lib/aws/datasource-service", () => ({
  createSecret: vi.fn(), detectNetwork: vi.fn(), ensureGlueRole: vi.fn(), createGlueConnection: vi.fn(), testConnection: vi.fn(),
  updateGlueConnectionNetwork: vi.fn(), deleteGlueConnection: vi.fn(), deleteSecret: vi.fn(), deleteSecurityGroup: vi.fn(), deletePlatformSecurityGroupWithRetry: vi.fn(),
  getSecret: vi.fn(async (...args: unknown[]) => { calls.push({ fn: "getSecret", args }); return { username: "app", password: "old-fixture-pass" }; }),
  updateSecret: vi.fn(async (...args: unknown[]) => { calls.push({ fn: "updateSecret", args }); }),
  updateGlueConnectionEndpoint: vi.fn(async (...args: unknown[]) => {
    calls.push({ fn: "updateGlueConnectionEndpoint", args });
    if (glueThrows) throw new Error(glueThrows);
    return { jdbcUrl: "jdbc:mysql://new" };
  }),
}));
const placeCalls: unknown[] = [];
// 路由另 import 了同模块的 `noteDatasourceRowPlace`(纯记账,请求外 no-op)⇒ 部分 mock 要 importOriginal 展开,只替换 resolveDsPlace
vi.mock("@/lib/datasource/ds-place", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/datasource/ds-place")>()),
  resolveDsPlace: vi.fn(async (t: unknown) => { placeCalls.push(t); return { region: "us-west-2", targetId: "tgt_usw2_a" }; }),
}));
vi.mock("@/lib/exec-env/registry", () => ({ getTargetRaw: vi.fn(async (id: string) => ({ targetId: id, region: "us-west-2", ready: true })), descriptorViolation: vi.fn(() => null) }));
vi.mock("@/lib/datasource/glue-reach", () => ({ teardownDiscoveryArtifacts: vi.fn(async () => []) }));
vi.mock("@/lib/datasource/glue-probe-settle", () => ({ settleGlueProbeRows: vi.fn(async (rows: unknown[]) => rows) }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));

import { PUT } from "../[id]/route";

const put = (body: Record<string, unknown>) =>
  PUT(new NextRequest(`https://x.test/api/datasources/${CURRENT.datasourceId}`, { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      { params: { id: CURRENT.datasourceId } });
const updateCmd = () => sent.find((s) => s.name === "UpdateCommand")?.input;
const setFields = (input: Record<string, any>) => Object.values(input.ExpressionAttributeNames as Record<string, string>).sort();
const glueCall = () => calls.find((c) => c.fn === "updateGlueConnectionEndpoint");
const secretCall = () => calls.find((c) => c.fn === "updateSecret");

beforeEach(() => { sent.length = 0; calls.length = 0; placeCalls.length = 0; glueThrows = undefined; CURRENT = { ...JDBC }; });

describe("① 改 host(用户把源库迁到新地址)", () => {
  it("Glue 连接按**该源落点的区**更新,带新 host 与原 port / database / type,不带凭证;secret 不动;落库 SET 含 host;Glue 在 DDB 之前", async () => {
    const res = await put({ host: "new-db.example.internal" });
    expect(res.status).toBe(200);
    const g = glueCall();
    expect(g, "必须调 updateGlueConnectionEndpoint").toBeTruthy();
    expect(g!.args[0]).toBe("bgp-conn-fixture0001");
    expect(g!.args[1]).toEqual({ type: "mysql", host: "new-db.example.internal", port: 3306, database: "ecommerce" });
    expect(g!.args[2]).toBe("us-west-2");
    expect(placeCalls.length).toBe(1);
    expect(secretCall()).toBeUndefined();
    expect(calls.find((c) => c.fn === "getSecret")).toBeUndefined();
    expect(setFields(updateCmd()!)).toEqual(["host", "updatedAt"]);
  });
  it("改 port 字符串形态(表单回来是 '3307')也算变化,Glue 拿到数字 3307", async () => {
    const res = await put({ port: "3307" });
    expect(res.status).toBe(200);
    expect(glueCall()!.args[1]).toEqual(expect.objectContaining({ port: 3307, host: "old-db.example.internal" }));
  });
});

describe("② 只改登录名(没给口令)", () => {
  it("先读旧口令 → Glue 连接带 username + 旧口令 → secret 写新登录名 + 旧口令;落库 SET 含 username、不含 password", async () => {
    const res = await put({ username: "app2" });
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.fn)).toEqual(["getSecret", "updateGlueConnectionEndpoint", "updateSecret"]);
    expect(glueCall()!.args[1]).toEqual({ type: "mysql", host: "old-db.example.internal", port: 3306, database: "ecommerce", username: "app2", password: "old-fixture-pass" });
    expect(secretCall()!.args).toEqual([JDBC.secretArn, "app2", "old-fixture-pass"]);
    expect(setFields(updateCmd()!)).toEqual(["updatedAt", "username"]);
  });
});

describe("③ 改口令", () => {
  it("不读旧口令;Glue 与 secret 都拿到新口令(登录名沿用现有);password 不落库", async () => {
    const res = await put({ password: "new-fixture-pass" });
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.fn)).toEqual(["updateGlueConnectionEndpoint", "updateSecret"]);
    expect(glueCall()!.args[1]).toEqual(expect.objectContaining({ username: "app", password: "new-fixture-pass" }));
    expect(secretCall()!.args).toEqual([JDBC.secretArn, "app", "new-fixture-pass"]);
    expect(setFields(updateCmd()!), "只改口令 ⇒ 没有可落库字段,但做了事 ⇒ 只刷 updatedAt 并 200(修前在 secret 已改之后回 400)").toEqual(["updatedAt"]);
    expect(updateCmd()!.UpdateExpression).toBe("SET #upd = :now");
  });
});

describe("④ 只改名 / 回显同值", () => {
  it("name 变、host 等回显同值 ⇒ Glue / secret 都不碰", async () => {
    const res = await put({ name: "renamed", host: JDBC.host, port: JDBC.port, database: JDBC.database, username: JDBC.username, type: JDBC.type });
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
    expect(setFields(updateCmd()!)).toEqual(["database", "host", "name", "port", "type", "updatedAt", "username"]);
  });
});

describe("⑤ Glue 更新失败", () => {
  it("502 UPSTREAM_ERROR、文案说明记录未改、没有 UpdateCommand、secret 也没写", async () => {
    glueThrows = "EntityNotFoundException: Connection bgp-conn-fixture0001 not found";
    const res = await put({ host: "new-db.example.internal", password: "p2" });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain("同步 Glue 连接失败,记录未改");
    expect(JSON.stringify(body)).toContain("UPSTREAM_ERROR");
    expect(updateCmd()).toBeUndefined();
    expect(secretCall()).toBeUndefined();
  });
});

describe("⑥ 对象存储范式(没有 Glue 连接 / secret)", () => {
  it("改 connection ⇒ 不碰 Glue / secret,直接落库", async () => {
    CURRENT = { ...S3 };
    const res = await put({ connection: { bucket: "b2", prefix: "q/" } });
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
    expect(setFields(updateCmd()!)).toEqual(["connection", "updatedAt"]);
  });
});

// 附加 JDBC 参数:与改 host 同列(Glue 连接的 URL 要跟着变);不合法 ⇒ 400 记录不改;空串 = 清空。
describe("⑦ 附加 JDBC 参数", () => {
  it("只改 jdbcParams ⇒ Glue 连接更新且拿到归一化后的参数;secret 不动;落库 SET 含 jdbcParams(归一化形态)", async () => {
    const res = await put({ jdbcParams: " useSSL=false; serverTimezone=Asia/Shanghai " });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(glueCall()!.args[1]).toEqual({ type: "mysql", host: "old-db.example.internal", port: 3306, database: "ecommerce", jdbcParams: "useSSL=false&serverTimezone=Asia/Shanghai" });
    expect(secretCall()).toBeUndefined();
    expect(setFields(updateCmd()!)).toEqual(["jdbcParams", "updatedAt"]);
    expect(Object.values(updateCmd()!.ExpressionAttributeValues as Record<string, unknown>)).toContain("useSSL=false&serverTimezone=Asia/Shanghai");
  });
  it("不合法(值含空白)⇒ 400 VALIDATION_FAILED,Glue / secret / DDB 都没动", async () => {
    const res = await put({ jdbcParams: "useSSL=fa lse" });
    expect(res.status).toBe(400);
    expect((await res.json()).error?.code).toBe("VALIDATION_FAILED");
    expect(glueCall()).toBeUndefined();
    expect(updateCmd()).toBeUndefined();
  });
  it("清空(空串)⇒ Glue 连接按无附加参数更新(jdbcParams 不传),落库 SET 含 jdbcParams=''", async () => {
    CURRENT = { ...JDBC, jdbcParams: "useSSL=false" };
    const res = await put({ jdbcParams: "" });
    expect(res.status).toBe(200);
    expect(glueCall()!.args[1]).toEqual({ type: "mysql", host: "old-db.example.internal", port: 3306, database: "ecommerce" });
    expect(setFields(updateCmd()!)).toEqual(["jdbcParams", "updatedAt"]);
  });
  it("回显同值 ⇒ 不碰 Glue", async () => {
    CURRENT = { ...JDBC, jdbcParams: "useSSL=false" };
    const res = await put({ jdbcParams: "useSSL=false", name: "renamed" });
    expect(res.status).toBe(200);
    expect(glueCall()).toBeUndefined();
  });
});
