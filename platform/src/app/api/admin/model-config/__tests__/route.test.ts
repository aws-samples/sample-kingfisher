// 管理路由的**可执行**门禁(51 SPEC §2 PUT 服务端流程;ACCEPTANCE M1 / M3 / M4 / M7 / M10 / M12 / M13 / M13a / M15)。
// 真跑 route handler(NextRequest 进、Response 出),只打桩三样:DynamoDB(内存模拟器)、身份、目录 + 探测(零真 AWS)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const st = vi.hoisted(() => ({
  db: null as unknown as import("@/lib/settings/__tests__/mem-ddb").MemDdb,
  identity: { sub: "sub-admin", username: "admin", email: "admin@example.com", groups: ["bgp-admin"], isPlatformAdmin: true, isManager: true, isDeveloper: true, demo: false } as any,
  catalog: [] as { modelId: string }[],
  catalogError: null as Error | null,
  probeResult: { ok: true, toolUseOk: true, quotaHint: "unknown", probedAt: 1 } as any,
  probeCalls: [] as string[],
}));

vi.mock("@/lib/aws/dynamodb", async () => {
  const { createMemDdb } = await import("@/lib/settings/__tests__/mem-ddb");
  st.db = createMemDdb({ "bgp-settings": ["pk", "sk"], "bgp-audit": ["pk", "ts"] });
  return { TABLES: { SETTINGS: "bgp-settings", AUDIT: "bgp-audit" }, docClient: { send: (cmd: any) => st.db.send(cmd) } };
});
vi.mock("@/lib/auth/identity", () => ({ resolveIdentity: vi.fn(async () => st.identity) }));
// 目录 / 探测的区改从描述符来(主控区也一样):注册表是真外部(DDB 边界),给一份主控区描述符。
//   `homeMissing` = 主控区描述符不存在 ⇒ PUT / probe 必须 409,**不回落** process.env.AWS_REGION。
const reg = vi.hoisted(() => ({ homeMissing: false, placeCalls: [] as string[] }));
vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    getTargetRaw: vi.fn(async (id: string) => {
      reg.placeCalls.push(id);
      if (id !== "tgt_home" || reg.homeMissing) return null;
      return { targetId: "tgt_home", region: "eu-central-1", accountId: "000000000000", partition: "aws", status: "active", ready: true, resources: {} };
    }),
    descriptorViolation: vi.fn(() => null),
  };
});
vi.mock("@/lib/settings/model-catalog", () => ({
  fetchCatalog: vi.fn(async () => {
    if (st.catalogError) throw st.catalogError;
    return st.catalog;
  }),
}));
vi.mock("@/lib/ai/probe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/probe")>("@/lib/ai/probe");
  return {
    ...actual,
    probeModel: vi.fn(async (modelId: string) => {
      st.probeCalls.push(modelId);
      const r = { ...st.probeResult };
      // 与真 probeModel 一样写缓存(transport 前置证据靠它)
      const { putProbe } = await import("@/lib/settings/model-store");
      await putProbe("tgt_home", modelId, r, r.probedAt);
      return r;
    }),
  };
});

const { GET, PUT, DELETE } = await import("@/app/api/admin/model-config/route");
const probeRoute = await import("@/app/api/admin/model-config/probe/route");
const transportRoute = await import("@/app/api/admin/model-config/transport/route");
const { _resetModelCacheForTests } = await import("@/lib/ai/model");
const { _resetTransportCacheForTests } = await import("@/lib/ai/transport-gate");
const { putTransport } = await import("@/lib/settings/model-store");

