import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

// S0(50 SPEC §0/§3.7)— queryHandle 的安全判定单测。
//
// 为什么必须有这层单测:S0 修的是**现网越权**,而它的验收铁证("A 拿 B 的 statementId → 403")
// 需要跑起来的环境。单测把每条判定钉在本机 CI 里,任何后续改动一旦把某条放行就当场红。
// 尤其钉住 🔴 **"拿自己的 handle 去配别人的 statementId"** —— 这是本修复最容易写漏的一步:
// 只查"handle 存在且归属我"而不查"handle.statementId == URL 里的 id",等于完全没修。

// ── mock DDB ──
const getMock = vi.fn();
const putMock = vi.fn();
vi.mock("@/lib/aws/dynamodb", () => ({
  docClient: {
    send: (cmd: any) => (cmd.__kind === "get" ? getMock(cmd) : putMock(cmd)),
  },
  TABLES: { QUERY_HANDLES: "bgp-query-handles", SETTINGS: "bgp-settings" },
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  GetCommand: class { __kind = "get"; constructor(public input: any) {} },
  PutCommand: class { __kind = "put"; constructor(public input: any) {} },
}));

// ── mock 身份与角色 ──
const identityMock = vi.fn();
vi.mock("@/lib/auth/identity", () => ({
  resolveIdentity: () => identityMock(),
}));
const roleMock = vi.fn();
vi.mock("@/lib/projects/project-service", () => ({
  resolveRole: (...a: unknown[]) => roleMock(...a),
}));
vi.mock("@/lib/projects/guard", () => ({
  getActiveProjectId: () => "proj-a",
}));

import { requireQueryHandle, __resetHandleFlagCache, HANDLE_PARAM } from "../query-handle";

const NOW_SEC = () => Math.floor(Date.now() / 1000);
const ALICE = { sub: "sub-alice", username: "alice", groups: [], isPlatformAdmin: false, isManager: false, isDeveloper: false, demo: false };
const BOB = { ...ALICE, sub: "sub-bob", username: "bob" };

/** 造一个只带 handleId 查询参数的假 NextRequest(requireQueryHandle 只用到 nextUrl.searchParams)。 */
function reqWith(handleId?: string): any {
  const url = new URL("https://x/api/redshift/result/stmt-1");
  if (handleId) url.searchParams.set(HANDLE_PARAM, handleId);
  return { nextUrl: url };
}

/** 让 SETTINGS 的开关读取返回"缺项"(= 默认强制),QUERY_HANDLES 返回给定 item。 */
function wireDdb(handleItem: unknown, opts: { settingsThrows?: boolean; enforce?: boolean } = {}) {
  getMock.mockImplementation((cmd: any) => {
    if (cmd.input.TableName === "bgp-settings") {
      if (opts.settingsThrows) return Promise.reject(new Error("table not found"));
      return Promise.resolve({ Item: opts.enforce === false ? { enforce: false } : undefined });
    }
    return Promise.resolve({ Item: handleItem });
  });
}

function freshHandle(over: Record<string, unknown> = {}) {
  return {
    handleId: "h-1",
    statementId: "stmt-1",
    ownerSub: ALICE.sub,
    projectId: "proj-a",
    engine: "redshift",
    createdAt: new Date().toISOString(),
    expiresAt: NOW_SEC() + 3600,
    ttl: NOW_SEC() + 3600,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetHandleFlagCache();
  identityMock.mockResolvedValue(ALICE);
  roleMock.mockResolvedValue(null);
});

