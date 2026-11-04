// 解析链单测(51 SPEC §3.1 / §3.1a / §6.1② / §6.2①②;ACCEPTANCE M7 / M16 / M18)。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mem = vi.hoisted(() => ({ db: null as unknown as import("@/lib/settings/__tests__/mem-ddb").MemDdb }));
vi.mock("@/lib/aws/dynamodb", async () => {
  const { createMemDdb } = await import("@/lib/settings/__tests__/mem-ddb");
  mem.db = createMemDdb({ "bgp-settings": ["pk", "sk"], "bgp-audit": ["pk", "ts"] });
  return { TABLES: { SETTINGS: "bgp-settings", AUDIT: "bgp-audit" }, docClient: { send: (cmd: any) => mem.db.send(cmd) } };
});

import {
  DEFAULT_MODEL_ID,
  resolveModelId,
  resolveModelIdRuntime,
  resolveModelRuntime,
  resolveWithProvenance,
  resolveLayered,
  readVersionCached,
  deriveScope,
  scopeKeyOf,
  isModelIdFormatValid,
  _resetModelCacheForTests,
  _cacheKeysForTests,
  VERSION_TTL_MS,
  MODEL_CACHE_TTL_MS,
} from "../model";
import { putGlobalModel, bumpVersion } from "@/lib/settings/model-store";
import type { ProbeOk } from "../capabilities";

const actor = { actor: "admin" };
const okProbe: ProbeOk = { ok: true };
const savedEnv = process.env.BEDROCK_MODEL_ID;

beforeEach(() => {
  mem.db.reset();
  _resetModelCacheForTests();
  delete process.env.BEDROCK_MODEL_ID;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.BEDROCK_MODEL_ID;
  else process.env.BEDROCK_MODEL_ID = savedEnv;
});

describe("D2 零迁移:① 层为空时与同步 resolveModelId() 逐字节等价", () => {
  it("无配置、无 env ⇒ SSOT,且 == resolveModelId()", async () => {
    const r = await resolveModelRuntime("genbi");
    expect(r).toEqual({ modelId: DEFAULT_MODEL_ID, source: "ssot" });
    expect(await resolveModelIdRuntime("genbi")).toBe(resolveModelId());
  });
  it("无配置、有 env ⇒ env,且 == resolveModelId()", async () => {
    process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-1-v1";
    const r = await resolveModelRuntime("copilot");
    expect(r).toEqual({ modelId: "us.anthropic.claude-opus-4-1-v1", source: "env" });
    expect(r.modelId).toBe(resolveModelId());
  });
});

describe("运行时配置层 + 秒级失活", () => {
  it("有 ai-model#global ⇒ runtime;缓存命中不再打库;bump 后在 5s 版本 TTL 后重取", async () => {
    await putGlobalModel({ scope: "global", modelId: "global.anthropic.claude-opus-4-8", probe: okProbe, actor });
    const t0 = 1_000_000;
    expect(await resolveModelRuntime("genbi", undefined, t0)).toEqual({ modelId: "global.anthropic.claude-opus-4-8", source: "runtime" });
    const reads = mem.db.log.filter((l) => l.cmd === "GetCommand").length;
    await resolveModelRuntime("genbi", undefined, t0 + 1000);
    expect(mem.db.log.filter((l) => l.cmd === "GetCommand").length).toBe(reads); // 命中缓存,零读

    await putGlobalModel({ scope: "global", modelId: "us.anthropic.claude-opus-4-7-v1", probe: okProbe, actor, expectVersion: 1 });
    // 5s 内版本缓存未过期 ⇒ 仍旧值(合同允许 ≤5s 收敛窗)
    expect((await resolveModelRuntime("genbi", undefined, t0 + 2000)).modelId).toBe("global.anthropic.claude-opus-4-8");
    // 过了 VERSION_TTL_MS ⇒ 读到新 __version ⇒ 弃缓存重取
    expect((await resolveModelRuntime("genbi", undefined, t0 + VERSION_TTL_MS + 1)).modelId).toBe("us.anthropic.claude-opus-4-7-v1");
  });

  it("60s 配置 TTL 到期即使版本没变也重取(兜底)", async () => {
    await putGlobalModel({ scope: "global", modelId: "m1", probe: okProbe, actor });
    const t0 = 5_000_000;
    await resolveModelRuntime("genbi", undefined, t0);
    const reads = mem.db.log.filter((l) => l.cmd === "GetCommand").length;
    await resolveModelRuntime("genbi", undefined, t0 + MODEL_CACHE_TTL_MS + 1);
    expect(mem.db.log.filter((l) => l.cmd === "GetCommand").length).toBeGreaterThan(reads);
  });

  it("readVersionCached 冷表 0", async () => {
    expect(await readVersionCached(0)).toBe(0);
    await bumpVersion();
    expect(await readVersionCached(VERSION_TTL_MS + 1)).toBe(1);
  });
});

