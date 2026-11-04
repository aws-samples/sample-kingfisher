// 探测器单测(51 SPEC §3.2;INTERACTION 场景二四类;零真 invoke —— deps.send 全是假客户端)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const mem = vi.hoisted(() => ({ db: null as unknown as import("@/lib/settings/__tests__/mem-ddb").MemDdb }));
vi.mock("@/lib/aws/dynamodb", async () => {
  const { createMemDdb } = await import("@/lib/settings/__tests__/mem-ddb");
  mem.db = createMemDdb({ "bgp-settings": ["pk", "sk"], "bgp-audit": ["pk", "ts"] });
  return { TABLES: { SETTINGS: "bgp-settings", AUDIT: "bgp-audit" }, docClient: { send: (cmd: any) => mem.db.send(cmd) } };
});

import { probeModel, classifyProbeError, PROBE_MAX_TOKENS, PROBE_TIMEOUT_MS, PROBE_FRESH_MS, probeTimeoutMsFor, freshProbeFromCache } from "../probe";
import { VENDORS } from "../core/vendors";
import { getProbe } from "@/lib/settings/model-store";

const err = (name: string, message: string, status?: number) => Object.assign(new Error(message), { name, ...(status ? { $metadata: { httpStatusCode: status } } : {}) });

beforeEach(() => mem.db.reset());

// 落点必填(原来缺省 = process.env.AWS_REGION + tgt_home)
const HOME_PLACE = { targetId: "tgt_home", region: "us-east-1" };

describe("classifyProbeError:五类且顺序正确", () => {
  // 2026-10-14 临时账号真实原话(zai.glm-5.3,三种 id 形态同报;本体是 AccessDeniedException 且含 "not available")
  it("🔴 NotAvailableForAccount 先于 AccessDenied / NotFound(账号级未开放,处方不同)", () => {
    expect(classifyProbeError(err("AccessDeniedException", "zai.glm-5.3 is not available for this account. Contact AWS Sales for access."))).toBe("NotAvailableForAccount");
    expect(classifyProbeError(err("SomeError", "Model is not available for this account"))).toBe("NotAvailableForAccount");
  });
  it("Marketplace / SCP 先于 AccessDenied(报错本体也是 AccessDeniedException)", () => {
    expect(classifyProbeError(err("AccessDeniedException", "You don't have access to the model. Marketplace subscription required"))).toBe("MarketplaceSCP");
    expect(classifyProbeError(err("AccessDeniedException", "explicit deny in a service control policy"))).toBe("MarketplaceSCP");
    expect(classifyProbeError(err("AccessDeniedException", "User is not authorized to perform bedrock:InvokeModel"))).toBe("AccessDenied");
  });
  it("NotFound:ResourceNotFound / Validation / not available", () => {
    expect(classifyProbeError(err("ResourceNotFoundException", "Could not resolve the foundation model"))).toBe("NotFound");
    expect(classifyProbeError(err("ValidationException", "The provided model identifier is invalid"))).toBe("NotFound");
    expect(classifyProbeError(err("SomeError", "The model is not available in this region"))).toBe("NotFound");
    expect(classifyProbeError(err("ValidationException", "Invocation of model ID zai.glm-5.3 with on-demand throughput isn't supported. Retry with an inference profile"))).toBe("NotFound");
  });
  it("Throttle:Throttling / ServiceUnavailable / 429(超时**不再**归这里)", () => {
    expect(classifyProbeError(err("ThrottlingException", "Too many requests"))).toBe("Throttle");
    expect(classifyProbeError(err("ServiceUnavailableException", "x"))).toBe("Throttle");
    expect(classifyProbeError(err("X", "y", 429))).toBe("Throttle");
  });
  // 预算内没等到 = Timeout,处方「稍候再测 / 换推理配置」,不是限流
  it("🔴 Timeout 单列:AbortSignal.timeout 的 TimeoutError / AbortError、SDK 的 timed out 都归 Timeout,先于 Throttle", () => {
    expect(classifyProbeError(err("TimeoutError", "The operation was aborted due to timeout"))).toBe("Timeout");
    expect(classifyProbeError(err("AbortError", "This operation was aborted"))).toBe("Timeout");
    expect(classifyProbeError(err("SomeError", "Request timed out after 10000ms"))).toBe("Timeout");
    expect(classifyProbeError(err("ThrottlingException", "Too many requests"))).toBe("Throttle");
  });
});

