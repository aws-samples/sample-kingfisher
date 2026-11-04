// @kf-batch 50-W5-seg2-WP8
// 模块 51 store 单测(51 SPEC §1 / §2 / §6.1①③④;ACCEPTANCE M1 反例 / M15 / M18)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const mem = vi.hoisted(() => ({ db: null as unknown as import("./mem-ddb").MemDdb }));
vi.mock("@/lib/aws/dynamodb", async () => {
  const { createMemDdb } = await import("./mem-ddb");
  mem.db = createMemDdb({ "bgp-settings": ["pk", "sk"], "bgp-audit": ["pk", "ts"] });
  return {
    TABLES: { SETTINGS: "bgp-settings", AUDIT: "bgp-audit" },
    docClient: { send: (cmd: any) => mem.db.send(cmd) },
  };
});

import {
  putGlobalModel,
  getModelSetting,
  deleteModelSetting,
  listScopeOverrides,
  getVersion,
  bumpVersion,
  putProbe,
  getProbe,
  listProbes,
  isProbeFresh,
  putTransport,
  getTransport,
  assertNoTtl,
  isScopeSk,
  skForProbe,
  ModelVersionConflictError,
  PROBE_TTL_MS,
} from "../model-store";
import { buildAuditItem } from "@/lib/audit";
import type { ProbeOk } from "@/lib/ai/capabilities";

const actor = { actor: "admin@example.com", actorSub: "sub-admin", email: "admin@example.com" };
const okProbe: ProbeOk = { ok: true, toolUseOk: true, probedAt: 1_700_000_000_000 };
const SETTINGS = "bgp-settings";
const AUDIT = "bgp-audit";

beforeEach(() => mem.db.reset());

