// 序 72 B-139 —— 两条接口的入口判据:登录即可用(401)· engine 闭合清单(400)· 落点点名(缺 ⇒ 400,不默认主控区)·
//   IAM 没权限 ⇒ 502 UPSTREAM_ERROR 点名升级 · 预检接口形态错 400 / 平台默认不需要预检。只 mock 身份与 lib 单一作者(路由是薄封装)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ identity: { username: "u", sub: "s", isPlatformAdmin: false } as unknown, listError: null as null | { name: string; message: string }, preflightCalls: [] as unknown[] }));

vi.mock("@/lib/auth/identity", () => ({ resolveIdentity: async () => h.identity }));
vi.mock("@/lib/execution-role/candidates", () => ({
  listExecutionRoleCandidates: async (args: { engine: string; targetId: string }) => {
    if (h.listError) throw Object.assign(new Error(h.listError.message), { name: h.listError.name });
    return { engine: args.engine, targetId: args.targetId, servicePrincipal: "glue.amazonaws.com", groups: { platform: [], advisor: [], custom: [] }, total: 0, fetchedAt: "t" };
  },
}));
vi.mock("@/lib/execution-role/preflight", () => ({
  preflightExecutionRole: async (input: unknown) => { h.preflightCalls.push(input); return { ok: true, roleExists: true, gaps: [], checked: 3, trusted: true }; },
}));

import { GET as candidatesGET } from "../candidates/route";
import { POST as preflightPOST } from "../preflight/route";

const get = (qs: string) => candidatesGET(new NextRequest(`http://x/api/exec-roles/candidates${qs}`));
const post = (body: unknown) => preflightPOST(new NextRequest("http://x/api/exec-roles/preflight", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

beforeEach(() => { h.identity = { username: "u", sub: "s", isPlatformAdmin: false }; h.listError = null; h.preflightCalls = []; });

describe("GET /api/exec-roles/candidates", () => {
  it("未登录 401;engine 不在清单 400;缺 targetId 400(不默认主控区);齐 ⇒ 200 带三组", async () => {
    h.identity = null;
    expect((await get("?engine=glue&targetId=tgt_home")).status).toBe(401);
    h.identity = { username: "u", sub: "s", isPlatformAdmin: false };
    const bad = await get("?engine=dms&targetId=tgt_home");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toContain("glue / emr / flink");
    const noTarget = await get("?engine=glue");
    expect(noTarget.status).toBe(400);
    expect((await noTarget.json()).error.message).toContain("targetId");
    const ok = await get("?engine=glue&targetId=tgt_usw2_a");
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.data.targetId).toBe("tgt_usw2_a");
    expect(Object.keys(body.data.groups).sort()).toEqual(["advisor", "custom", "platform"]);
  });
  it("IAM AccessDenied ⇒ 502 UPSTREAM_ERROR,文案点名 iam:ListRoles 与升级平台", async () => {
    h.listError = { name: "AccessDeniedException", message: "not authorized" };
    const res = await get("?engine=glue&targetId=tgt_home");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("UPSTREAM_ERROR");
    expect(body.error.message).toContain("iam:ListRoles");
    expect(body.error.message).toContain("手动输入 ARN");
  });
});

describe("POST /api/exec-roles/preflight", () => {
  it("未登录 401;engine 错 400;缺 roleArn 400(平台默认不需要预检);形态错 400;缺 targetId 400;齐 ⇒ 200 透传三态结果,extraS3Uris 只留字符串", async () => {
    h.identity = null;
    expect((await post({ engine: "glue", targetId: "tgt_home", roleArn: "arn:aws:iam::123456789012:role/x" })).status).toBe(401);
    h.identity = { username: "u", sub: "s", isPlatformAdmin: false };
    expect((await post({ engine: "redshift", targetId: "tgt_home", roleArn: "arn:aws:iam::123456789012:role/x" })).status).toBe(400);
    const noRole = await post({ engine: "glue", targetId: "tgt_home", roleArn: "" });
    expect(noRole.status).toBe(400);
    expect((await noRole.json()).error.message).toContain("平台默认");
    const badShape = await post({ engine: "glue", targetId: "tgt_home", roleArn: "customer-role" });
    expect(badShape.status).toBe(400);
    expect((await badShape.json()).error.message).toContain("执行角色 ARN 格式非法");
    expect((await post({ engine: "glue", roleArn: "arn:aws:iam::123456789012:role/x" })).status).toBe(400);
    const ok = await post({ engine: "glue", targetId: "tgt_use1_a", roleArn: " arn:aws:iam::123456789012:role/x ", extraS3Uris: ["s3://b/k", 7], scriptCode: "x" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).data).toEqual({ ok: true, roleExists: true, gaps: [], checked: 3, trusted: true });
    expect(h.preflightCalls).toEqual([{ engine: "glue", roleArn: "arn:aws:iam::123456789012:role/x", targetId: "tgt_use1_a", extraS3Uris: ["s3://b/k"], scriptCode: "x" }]);
  });
});