describe("probeModel", () => {
  it("tiny invoke:maxTokens=PROBE_MAX_TOKENS(24,给 Kimi 的推理块留位)、user ping;成功 ⇒ ok:true、anthropic toolUseOk:true、quotaHint unknown;写缓存带 targetId", async () => {
    const sent: any[] = [];
    const send = vi.fn(async (cmd: any) => {
      sent.push(cmd.input);
      return { output: { message: { role: "assistant", content: [{ text: "pong" }] } }, stopReason: "end_turn" } as any;
    });
    const r = await probeModel("global.anthropic.claude-opus-4-8", { place: { targetId: "tgt_usw2_b", region: "us-west-2" }, deps: { send, now: () => 4242 } });
    expect(r).toEqual({ ok: true, toolUseOk: true, quotaHint: "unknown", probedAt: 4242, elapsedMs: 0 }); // now 固定 ⇒ 墙钟 0
    expect(send).toHaveBeenCalledTimes(1); // anthropic 不探 tool-use
    expect(sent[0].modelId).toBe("global.anthropic.claude-opus-4-8");
    expect(sent[0].inferenceConfig.maxTokens).toBe(PROBE_MAX_TOKENS);
    expect(PROBE_MAX_TOKENS).toBe(24);
    const cached = await getProbe("tgt_usw2_b", "global.anthropic.claude-opus-4-8");
    expect(cached?.probeOk).toBe(true);
    expect(cached?.probedAt).toBe(4242);
    expect(await getProbe("tgt_home", "global.anthropic.claude-opus-4-8")).toBeNull(); // 另一 target 不共用
  });

  it("openai 系列再探 tool-use:有 toolUse 块 ⇒ toolUseOk:true;无 ⇒ false(不影响 ok)", async () => {
    const sendOk = vi.fn(async (cmd: any) =>
      cmd.input.toolConfig
        ? ({ stopReason: "tool_use", output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "t", name: "ping_tool", input: { text: "pong" } } }] } } } as any)
        : ({ stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: "hi" }] } } } as any)
    );
    const r1 = await probeModel("openai.gpt-5.6-sol", { place: HOME_PLACE, deps: { send: sendOk, persist: false } });
    expect(r1.ok).toBe(true);
    expect(r1.toolUseOk).toBe(true);
    expect(sendOk).toHaveBeenCalledTimes(2);

    const sendNoTool = vi.fn(async (cmd: any) => {
      if (cmd.input.toolConfig) throw err("ValidationException", "tools are not supported for this model");
      return { stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: "hi" }] } } } as any;
    });
    const r2 = await probeModel("openai.gpt-5.6-sol", { place: HOME_PLACE, deps: { send: sendNoTool, persist: false } });
    expect(r2.ok).toBe(true);
    expect(r2.toolUseOk).toBe(false);
  });

  // D11:二探看厂商档案 toolUse:"probe",不再只盯 openai
  it("zai / moonshotai 系列也二探 tool-use;Kimi 的 ping 请求经整形(只有 maxTokens 且按系数 ×2)", async () => {
    const sent: any[] = [];
    const sendOk = vi.fn(async (cmd: any) => {
      sent.push(cmd.input);
      return cmd.input.toolConfig
        ? ({ stopReason: "tool_use", output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "t", name: "ping_tool", input: { text: "pong" } } }] } } } as any)
        : ({ stopReason: "end_turn", output: { message: { role: "assistant", content: [{ reasoningContent: { reasoningText: { text: "…" } } }, { text: "pong" }] } } } as any);
    });
    const kimi = await probeModel("global.moonshotai.kimi-k3", { place: HOME_PLACE, deps: { send: sendOk, persist: false } });
    expect(kimi).toMatchObject({ ok: true, toolUseOk: true });
    expect(sendOk).toHaveBeenCalledTimes(2);
    expect(sent[0].inferenceConfig).toEqual({ maxTokens: PROBE_MAX_TOKENS * 2 }); // 探测与真调用同一条路:Kimi 档案系数 ×2 也吃到(24 → 48)
    expect(sent[1].toolConfig.toolChoice).toEqual({ any: {} });

    const sendNoTool = vi.fn(async (cmd: any) => {
      if (cmd.input.toolConfig) throw err("ValidationException", "This model doesn't support tool use");
      return { stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: "hi" }] } } } as any;
    });
    const glm = await probeModel("us.zai.glm-5.3", { place: HOME_PLACE, deps: { send: sendNoTool, persist: false } });
    expect(glm.ok).toBe(true);
    expect(glm.toolUseOk).toBe(false);
    expect(sendNoTool).toHaveBeenCalledTimes(2);
  });

  it("账号级未开放 ⇒ ok:false + NotAvailableForAccount(真实原话),缓存记失败", async () => {
    const send = vi.fn(async () => { throw err("AccessDeniedException", "zai.glm-5.3 is not available for this account. Contact AWS Sales for access.", 403); });
    const r = await probeModel("us.zai.glm-5.3", { place: HOME_PLACE, deps: { send, now: () => 9 } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("NotAvailableForAccount");
    expect((await getProbe("tgt_home", "us.zai.glm-5.3"))?.probeError).toBe("NotAvailableForAccount");
  });

  it("失败 ⇒ ok:false + 分类 + errorDetail;缓存记失败(catalog 的 available=false)", async () => {
    const send = vi.fn(async () => { throw err("AccessDeniedException", "Marketplace subscription is required"); });
    const r = await probeModel("us.anthropic.claude-opus-4-8", { place: HOME_PLACE, deps: { send, now: () => 7 } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("MarketplaceSCP");
    expect(r.errorDetail).toContain("Marketplace");
    const cached = await getProbe("tgt_home", "us.anthropic.claude-opus-4-8");
    expect(cached?.probeOk).toBe(false);
    expect(cached?.probeError).toBe("MarketplaceSCP");
  });

  it("store 坏了不影响探测结论(putProbe 静默跳过)", async () => {
    mem.db.injectError(() => err("ResourceNotFoundException", "table missing"));
    const send = vi.fn(async () => ({ stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: "ok" }] } } } as any));
    const r = await probeModel("global.anthropic.claude-opus-4-8", { place: HOME_PLACE, deps: { send } });
    expect(r.ok).toBe(true);
  });
});

