// @kf-batch 42-ux-feedback —— `PUT /api/datasources/[id]`:只认闭合清单里的可编辑字段(用户 2026-10-15 反馈 ①「编辑数据源改名报错」)。
//
// 🔴 为什么必须可执行:2026-10-15 05:24Z …7698 页面复现 —— 编辑弹窗把整条记录原样 PUT 回来,路由把 `updatedAt` 等全拼进
//   UpdateExpression 又另加 `#upd = :now` ⇒ DynamoDB「Two document paths overlap … [updatedAt]」500。判据钉**真组出来的表达式**:
//   ① 整条记录回显 ⇒ SET 里只有可编辑字段 + updatedAt 一次,不含主键 / 租户 / 服务端字段;② 改名真落到 :v 值;③ 只回显服务端字段 ⇒ 400「无更新字段」而不是 500;
//   ④ 密码非空 ⇒ 走 updateSecret 且不落库;⑤ 不在清单的键被丢弃并记 warn。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const sent: Array<{ name: string; input: Record<string, any> }> = [];
const CURRENT = {
  userId: "default", datasourceId: "01M4Z0AHBYF5Y28STSE1TKS7EG", name: "p42-rename-x", type: "mysql", host: "db.example.internal", port: 3306,
  database: "ecommerce", username: "app", status: "active", createdAt: "2026-10-15T05:24:57.000Z", updatedAt: "2026-10-15T05:24:57.567Z",
  secretArn: "arn:aws:secretsmanager:us-east-1:acct0000ab42:secret:x", glueConnectionName: "bgp-ds-x", ownerTargetId: "tgt_home", projectId: "proj-default",
};

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { DATASOURCES: "bgp-datasources", LONG_OPS: "bgp-long-ops" },
  docClient: {
    send: vi.fn(async (cmd: { constructor: { name: string }; input?: Record<string, unknown> }) => {
      // 序 50 第二批:PUT 先核对象租约(读 bgp-long-ops 的 lease 行)⇒ 没有租约 = 空
      if (cmd.input?.TableName === "bgp-long-ops") return {};
      sent.push({ name: cmd.constructor.name, input: (cmd.input ?? {}) as Record<string, any> });
      if (cmd.constructor.name === "GetCommand") return { Item: { ...CURRENT } };
      if (cmd.constructor.name === "UpdateCommand") {
        const vals = (cmd.input as any).ExpressionAttributeValues as Record<string, unknown>;
        const names = (cmd.input as any).ExpressionAttributeNames as Record<string, string>;
        const out: Record<string, unknown> = { ...CURRENT };
        // 路由的表达式形态:`#f<i> = :v<i>` + `#upd = :now` —— 夹具按同一映射回放
        for (const [ph, field] of Object.entries(names)) {
          const vph = ph === "#upd" ? ":now" : ph.replace(/^#f/, ":v");
          if (vph in vals) out[field] = vals[vph];
        }
        return { Attributes: out };
      }
      return {};
    }),
  },
}));
vi.mock("@/lib/projects/guard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects/guard")>("@/lib/projects/guard");
  return { ...actual, guardResourceAccess: vi.fn(async () => ({ identity: {}, projectId: "proj-default", role: "editor" })), requireProject: vi.fn(async () => ({ identity: {}, projectId: "proj-default", role: "editor" })) };
});
const updateSecret = vi.fn(async () => {});
vi.mock("@/lib/aws/datasource-service", () => ({
  createSecret: vi.fn(), updateSecret: (...a: unknown[]) => updateSecret(...(a as [])), detectNetwork: vi.fn(), ensureGlueRole: vi.fn(),
  createGlueConnection: vi.fn(), testConnection: vi.fn(), updateGlueConnectionNetwork: vi.fn(), deleteGlueConnection: vi.fn(), deleteSecret: vi.fn(),
  // @kf-batch 42-B83-ds-edit-sync —— 连接要素 / 凭证同步(本文件不验它的参数,见 put-connection-sync.test.ts)
  getSecret: vi.fn(async () => ({ username: "app", password: "old-fixture-pass" })), updateGlueConnectionEndpoint: vi.fn(async () => ({ jdbcUrl: "jdbc:x" })),
}));
// 序 31 二刀 ⑤:路由另 import 了同模块的 `noteDatasourceRowPlace`(纯记账,请求外 no-op)⇒ 部分 mock 要 importOriginal 展开,只替换 resolveDsPlace
vi.mock("@/lib/datasource/ds-place", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/datasource/ds-place")>()),
  resolveDsPlace: vi.fn(async () => ({ region: "us-east-1" })),
}));
vi.mock("@/lib/exec-env/registry", () => ({ getTargetRaw: vi.fn(async (id: string) => ({ targetId: id, region: "us-east-1", ready: true })), descriptorViolation: vi.fn(() => null) }));
vi.mock("@/lib/datasource/schema-reader", () => ({ readSourceSchema: vi.fn() }));
vi.mock("@/lib/openmetadata/om-push", () => ({ pushDataSourceToOpenMetadata: vi.fn(), deleteDataSourceFromOpenMetadata: vi.fn() }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));

