// @kf-batch 50-W5-seg2-WP8
// GPT 传输门控单测(51 SPEC §3.4 补强①–④;ACCEPTANCE M13 / M13a 的单测面)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const mem = vi.hoisted(() => ({ db: null as unknown as import("@/lib/settings/__tests__/mem-ddb").MemDdb }));
vi.mock("@/lib/aws/dynamodb", async () => {
  const { createMemDdb } = await import("@/lib/settings/__tests__/mem-ddb");
  mem.db = createMemDdb({ "bgp-settings": ["pk", "sk"], "bgp-audit": ["pk", "ts"] });
  return { TABLES: { SETTINGS: "bgp-settings", AUDIT: "bgp-audit" }, docClient: { send: (cmd: any) => mem.db.send(cmd) } };
});

import { gptTransportReady, readTransportGate, transportItemReady, _resetTransportCacheForTests, TRANSPORT_EVIDENCE_MAX_AGE_MS } from "../transport-gate";
import { putTransport } from "@/lib/settings/model-store";

const actor = { actor: "admin" };
beforeEach(() => {
  mem.db.reset();
  _resetTransportCacheForTests();
});

describe("gptTransportReady():本波恒 false(M13a 相位)", () => {
  it("即使 __transport 已写 gptReady:true 且证据新鲜,硬闸仍 false", async () => {
    await putTransport({ gptReady: true, branch: "A", decidedAt: Date.now(), decidedBy: "admin", probeModelId: "openai.gpt-5.6-sol", probedAt: Date.now() }, actor);
    expect(await gptTransportReady()).toBe(false);
    // 同一份数据用真实现读是 true —— 证明「恒 false」不是因为数据没到位,而是门故意关着。
    expect(await readTransportGate()).toBe(true);
  });
});

describe("readTransportGate():真实现,fail-closed", () => {
  it("无项 ⇒ false;gptReady:false ⇒ false", async () => {
    expect(await readTransportGate()).toBe(false);
    _resetTransportCacheForTests();
    await putTransport({ gptReady: false, branch: null, decidedAt: 1, decidedBy: "a" }, actor);
    expect(await readTransportGate()).toBe(false);
  });
  it("证据 >24h ⇒ 失效(补强④)", () => {
    const now = 10_000_000_000;
    expect(transportItemReady({ pk: "system", sk: "x", gptReady: true, branch: "A", decidedAt: now, decidedBy: "a", probeModelId: "m", probedAt: now - TRANSPORT_EVIDENCE_MAX_AGE_MS - 1 }, now)).toBe(false);
    expect(transportItemReady({ pk: "system", sk: "x", gptReady: true, branch: "A", decidedAt: now, decidedBy: "a", probeModelId: "m", probedAt: now - 1000 }, now)).toBe(true);
    expect(transportItemReady({ pk: "system", sk: "x", gptReady: true, branch: "A", decidedAt: now, decidedBy: "a" }, now)).toBe(false); // 无证据
  });
  it("🔴 store 抛 ⇒ false(绝不 fail-open)", async () => {
    mem.db.injectError(() => Object.assign(new Error("table missing"), { name: "ResourceNotFoundException" }));
    expect(await readTransportGate()).toBe(false);
  });
});