// (2026-10-20 临时账号真测:Kimi K3 tiny / tool-use 探测 8 次采样 3.0–39.4s,10s 预算 5 次超时)
describe("探测预算按系列 + 两探并行 + 二探失败分类 + 保存认新鲜缓存", () => {
  it("probeTimeoutMsFor:Kimi K3 用档案的 45s,Claude 10s,无档案 id 用保底 PROBE_TIMEOUT_MS", () => {
    expect(probeTimeoutMsFor("us.moonshotai.kimi-k3")).toBe(VENDORS.moonshotai.probeTimeoutMs);
    expect(probeTimeoutMsFor("us.moonshotai.kimi-k3")).toBeGreaterThanOrEqual(40_000);
    expect(probeTimeoutMsFor("global.anthropic.claude-opus-4-8")).toBe(10_000);
    expect(probeTimeoutMsFor("amazon.nova-pro-v1:0")).toBe(PROBE_TIMEOUT_MS);
  });

  it("🔴 两探并行:tool-use 探测在 tiny invoke 返回**之前**就已发出(墙钟 ≈ max,不是和)", async () => {
    const order: string[] = [];
    let releaseTiny!: () => void;
    const tinyGate = new Promise<void>((res) => { releaseTiny = res; });
    const send = vi.fn(async (cmd: any) => {
      if (cmd.input.toolConfig) {
        order.push("tool-sent");
        return { stopReason: "tool_use", output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "t", name: "ping_tool", input: { text: "pong" } } }] } } } as any;
      }
      order.push("tiny-sent");
      await tinyGate;
      order.push("tiny-done");
      return { stopReason: "end_turn", output: { message: { role: "assistant", content: [{ reasoningContent: { reasoningText: { text: "…" } } }] } } } as any;
    });
    const p = probeModel("us.moonshotai.kimi-k3", { place: HOME_PLACE, deps: { send, persist: false } });
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(["tiny-sent", "tool-sent"]); // tiny 还没回,二探已经发出
    releaseTiny();
    const r = await p;
    expect(r).toMatchObject({ ok: true, toolUseOk: true });
    expect(typeof r.elapsedMs).toBe("number");
  });

  it("二探超时 ⇒ ok:true + toolUseOk:false + toolUseError:Timeout(不是「不支持工具」);二探 ValidationException ⇒ toolUseError:NotFound", async () => {
    const sendTimeout = vi.fn(async (cmd: any) => {
      if (cmd.input.toolConfig) throw err("TimeoutError", "The operation was aborted due to timeout");
      return { stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: "pong" }] } } } as any;
    });
    const r1 = await probeModel("us.moonshotai.kimi-k3", { place: HOME_PLACE, deps: { send: sendTimeout, persist: false } });
    expect(r1).toMatchObject({ ok: true, toolUseOk: false, toolUseError: "Timeout" });
    const sendNoTool = vi.fn(async (cmd: any) => {
      if (cmd.input.toolConfig) throw err("ValidationException", "This model doesn't support tool use");
      return { stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: "pong" }] } } } as any;
    });
    const r2 = await probeModel("us.moonshotai.kimi-k3", { place: HOME_PLACE, deps: { send: sendNoTool, persist: false } });
    expect(r2).toMatchObject({ ok: true, toolUseOk: false, toolUseError: "NotFound" });
  });

  it("tiny 超时 ⇒ ok:false + error:Timeout(缓存记 Timeout;原来记成 Throttle 让页面说「被限流」)", async () => {
    const send = vi.fn(async (cmd: any) => {
      if (cmd.input.toolConfig) return { stopReason: "tool_use", output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "t", name: "ping_tool", input: {} } }] } } } as any;
      throw err("TimeoutError", "The operation was aborted due to timeout");
    });
    const r = await probeModel("us.moonshotai.kimi-k3", { place: HOME_PLACE, deps: { send, now: () => 77 } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Timeout");
    expect((await getProbe("tgt_home", "us.moonshotai.kimi-k3"))?.probeError).toBe("Timeout");
  });

  it("freshProbeFromCache:同 id、probeOk、10 分钟内、(要探的系列)toolUseOk ⇒ ProbeOk;过期 / 失败 / 别的 id / Kimi 缺 toolUseOk ⇒ null", () => {
    const now = 1_000_000_000;
    const base = { pk: "settings", sk: "ai-model#probe#tgt_home#us.moonshotai.kimi-k3", targetId: "tgt_home", modelId: "us.moonshotai.kimi-k3", probeOk: true, probedAt: now - 60_000, toolUseOk: true, quotaHint: "unknown" } as any;
    expect(freshProbeFromCache(base, "us.moonshotai.kimi-k3", now)).toEqual({ ok: true, toolUseOk: true, quotaHint: "unknown", probedAt: now - 60_000 });
    expect(freshProbeFromCache({ ...base, probedAt: now - PROBE_FRESH_MS - 1 }, "us.moonshotai.kimi-k3", now)).toBeNull();
    expect(freshProbeFromCache({ ...base, probeOk: false }, "us.moonshotai.kimi-k3", now)).toBeNull();
    expect(freshProbeFromCache(base, "global.moonshotai.kimi-k3", now)).toBeNull();
    expect(freshProbeFromCache({ ...base, toolUseOk: false }, "us.moonshotai.kimi-k3", now)).toBeNull();
    expect(freshProbeFromCache({ ...base, toolUseOk: undefined }, "us.moonshotai.kimi-k3", now)).toBeNull();
    // Claude(档案 assumed)不看 toolUseOk
    const claude = { ...base, modelId: "global.anthropic.claude-opus-4-8", toolUseOk: undefined };
    expect(freshProbeFromCache(claude, "global.anthropic.claude-opus-4-8", now)).toMatchObject({ ok: true, toolUseOk: true });
    expect(freshProbeFromCache(null, "us.moonshotai.kimi-k3", now)).toBeNull();
    expect(PROBE_FRESH_MS).toBe(10 * 60_000);
  });
});