describe("键与缓存按 targetId 定形(SPEC §6.2① / M18)", () => {
  it("deriveScope 一期恒 global(两形参真接);scopeKey 含 targetId,两个 target 不共用条目", async () => {
    expect(deriveScope("genbi", "tgt_usw2_b")).toBe("global");
    expect(scopeKeyOf("genbi")).toBe("tgt_home#genbi");
    expect(scopeKeyOf("genbi", "tgt_usw2_b")).toBe("tgt_usw2_b#genbi");
    expect(scopeKeyOf(undefined, undefined)).toBe("tgt_home#global");
    await resolveModelRuntime("genbi", "tgt_home", 1);
    await resolveModelRuntime("genbi", "tgt_usw2_b", 1);
    expect(_cacheKeysForTests().sort()).toEqual(["tgt_home#genbi", "tgt_usw2_b#genbi"]);
  });
  it("一期写入的 sk 仍是 ai-model#global(值不变、形态可扩)", async () => {
    await putGlobalModel({ scope: deriveScope("genbi", "tgt_usw2_b"), modelId: "m1", probe: okProbe, actor });
    expect(mem.db.dump("bgp-settings").map((i) => i.sk)).toContain("ai-model#global");
  });
});

describe("韧性:配置面故障绝不抛(P0-1 / SPEC §6.1② / M16)", () => {
  it("读失败且有 last-good ⇒ runtime-stale + stale:true,值为 last-good", async () => {
    await putGlobalModel({ scope: "global", modelId: "m1", probe: okProbe, actor });
    await resolveModelRuntime("genbi", undefined, 10);
    mem.db.injectError(() => Object.assign(new Error("table missing"), { name: "ResourceNotFoundException" }));
    const r = await resolveModelRuntime("genbi", undefined, 10 + MODEL_CACHE_TTL_MS + 1);
    expect(r).toEqual({ modelId: "m1", source: "runtime-stale", stale: true });
  });
  it("读失败且无 last-good ⇒ env ⇒ ssot(不 500)", async () => {
    mem.db.injectError(() => Object.assign(new Error("table missing"), { name: "ResourceNotFoundException" }));
    expect(await resolveModelRuntime("genbi")).toEqual({ modelId: DEFAULT_MODEL_ID, source: "ssot" });
    process.env.BEDROCK_MODEL_ID = "env-model.x-1";
    _resetModelCacheForTests();
    expect(await resolveModelRuntime("genbi")).toEqual({ modelId: "env-model.x-1", source: "env" });
  });
  it("resolveWithProvenance 本身会抛(供路由层区分)", async () => {
    mem.db.injectError(() => new Error("boom"));
    await expect(resolveWithProvenance("global")).rejects.toThrow("boom");
  });
});

describe("resolveLayered:有序去重候选层(SPEC §3.5)", () => {
  it("runtime → env → ssot;重复值去重", async () => {
    process.env.BEDROCK_MODEL_ID = "env.model-a";
    await putGlobalModel({ scope: "global", modelId: "rt.model-b", probe: okProbe, actor });
    const layers = await resolveLayered("genbi");
    expect(layers.map((l) => [l.modelId, l.source])).toEqual([
      ["rt.model-b", "runtime"],
      ["env.model-a", "env"],
      [DEFAULT_MODEL_ID, "ssot"],
    ]);
    process.env.BEDROCK_MODEL_ID = DEFAULT_MODEL_ID;
    _resetModelCacheForTests();
    expect((await resolveLayered("genbi")).map((l) => l.modelId)).toEqual(["rt.model-b", DEFAULT_MODEL_ID]);
  });
});

describe("isModelIdFormatValid(SPEC §2 正则 + region 钩子)", () => {
  it("接受短 id / profile id,拒 ARN / 大写 / 空", () => {
    expect(isModelIdFormatValid("global.anthropic.claude-opus-4-8")).toBe(true);
    expect(isModelIdFormatValid("us.anthropic.claude-opus-4-6-v1")).toBe(true);
    expect(isModelIdFormatValid("openai.gpt-5.6-sol")).toBe(true);
    expect(isModelIdFormatValid("anthropic.claude-opus-4-1-20250805-v1:0")).toBe(true);
    expect(isModelIdFormatValid("arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-8")).toBe(false);
    expect(isModelIdFormatValid("Anthropic.Claude")).toBe(false);
    expect(isModelIdFormatValid("")).toBe(false);
    expect(isModelIdFormatValid("us.anthropic.claude-opus-4-8", { region: "eu-west-1" })).toBe(true); // 一期钩子不判
  });
});