describe("putGlobalModel:配置 + __version + 审计 三项同一事务(SPEC §6.1③)", () => {
  it("一次 TransactWriteCommand 落三项;配置 version=1、__version=1、审计一条", async () => {
    const r = await putGlobalModel({ scope: "global", modelId: "global.anthropic.claude-opus-4-8", probe: okProbe, actor, ctx: { method: "PUT", path: "/api/admin/model-config" } });
    const tx = mem.db.log.filter((l) => l.cmd === "TransactWriteCommand");
    expect(tx).toHaveLength(1);
    expect(tx[0].input.TransactItems).toHaveLength(3);
    const kinds = tx[0].input.TransactItems.map((t: Record<string, unknown>) => Object.keys(t)[0]);
    expect(kinds).toEqual(["Update", "Update", "Put"]);
    expect(tx[0].input.TransactItems[2].Put.TableName).toBe(AUDIT);

    const item = await getModelSetting("global");
    expect(item?.modelId).toBe("global.anthropic.claude-opus-4-8");
    expect(item?.probeOk).toBe(true);
    expect(item?.version).toBe(1);
    expect(item?.sk).toBe("ai-model#global");
    expect(r.version).toBe(1);
    expect(await getVersion()).toBe(1);

    const audits = mem.db.dump(AUDIT);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("model-config.update");
    expect(audits[0].resourceType).toBe("model-config");
    expect(audits[0].method).toBe("PUT");
  });

  it("事务里的审计 item 与 writeAuditRecord 的 item **同一组属性名**(不写第二套形状)", async () => {
    await putGlobalModel({ scope: "global", modelId: "global.anthropic.claude-opus-4-8", probe: okProbe, actor, ctx: { method: "PUT", path: "/x" } });
    const inTx = mem.db.dump(AUDIT)[0];
    const reference = buildAuditItem(actor, "model-config.update", { resourceType: "model-config", resourceId: "global", detail: {} }, { method: "PUT", path: "/x" }).item;
    expect(Object.keys(inTx).sort()).toEqual(Object.keys(reference).sort());
  });

  it("expectVersion 过期 ⇒ ModelVersionConflictError,且配置 / __version / 审计全部不动(M1 反例)", async () => {
    await putGlobalModel({ scope: "global", modelId: "m1", probe: okProbe, actor });
    await expect(
      putGlobalModel({ scope: "global", modelId: "m2", probe: okProbe, actor, expectVersion: 0 })
    ).rejects.toBeInstanceOf(ModelVersionConflictError);
    expect((await getModelSetting("global"))?.modelId).toBe("m1");
    expect(await getVersion()).toBe(1);
    expect(mem.db.dump(AUDIT)).toHaveLength(1);
  });

  it("expectVersion 正确 ⇒ version+1;返回值直接给新版本", async () => {
    await putGlobalModel({ scope: "global", modelId: "m1", probe: okProbe, actor });
    const r = await putGlobalModel({ scope: "global", modelId: "m2", probe: okProbe, actor, expectVersion: 1 });
    expect(r.version).toBe(2);
    expect((await getModelSetting("global"))?.version).toBe(2);
    expect(await getVersion()).toBe(2);
  });

  it("事务失败(mock 抛)⇒ 抛出且配置未变(审计写不进去配置就不生效)", async () => {
    await putGlobalModel({ scope: "global", modelId: "m1", probe: okProbe, actor });
    mem.db.injectError((cmd) => (cmd === "TransactWriteCommand" ? Object.assign(new Error("audit table down"), { name: "InternalServerError" }) : null));
    await expect(putGlobalModel({ scope: "global", modelId: "m2", probe: okProbe, actor })).rejects.toThrow("audit table down");
    mem.db.injectError(null);
    expect((await getModelSetting("global"))?.modelId).toBe("m1");
    expect(await getVersion()).toBe(1);
  });

  it("运行期兜底:probe.ok 被 as 绕过成 false ⇒ 抛,不写库(M15 运行期面)", async () => {
    const bad = { ok: false } as unknown as ProbeOk;
    await expect(putGlobalModel({ scope: "global", modelId: "m1", probe: bad, actor })).rejects.toThrow(/ok:true/);
    expect(await getModelSetting("global")).toBeNull();
    expect(mem.db.log.filter((l) => l.cmd === "TransactWriteCommand")).toHaveLength(0);
  });

  it("写入的配置项**不带 ttl**(纪律②)", async () => {
    await putGlobalModel({ scope: "global", modelId: "m1", probe: okProbe, actor });
    const item = mem.db.dump(SETTINGS).find((i) => i.sk === "ai-model#global")!;
    expect(Object.keys(item)).not.toContain("ttl");
  });
});

describe("getModelSetting:形状不合法即 null(fail-closed)", () => {
  it("probeOk 不是 true 的存量项按不存在处理", async () => {
    mem.db.seed(SETTINGS, { pk: "system", sk: "ai-model#global", modelId: "x", probeOk: false, version: 3 });
    expect(await getModelSetting("global")).toBeNull();
  });
  it("缺 modelId 的项按不存在处理", async () => {
    mem.db.seed(SETTINGS, { pk: "system", sk: "ai-model#global", probeOk: true, version: 3 });
    expect(await getModelSetting("global")).toBeNull();
  });
});

describe("deleteModelSetting(恢复出厂默认的原语)", () => {
  it("存在 ⇒ 删 + bump + 审计;不存在 ⇒ false 且不 bump 不审计", async () => {
    expect(await deleteModelSetting("global", actor)).toBe(false);
    expect(await getVersion()).toBe(0);
    expect(mem.db.dump(AUDIT)).toHaveLength(0);

    await putGlobalModel({ scope: "global", modelId: "m1", probe: okProbe, actor });
    expect(await deleteModelSetting("global", actor, undefined, { modelId: "m1", version: 1 })).toBe(true);
    expect(await getModelSetting("global")).toBeNull();
    expect(await getVersion()).toBe(2);
    expect(mem.db.dump(AUDIT).map((a) => a.action)).toEqual(["model-config.update", "model-config.delete"]);
  });
});