const url = "http://localhost/api/admin/model-config";
const jsonReq = (method: string, body?: unknown, path = url) =>
  new NextRequest(path, { method, headers: { "content-type": "application/json", "x-correlation-id": "cid-test" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

const OPUS = "global.anthropic.claude-opus-4-8";
const GPT = "openai.gpt-5.6-sol";
// 四系列(2026-10-14 Bedrock 真实 id;两款都只有推理配置形态能调)
const GLM = "us.zai.glm-5.3";
const KIMI = "global.moonshotai.kimi-k3";

beforeEach(() => {
  st.db.reset();
  _resetModelCacheForTests();
  _resetTransportCacheForTests();
  st.identity = { sub: "sub-admin", username: "admin", email: "admin@example.com", groups: ["bgp-admin"], isPlatformAdmin: true, isManager: true, isDeveloper: true, demo: false };
  st.catalog = [{ modelId: OPUS }, { modelId: GPT }, { modelId: "us.anthropic.claude-opus-4-6-v1" }, { modelId: GLM }, { modelId: KIMI }];
  st.catalogError = null;
  st.probeResult = { ok: true, toolUseOk: true, quotaHint: "unknown", probedAt: Date.now() };
  st.probeCalls = [];
  reg.homeMissing = false;
  reg.placeCalls = [];
  delete process.env.BEDROCK_MODEL_ID;
});

describe("🔴同类缺陷:目录 / 探测的区来自主控区**描述符**,不是 process.env.AWS_REGION", () => {
  it("PUT:目录与探测都拿到主控区描述符的 region(eu-central-1,与本进程 env 无关)", async () => {
    const { fetchCatalog } = await import("@/lib/settings/model-catalog");
    const { probeModel } = await import("@/lib/ai/probe");
    expect((await PUT(jsonReq("PUT", { modelId: OPUS }))).status).toBe(200);
    expect(vi.mocked(fetchCatalog).mock.calls.at(-1)?.[0]).toMatchObject({ place: { targetId: "tgt_home", region: "eu-central-1" } });
    expect(vi.mocked(probeModel).mock.calls.at(-1)?.[1]).toMatchObject({ place: { targetId: "tgt_home", region: "eu-central-1" } });
  });
  it("主控区描述符不存在 ⇒ PUT 409 PLACE_UNAVAILABLE 且不拉目录、不探测;probe 409 且**不吃限频额度**", async () => {
    reg.homeMissing = true;
    const r = await PUT(jsonReq("PUT", { modelId: OPUS }));
    expect(r.status).toBe(409);
    expect((await r.json()).error?.code).toBe("PLACE_UNAVAILABLE");
    expect(st.probeCalls).toEqual([]);
    const p = await probeRoute.POST(jsonReq("POST", { modelId: OPUS }, `${url}/probe`));
    expect(p.status).toBe(409);
    expect(st.probeCalls).toEqual([]);
    // 不吃额度:描述符恢复后,同一分钟里仍能连探 6 次(限频 6/min;若那次 409 扣了额度,第 6 次会是 429)
    reg.homeMissing = false;
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await probeRoute.POST(jsonReq("POST", { modelId: OPUS }, `${url}/probe`))).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 200]);
  });
});

describe("M10 权限纵深", () => {
  it("非 admin ⇒ 403;未认证 ⇒ 401(即使网关漏了)", async () => {
    st.identity = { ...st.identity, isPlatformAdmin: false, groups: [] };
    expect((await PUT(jsonReq("PUT", { modelId: OPUS }))).status).toBe(403);
    expect((await GET(jsonReq("GET"))).status).toBe(403);
    st.identity = null;
    expect((await PUT(jsonReq("PUT", { modelId: OPUS }))).status).toBe(401);
  });
});