describe("requireQueryHandle — 拒绝路径(每条都是一个越权口)", () => {
  it("未认证 → 401", async () => {
    identityMock.mockResolvedValue(null);
    wireDdb(freshHandle());
    const r = await requireQueryHandle(reqWith("h-1"), "stmt-1", "redshift");
    expect(r).toBeInstanceOf(NextResponse);
    expect((r as NextResponse).status).toBe(401);
  });

  it("完全不带 handleId → 403(这正是修复前的调用形态)", async () => {
    wireDdb(freshHandle());
    const r = await requireQueryHandle(reqWith(), "stmt-1", "redshift");
    expect((r as NextResponse).status).toBe(403);
  });

  it("handleId 不存在 → 403", async () => {
    wireDdb(undefined);
    const r = await requireQueryHandle(reqWith("h-nope"), "stmt-1", "redshift");
    expect((r as NextResponse).status).toBe(403);
  });

  it("🔴 拿自己的 handle 配别人的 statementId → 403(最易写漏的绕过)", async () => {
    // handle 合法、归属就是调用者本人,但它记录的语句是 stmt-1,而 URL 要取 stmt-OTHER。
    wireDdb(freshHandle({ statementId: "stmt-1" }));
    const r = await requireQueryHandle(reqWith("h-1"), "stmt-OTHER", "redshift");
    expect((r as NextResponse).status).toBe(403);
  });

  it("引擎不匹配 → 403(athena 的 handle 不能取 redshift 的结果)", async () => {
    wireDdb(freshHandle({ engine: "athena" }));
    const r = await requireQueryHandle(reqWith("h-1"), "stmt-1", "redshift");
    expect((r as NextResponse).status).toBe(403);
  });

  it("已过期 → 410", async () => {
    wireDdb(freshHandle({ expiresAt: NOW_SEC() - 1 }));
    const r = await requireQueryHandle(reqWith("h-1"), "stmt-1", "redshift");
    expect((r as NextResponse).status).toBe(410);
  });

  it("他人的 handle + 调用者不是该项目成员 → 403", async () => {
    identityMock.mockResolvedValue(BOB);
    roleMock.mockResolvedValue(null); // 非成员
    wireDdb(freshHandle({ ownerSub: ALICE.sub }));
    const r = await requireQueryHandle(reqWith("h-1"), "stmt-1", "redshift");
    expect((r as NextResponse).status).toBe(403);
  });

  it("DDB 读失败 → 503(不放行)", async () => {
    getMock.mockImplementation((cmd: any) =>
      cmd.input.TableName === "bgp-settings"
        ? Promise.resolve({ Item: undefined })
        : Promise.reject(new Error("boom"))
    );
    const r = await requireQueryHandle(reqWith("h-1"), "stmt-1", "redshift");
    expect((r as NextResponse).status).toBe(503);
  });
});

describe("requireQueryHandle — 放行路径(证明没把合法查询也拒了)", () => {
  it("本人的有效 handle → 放行", async () => {
    wireDdb(freshHandle());
    const r = await requireQueryHandle(reqWith("h-1"), "stmt-1", "redshift");
    expect(r).not.toBeInstanceOf(NextResponse);
    expect((r as any).ok).toBe(true);
    expect((r as any).handle.handleId).toBe("h-1");
  });

  it("他人的 handle 但调用者是同项目成员 → 放行(所有权 OR 项目双判)", async () => {
    identityMock.mockResolvedValue(BOB);
    roleMock.mockResolvedValue("viewer");
    wireDdb(freshHandle({ ownerSub: ALICE.sub }));
    const r = await requireQueryHandle(reqWith("h-1"), "stmt-1", "redshift");
    expect(r).not.toBeInstanceOf(NextResponse);
  });
});

describe("回滚开关的 fail-closed 方向", () => {
  it("🔴 配置表读不到 → 仍然强制校验(不能一挂就恢复 IDOR)", async () => {
    wireDdb(freshHandle(), { settingsThrows: true });
    // 不带 handle:若开关 fail-open 成 false,这里会被放行 = 洞又开了。
    const r = await requireQueryHandle(reqWith(), "stmt-1", "redshift");
    expect((r as NextResponse).status).toBe(403);
  });

  it("显式 enforce:false → 放行(紧急回滚通道,handle 为 null)", async () => {
    wireDdb(freshHandle(), { enforce: false });
    const r = await requireQueryHandle(reqWith(), "stmt-1", "redshift");
    expect(r).not.toBeInstanceOf(NextResponse);
    expect((r as any).handle).toBeNull();
  });
});