import { PUT } from "../[id]/route";

const put = (body: Record<string, unknown>) =>
  PUT(new NextRequest(`https://x.test/api/datasources/${CURRENT.datasourceId}`, { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      { params: { id: CURRENT.datasourceId } });
const updateCmd = () => sent.find((s) => s.name === "UpdateCommand")?.input;
const setFields = (input: Record<string, any>) => Object.values(input.ExpressionAttributeNames as Record<string, string>).sort();

beforeEach(() => { sent.length = 0; updateSecret.mockClear(); });

describe("① 整条记录回显(2026-10-15 真环境形态)", () => {
  it("SET 里只有可编辑字段 + updatedAt 恰一次;主键 / 租户 / 服务端字段一个都不进表达式;HTTP 200 且 name 已变", async () => {
    const res = await put({ ...CURRENT, name: "p42-rename-x-renamed", password: "", heartbeat: { ok: true }, discovery: { s: 1 }, paradigm: "jdbc", credentialKind: "userpass", probeVia: "auto" });
    expect(res.status).toBe(200);
    const u = updateCmd()!;
    expect(u, "必须真发了 UpdateCommand").toBeTruthy();
    expect(setFields(u)).toEqual(["database", "host", "name", "port", "probeVia", "type", "updatedAt", "username"]);
    const expr = u.UpdateExpression as string;
    expect((expr.match(/#upd/g) || []).length).toBe(1);
    for (const banned of ["datasourceId", "userId", "createdAt", "status", "secretArn", "glueConnectionName", "ownerTargetId", "projectId", "heartbeat", "discovery", "paradigm", "credentialKind", "password"]) {
      expect(Object.values(u.ExpressionAttributeNames), `${banned} 不许进 SET`).not.toContain(banned);
    }
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.name).toBe("p42-rename-x-renamed");
    expect(updateSecret).not.toHaveBeenCalled(); // 密码留空 = 不改密码
  });
});

describe("② 只改名(修后客户端的形态)", () => {
  it("SET = name + updatedAt;值就是新名字", async () => {
    const res = await put({ name: "only-name" });
    expect(res.status).toBe(200);
    const u = updateCmd()!;
    expect(setFields(u)).toEqual(["name", "updatedAt"]);
    expect(Object.values(u.ExpressionAttributeValues)).toContain("only-name");
  });
});

describe("③ 只回显服务端字段 ⇒ 400 无更新字段(不是 500)", () => {
  it("datasourceId / updatedAt / status 全被丢 ⇒ 400,且没发 UpdateCommand", async () => {
    const res = await put({ datasourceId: CURRENT.datasourceId, updatedAt: CURRENT.updatedAt, status: "active" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("无更新字段");
    expect(updateCmd()).toBeUndefined();
  });
});

describe("④ 密码非空 ⇒ 同步 secret、不落库", () => {
  it("updateSecret(secretArn, username, password) 被调一次;SET 不含 password", async () => {
    const res = await put({ name: "n2", password: "new-fixture-pass" });
    expect(res.status).toBe(200);
    expect(updateSecret).toHaveBeenCalledTimes(1);
    expect((updateSecret.mock.calls[0] as unknown[])[0]).toBe(CURRENT.secretArn);
    expect((updateSecret.mock.calls[0] as unknown[])[2]).toBe("new-fixture-pass");
    expect(setFields(updateCmd()!)).toEqual(["name", "updatedAt"]);
  });
});

describe("⑤ 不在清单的键 ⇒ 丢弃并 warn(可发现客户端漏网字段)", () => {
  it("console.warn 一行点名被丢的键", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await put({ name: "n3", zzzUnknown: 1, updatedAt: "x" });
      const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("丢弃不可编辑字段"));
      expect(line).toBeTruthy();
      expect(line).toContain("zzzUnknown");
      expect(line).toContain("updatedAt");
    } finally { warn.mockRestore(); }
  });
});