describe("M1 保存合法模型 + 乐观锁", () => {
  it("∈catalog + 探测通过 ⇒ 200 version=1;GET effective source=runtime;再存带过期 expectVersion ⇒ 409", async () => {
    const res = await PUT(jsonReq("PUT", { settingScope: "global", modelId: OPUS }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ ok: true, version: 1, modelId: OPUS });
    expect(st.probeCalls).toEqual([OPUS]); // 保存前强制探测

    const g = await (await GET(jsonReq("GET"))).json();
    expect(g.data.effective[0]).toMatchObject({ scope: "global", modelId: OPUS, source: "runtime", version: 1, probeOk: true });
    expect(g.data.overrides.map((o: any) => o.sk)).toEqual(["ai-model#global"]);
    expect(g.data.gptTransportReady).toBe(false);

    const conflict = await PUT(jsonReq("PUT", { settingScope: "global", modelId: "us.anthropic.claude-opus-4-6-v1", expectVersion: 0 }));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toBe("VersionConflict");
    expect((await (await GET(jsonReq("GET"))).json()).data.effective[0].modelId).toBe(OPUS); // 未变

    const ok2 = await PUT(jsonReq("PUT", { settingScope: "global", modelId: "us.anthropic.claude-opus-4-6-v1", expectVersion: 1 }));
    expect((await ok2.json()).data.version).toBe(2);
  });

  it("审计与配置同一事务:注入事务失败 ⇒ 503 且 DDB 无新项(SPEC §6.1③)", async () => {
    st.db.injectError((cmd) => (cmd === "TransactWriteCommand" ? Object.assign(new Error("down"), { name: "InternalServerError" }) : null));
    const res = await PUT(jsonReq("PUT", { modelId: OPUS }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("StoreUnavailable");
    st.db.injectError(null);
    expect(st.db.dump("bgp-settings").filter((i) => i.sk === "ai-model#global")).toHaveLength(0);
  });
});

describe("M3 一期 GPT 硬闸 / M13a 门恒关", () => {
  it("PUT openai.* ⇒ 400 NotAllowedFamily,且**不探测、不写库**", async () => {
    const res = await PUT(jsonReq("PUT", { modelId: GPT }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("NotAllowedFamily");
    expect(st.probeCalls).toEqual([]);
    expect(st.db.dump("bgp-settings")).toHaveLength(0);
  });
  it("M13a:即使 __transport 已手写 gptReady:true 且证据新鲜,PUT openai.* 仍 400 NotAllowedFamily", async () => {
    await putTransport({ gptReady: true, branch: "A", decidedAt: Date.now(), decidedBy: "x", probeModelId: GPT, probedAt: Date.now() }, { actor: "x" });
    _resetTransportCacheForTests();
    const res = await PUT(jsonReq("PUT", { modelId: GPT }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("NotAllowedFamily");
  });
});

describe("M4 白名单非仅前端", () => {
  it("直连 PUT haiku(不在四系列目录)⇒ 400 NotInCatalog(detail 由档案 label 拼出四个系列);不探测", async () => {
    const res = await PUT(jsonReq("PUT", { modelId: "us.anthropic.claude-haiku-4-5" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("NotInCatalog");
    for (const label of ["Claude Opus", "GPT-5.6", "GLM 5", "Kimi K3"]) expect(body.detail).toContain(label);
    expect(st.probeCalls).toEqual([]);
  });
  it("ARN / 大写 等格式非法 ⇒ 400 NotInCatalog(不打目录)", async () => {
    const res = await PUT(jsonReq("PUT", { modelId: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-8" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("NotInCatalog");
  });
  it("目录拉取失败 ⇒ 503 CatalogUnavailable(不放行、不探测)", async () => {
    st.catalogError = new Error("ListFoundationModels AccessDenied");
    const res = await PUT(jsonReq("PUT", { modelId: OPUS }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("CatalogUnavailable");
    expect(st.probeCalls).toEqual([]);
  });
});

describe("M2 / M15 探测失败不写库", () => {
  it("probe ok:false ⇒ 400 ProbeFailed + reason;DDB 无配置项", async () => {
    st.probeResult = { ok: false, error: "MarketplaceSCP", errorDetail: "AccessDeniedException: Marketplace subscription required", probedAt: Date.now() };
    const res = await PUT(jsonReq("PUT", { modelId: OPUS }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("ProbeFailed");
    expect(body.reason).toBe("MarketplaceSCP");
    expect(st.db.dump("bgp-settings").filter((i) => i.sk === "ai-model#global")).toHaveLength(0);
    expect(st.db.dump("bgp-audit")).toHaveLength(0);
  });
});

// 51 SPEC §7.4 ③′ / ACCEPTANCE M22
describe("M22 ③′ tool-use 门按模型证据(ToolUseUnavailable)", () => {
  it("Kimi K3 探测通过但 toolUseOk:false ⇒ 400 ToolUseUnavailable;已探测、不写库、无审计", async () => {
    st.probeResult = { ok: true, toolUseOk: false, quotaHint: "unknown", probedAt: Date.now() };
    const res = await PUT(jsonReq("PUT", { modelId: KIMI }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("ToolUseUnavailable");
    expect(body.detail).toContain(KIMI);
    expect(st.probeCalls).toEqual([KIMI]);
    expect(st.db.dump("bgp-settings").filter((i) => i.sk === "ai-model#global")).toHaveLength(0);
    expect(st.db.dump("bgp-audit")).toHaveLength(0);
  });
  it("GLM 5.3 探测通过且 toolUseOk:true ⇒ 200 写库;GET effective 为它", async () => {
    st.probeResult = { ok: true, toolUseOk: true, quotaHint: "unknown", probedAt: Date.now() };
    const res = await PUT(jsonReq("PUT", { modelId: GLM }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ ok: true, modelId: GLM, version: 1 });
    expect((await (await GET(jsonReq("GET"))).json()).data.effective[0].modelId).toBe(GLM);
  });
  it("Claude(档案 toolUse:assumed)不看 toolUseOk:缓存里 false 也照常 200", async () => {
    st.probeResult = { ok: true, toolUseOk: false, quotaHint: "unknown", probedAt: Date.now() };
    expect((await PUT(jsonReq("PUT", { modelId: OPUS }))).status).toBe(200);
  });
  it("账号级未开放:probe NotAvailableForAccount ⇒ 400 ProbeFailed reason=NotAvailableForAccount,不写库", async () => {
    st.probeResult = { ok: false, error: "NotAvailableForAccount", errorDetail: "AccessDeniedException: zai.glm-5.3 is not available for this account", probedAt: Date.now() };
    const res = await PUT(jsonReq("PUT", { modelId: GLM }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: "ProbeFailed", reason: "NotAvailableForAccount" });
    expect(st.db.dump("bgp-settings").filter((i) => i.sk === "ai-model#global")).toHaveLength(0);
  });
});

describe("M7 恢复出厂默认(DELETE)", () => {
  it("删除全部覆盖 ⇒ fellBackTo 报告 env/ssot;幂等(再删仍 200,deleted:false)", async () => {
    await PUT(jsonReq("PUT", { modelId: OPUS }));
    process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-6-v1";
    const res = await DELETE(jsonReq("DELETE", undefined, `${url}?settingScope=global`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ ok: true, deleted: true, fellBackTo: "env" });
    expect(body.data.effective.modelId).toBe("us.anthropic.claude-opus-4-6-v1");
    const again = await (await DELETE(jsonReq("DELETE", undefined, `${url}?settingScope=global`))).json();
    expect(again.data.deleted).toBe(false);
    expect(again.data.fellBackTo).toBe("env");
    delete process.env.BEDROCK_MODEL_ID;
    const g = await (await GET(jsonReq("GET"))).json();
    expect(g.data.effective[0].source).toBe("ssot");
    expect(g.data.overrides).toEqual([]);
  });
  it("settingScope 非 global ⇒ 400(一期)", async () => {
    expect((await DELETE(jsonReq("DELETE", undefined, `${url}?settingScope=codegen`))).status).toBe(400);
    expect((await PUT(jsonReq("PUT", { settingScope: "codegen", modelId: OPUS }))).status).toBe(400);
  });

  // 50 SPEC v3.34 §2.6.0:旧参数名 `scope` 即拒,**不留兼容别名**。
  // 🔴 为什么必须是「拒」而不是「忽略」:忽略会让旧调用方以为自己指定了作用域(实际落到 global),
  // 而一旦按 `settingScope=<targetId>#global` 做 per-region 覆盖,那就是静默改错区的模型。
  it("🔴 旧参数名 scope ⇒ 400 ScopeParamRenamed(query 与 body 两路都拒)", async () => {
    const q = await DELETE(jsonReq("DELETE", undefined, `${url}?scope=global`));
    expect(q.status).toBe(400);
    expect((await q.json()).error).toBe("ScopeParamRenamed");

    const b = await PUT(jsonReq("PUT", { scope: "global", modelId: OPUS }));
    expect(b.status).toBe(400);
    expect((await b.json()).error).toBe("ScopeParamRenamed");
  });

  it("🔴 旧名与新名同时出现也拒(不许「新名优先、旧名忽略」这种含糊行为)", async () => {
    const q = await DELETE(jsonReq("DELETE", undefined, `${url}?scope=global&settingScope=global`));
    expect(q.status).toBe(400);
    expect((await q.json()).error).toBe("ScopeParamRenamed");
  });
});

describe("M16 配置面挂了:GET 不 500,effective 退化为 stale/env/ssot", () => {
  it("DDB 全挂 ⇒ GET 200,source ∈ {env, ssot}", async () => {
    st.db.injectError(() => Object.assign(new Error("table missing"), { name: "ResourceNotFoundException" }));
    const res = await GET(jsonReq("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(["env", "ssot", "runtime-stale"]).toContain(body.data.effective[0].source);
  });
});

describe("M12 probe 限频(POST /probe)", () => {
  it("6 次 200 并写缓存,第 7 次 429 {error:RateLimited, retryAfterSec};计数项 sk 形态正确", async () => {
    const path = `${url}/probe`;
    for (let i = 0; i < 6; i++) {
      const r = await probeRoute.POST(jsonReq("POST", { modelId: OPUS }, path));
      expect(r.status).toBe(200);
    }
    const seventh = await probeRoute.POST(jsonReq("POST", { modelId: OPUS }, path));
    expect(seventh.status).toBe(429);
    const body = await seventh.json();
    expect(body.error).toBe("RateLimited");
    expect(typeof body.retryAfterSec).toBe("number");
    expect(st.probeCalls).toHaveLength(6); // 第 7 次没真探
    const counter = st.db.dump("bgp-settings").find((i) => String(i.sk).startsWith("ratelimit#probe#sub-admin#m#"))!;
    expect(counter).toBeTruthy();
    expect(counter.count).toBe(7);
    expect(typeof counter.ttl).toBe("number");
    expect(st.db.dump("bgp-settings").some((i) => i.sk === `ai-model#probe#tgt_home#${OPUS}`)).toBe(true);
  });
  it("计数器不可用 ⇒ fail-closed 429(不放行探测)", async () => {
    st.db.injectError((cmd) => (cmd === "UpdateCommand" ? Object.assign(new Error("table missing"), { name: "ResourceNotFoundException" }) : null));
    const r = await probeRoute.POST(jsonReq("POST", { modelId: OPUS }, `${url}/probe`));
    expect(r.status).toBe(429);
    expect((await r.json()).reason).toBe("store-error");
    expect(st.probeCalls).toHaveLength(0);
  });
});

describe("M13 transport 门控负向(PUT /transport)", () => {
  const path = `${url}/transport`;
  it("未探测即置 gptReady:true ⇒ 400 TransportNotVerified;DDB 无 __transport", async () => {
    const r = await transportRoute.PUT(jsonReq("PUT", { gptReady: true, branch: "A" }, path));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("TransportNotVerified");
    expect(st.db.dump("bgp-settings").some((i) => i.sk === "ai-model#__transport")).toBe(false);
  });
  it("探测通过但 toolUseOk=false ⇒ 仍 400 TransportNotVerified", async () => {
    st.probeResult = { ok: true, toolUseOk: false, probedAt: Date.now() };
    await probeRoute.POST(jsonReq("POST", { modelId: GPT }, `${url}/probe`));
    const r = await transportRoute.PUT(jsonReq("PUT", { gptReady: true, branch: "A" }, path));
    expect(r.status).toBe(400);
  });
  it("探测通过且 toolUseOk=true ⇒ 置位成功(带证据、bump);GET 呈现 ready:true 但 hardGate 仍 false", async () => {
    st.probeResult = { ok: true, toolUseOk: true, probedAt: Date.now() };
    await probeRoute.POST(jsonReq("POST", { modelId: GPT }, `${url}/probe`));
    const r = await transportRoute.PUT(jsonReq("PUT", { gptReady: true, branch: "A" }, path));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.data.evidence.probeModelId).toBe(GPT);
    expect(body.data.hardGate).toBe(false);
    const g = await (await transportRoute.GET(jsonReq("GET", undefined, path))).json();
    expect(g.data.ready).toBe(true);
    expect(g.data.hardGate).toBe(false);
    expect(st.db.dump("bgp-settings").find((i) => i.sk === "ai-model#__version")?.version).toBe(1);
    expect(st.db.dump("bgp-audit").map((a) => a.action)).toContain("model-config.transport");
  });
  it("gptReady:false 不需要证据,直接落库", async () => {
    const r = await transportRoute.PUT(jsonReq("PUT", { gptReady: false }, path));
    expect(r.status).toBe(200);
  });
});

// (2026-10-20 真测):保存不再对刚通过的探测二次探 —— Kimi K3 首字延迟 3–39s,
//   原来页面「测试该模型」通过后点「保存」,保存路由重探随机超时 ⇒ 「探测被限流」保存失败(…7237 p46 三跑三红)。
describe("保存认 10 分钟内同区通过的探测缓存(freshProbeFromCache),不再二次探", () => {
  it("页面 /probe 刚通过(toolUseOk:true)⇒ PUT 不再调 probeModel,仍 200 写库,配置项 probedAt = 缓存那次", async () => {
    const { probeModel } = await import("@/lib/ai/probe");
    const at = Date.now() - 30_000;
    st.probeResult = { ok: true, toolUseOk: true, quotaHint: "unknown", probedAt: at };
    expect((await probeRoute.POST(jsonReq("POST", { modelId: KIMI }, `${url}/probe`))).status).toBe(200);
    const calls0 = vi.mocked(probeModel).mock.calls.length;
    const r = await PUT(jsonReq("PUT", { modelId: KIMI }));
    expect(r.status).toBe(200);
    expect(vi.mocked(probeModel).mock.calls.length).toBe(calls0); // 没有二次探
    const item = st.db.dump("bgp-settings").find((i) => i.sk === "ai-model#global");
    expect(item?.modelId).toBe(KIMI);
    expect(item?.probedAt).toBe(at);
  });
  it("缓存过期(> 10 分钟)⇒ 照旧现探(probeModel 被调)", async () => {
    const { probeModel } = await import("@/lib/ai/probe");
    st.probeResult = { ok: true, toolUseOk: true, quotaHint: "unknown", probedAt: Date.now() - 11 * 60_000 };
    await probeRoute.POST(jsonReq("POST", { modelId: KIMI }, `${url}/probe`));
    const calls0 = vi.mocked(probeModel).mock.calls.length;
    st.probeResult = { ok: true, toolUseOk: true, quotaHint: "unknown", probedAt: Date.now() };
    expect((await PUT(jsonReq("PUT", { modelId: KIMI }))).status).toBe(200);
    expect(vi.mocked(probeModel).mock.calls.length).toBe(calls0 + 1);
  });
  it("缓存新鲜但 Kimi 的 toolUseOk:false(二探超时)⇒ 不认缓存、现探;现探 tool-use 通过 ⇒ 200", async () => {
    const { probeModel } = await import("@/lib/ai/probe");
    st.probeResult = { ok: true, toolUseOk: false, toolUseError: "Timeout", quotaHint: "unknown", probedAt: Date.now() - 5_000 };
    await probeRoute.POST(jsonReq("POST", { modelId: KIMI }, `${url}/probe`));
    const calls0 = vi.mocked(probeModel).mock.calls.length;
    st.probeResult = { ok: true, toolUseOk: true, quotaHint: "unknown", probedAt: Date.now() };
    expect((await PUT(jsonReq("PUT", { modelId: KIMI }))).status).toBe(200);
    expect(vi.mocked(probeModel).mock.calls.length).toBe(calls0 + 1);
  });
  it("缓存是失败的(probeOk:false,Timeout)⇒ 不认缓存、现探;现探仍 Timeout ⇒ 400 ProbeFailed reason=Timeout(不再写成 Throttle)", async () => {
    st.probeResult = { ok: false, error: "Timeout", errorDetail: "TimeoutError: The operation was aborted due to timeout", probedAt: Date.now() };
    await probeRoute.POST(jsonReq("POST", { modelId: KIMI }, `${url}/probe`));
    const r = await PUT(jsonReq("PUT", { modelId: KIMI }));
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe("ProbeFailed"); // modelConfigError 形状:{ success:false, error, ...extra }
    expect(body.reason).toBe("Timeout");
  });
});