describe("overrides 白名单(SPEC §2 GET)", () => {
  it("只留 scope 项:排除 __version / __transport / probe# / ratelimit#", async () => {
    await putGlobalModel({ scope: "global", modelId: "m1", probe: okProbe, actor });
    await putProbe("tgt_home", "m1", { ok: true });
    await putTransport({ gptReady: false, branch: null, decidedAt: 1, decidedBy: "a" }, actor);
    mem.db.seed(SETTINGS, { pk: "system", sk: "ratelimit#probe#sub#m#1", count: 1, ttl: 99 });
    const list = await listScopeOverrides();
    expect(list.map((i) => i.sk)).toEqual(["ai-model#global"]);
    expect(isScopeSk("ai-model#__version")).toBe(false);
    expect(isScopeSk("ai-model#__transport")).toBe(false);
    expect(isScopeSk("ai-model#probe#tgt_home#m1")).toBe(false);
    expect(isScopeSk("ai-model#global")).toBe(true);
    expect(isScopeSk("ai-model#tgt_usw2_b#global")).toBe(true);
  });
});

describe("__version(P0-2)", () => {
  it("冷表 0;bumpVersion ADD 自建 1、再 2", async () => {
    expect(await getVersion()).toBe(0);
    expect(await bumpVersion()).toBe(1);
    expect(await bumpVersion()).toBe(2);
    expect(await getVersion()).toBe(2);
  });
});

describe("探测缓存按 targetId × modelId 定形(P0-8 / M18)", () => {
  it("sk = ai-model#probe#<targetId>#<modelId>;两个 target 各一条", async () => {
    expect(skForProbe("tgt_home", "m1")).toBe("ai-model#probe#tgt_home#m1");
    await putProbe("tgt_home", "m1", { ok: true, toolUseOk: true }, 1000);
    await putProbe("tgt_usw2_b", "m1", { ok: false, error: "MarketplaceSCP", errorDetail: "denied" }, 1000);
    expect((await getProbe("tgt_home", "m1"))?.probeOk).toBe(true);
    expect((await getProbe("tgt_usw2_b", "m1"))?.probeError).toBe("MarketplaceSCP");
    expect((await listProbes("tgt_home")).map((p) => p.sk)).toEqual(["ai-model#probe#tgt_home#m1"]);
    for (const it of mem.db.dump(SETTINGS)) if (String(it.sk).startsWith("ai-model#")) expect(Object.keys(it)).not.toContain("ttl");
  });
  it("24h 内新鲜;超过即未知", () => {
    expect(isProbeFresh({ probedAt: 1000 }, 1000 + PROBE_TTL_MS - 1)).toBe(true);
    expect(isProbeFresh({ probedAt: 1000 }, 1000 + PROBE_TTL_MS)).toBe(false);
    expect(isProbeFresh(null)).toBe(false);
  });
  it("store 坏了 ⇒ putProbe 静默返回 false,不抛(SPEC §3.4a④)", async () => {
    mem.db.injectError(() => Object.assign(new Error("table missing"), { name: "ResourceNotFoundException" }));
    await expect(putProbe("tgt_home", "m1", { ok: true })).resolves.toBe(false);
  });
});

describe("transport 项(P51.2)", () => {
  it("putTransport 三项一事务并 bump;getTransport 读回", async () => {
    await putTransport({ gptReady: true, branch: "A", decidedAt: 5, decidedBy: "admin", probeModelId: "openai.gpt-5.6-sol", probedAt: 5 }, actor);
    expect((await getTransport())?.gptReady).toBe(true);
    expect(await getVersion()).toBe(1);
    const tx = mem.db.log.filter((l) => l.cmd === "TransactWriteCommand");
    expect(tx[0].input.TransactItems).toHaveLength(3);
  });
});

describe("assertNoTtl", () => {
  it("带 ttl 即抛", () => {
    expect(() => assertNoTtl({ sk: "ai-model#global", ttl: 1 })).toThrow(/ttl/);
    expect(() => assertNoTtl({ sk: "ai-model#global" })).not.toThrow();
  });
});
