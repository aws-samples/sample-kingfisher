// @kf-batch 50-W5-seg2-WP8
// invokeWithFallback 单测(51 SPEC §3.5;ACCEPTANCE M9 冷悬崖降级 / M14 回显实际值)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invokeWithFallback, invokeConverse, invokeAgent, isThrottleError, isUnavailableError, MAX_RETRY, BACKOFF_BASE_MS } from "../invoke";
import { _resetLearnedForTests } from "../core/converse-shape";
import type { ResolvedModel } from "../model";

beforeEach(() => _resetLearnedForTests());

const layers: ResolvedModel[] = [
  { modelId: "rt.model-a", source: "runtime" },
  { modelId: "env.model-b", source: "env" },
  { modelId: "ssot.model-c", source: "ssot" },
];
const err = (name: string, message = name, status?: number) => Object.assign(new Error(message), { name, ...(status ? { $metadata: { httpStatusCode: status } } : {}) });
const noSleep = { sleep: async () => {} };

describe("退避重试(同层)", () => {
  it("限流 2 次后第 3 次成功 ⇒ 同一模型、attempts=3、不降级;退避 200/400ms", async () => {
    let n = 0;
    const slept: number[] = [];
    const r = await invokeWithFallback("genbi", undefined, async (m) => {
      n++;
      if (n <= 2) throw err("ThrottlingException");
      return `ok:${m}`;
    }, { layers, sleep: async (ms) => { slept.push(ms); } });
    expect(r).toEqual({ response: "ok:rt.model-a", usedModelId: "rt.model-a", usedSource: "runtime", attempts: 3, degraded: false });
    expect(slept).toEqual([BACKOFF_BASE_MS, BACKOFF_BASE_MS * 2]);
    expect(MAX_RETRY).toBe(2);
  });
});

describe("降级回落(跨层)—— P0-4 冷悬崖唯一归宿", () => {
  it("首层持续限流 ⇒ 用尽重试后回落 env 层;usedModelId = 实际用的(M14)", async () => {
    const calls: string[] = [];
    const r = await invokeWithFallback("copilot", undefined, async (m) => {
      calls.push(m);
      if (m === "rt.model-a") throw err("ThrottlingException", "rate exceeded", 429);
      return "answer";
    }, { layers, ...noSleep });
    expect(calls).toEqual(["rt.model-a", "rt.model-a", "rt.model-a", "env.model-b"]);
    expect(r.usedModelId).toBe("env.model-b");
    expect(r.usedSource).toBe("env");
    expect(r.degraded).toBe(true);
    expect(r.attempts).toBe(4);
  });
  it("不可用类(ServiceUnavailable / ModelNotReady / ResourceNotFound)直接换层,不重试", async () => {
    const calls: string[] = [];
    const r = await invokeWithFallback("codegen", undefined, async (m) => {
      calls.push(m);
      if (m === "rt.model-a") throw err("ModelNotReadyException");
      if (m === "env.model-b") throw err("ResourceNotFoundException");
      return "c";
    }, { layers, ...noSleep });
    expect(calls).toEqual(["rt.model-a", "env.model-b", "ssot.model-c"]);
    expect(r.usedModelId).toBe("ssot.model-c");
  });
  it("最后一层仍限流 ⇒ 抛给调用方(不无限循环)", async () => {
    await expect(invokeWithFallback("genbi", undefined, async () => { throw err("ThrottlingException"); }, { layers, ...noSleep }))
      .rejects.toMatchObject({ name: "ThrottlingException" });
  });
  it("非限流类错误(ValidationException / 业务错)原样抛,不重试不降级", async () => {
    let n = 0;
    await expect(invokeWithFallback("genbi", undefined, async () => { n++; throw err("ValidationException", "bad input"); }, { layers, ...noSleep }))
      .rejects.toThrow("bad input");
    expect(n).toBe(1);
  });
  it("AbortError(300s 天花板)立即抛,不重试不降级", async () => {
    let n = 0;
    await expect(invokeWithFallback("genbi", undefined, async () => { n++; throw err("AbortError", "GENBI_ABORTED"); }, { layers, ...noSleep }))
      .rejects.toThrow("GENBI_ABORTED");
    expect(n).toBe(1);
  });
});

describe("FAULT_THROTTLE_MODEL seam(M9;运行期 env 门 + 仅非生产)", () => {
  it("armed 且命中首层 ⇒ 首层被强制限流 ⇒ 降级到下一层;run 对首层一次都不真调", async () => {
    const calls: string[] = [];
    const r = await invokeWithFallback("genbi", undefined, async (m) => { calls.push(m); return "x"; }, {
      layers, ...noSleep, env: { BGP_NONPROD_TARGET: "1", FAULT_THROTTLE_MODEL: "rt.model-a" },
    });
    expect(calls).toEqual(["env.model-b"]);
    expect(r.usedModelId).toBe("env.model-b");
    expect(r.degraded).toBe(true);
  });
  it("没有非生产标记 ⇒ 缝惰性,正常走首层", async () => {
    const r = await invokeWithFallback("genbi", undefined, async () => "x", { layers, ...noSleep, env: { FAULT_THROTTLE_MODEL: "rt.model-a" } });
    expect(r.usedModelId).toBe("rt.model-a");
    expect(r.degraded).toBe(false);
  });
});

describe("两形态薄壳", () => {
  it("invokeConverse:command 由 build(modelId) 生成并经 client.send", async () => {
    const client = { send: vi.fn(async (cmd: any) => ({ echo: cmd.input.modelId })) };
    const build = (modelId: string) => ({ input: { modelId } }) as any;
    const r = await invokeConverse("flink-sql", undefined, client as any, build, {}, { layers, ...noSleep });
    expect(r.response).toEqual({ echo: "rt.model-a" });
    expect(client.send).toHaveBeenCalledTimes(1);
  });
  it("invokeAgent:Strands ModelThrottledError 也按限流处理并降级", async () => {
    const calls: string[] = [];
    const r = await invokeAgent("copilot-planner", undefined, async (m) => {
      calls.push(m);
      if (m === "rt.model-a") throw err("ModelThrottledError", "Bedrock throttled");
      return { spec: m };
    }, { layers, ...noSleep });
    expect(calls.length).toBe(4);
    expect(r.usedModelId).toBe("env.model-b");
  });
});

// @kf-batch 51-v2-multi-vendor —— 51 SPEC §7.2 平台落点:invokeConverse 整形 + 学到字段同层重试一次
describe("D12 请求整形(invokeConverse 唯一落点)", () => {
  const KIMI = "global.moonshotai.kimi-k3";
  const CLAUDE = "us.anthropic.claude-opus-4-5-20251101-v1:0";
  const cmdOf = (modelId: string, inferenceConfig: Record<string, unknown>) => ({ input: { modelId, messages: [{ role: "user", content: [{ text: "q" }] }], inferenceConfig } }) as any;

  it("Kimi K3:send 出去的 inferenceConfig 已剥 temperature、maxTokens ×2;outcome.shaped 回显剥掉的字段", async () => {
    const seen: any[] = [];
    const client = { send: vi.fn(async (cmd: any) => { seen.push(cmd.input.inferenceConfig); return { ok: 1 }; }) };
    const r = await invokeConverse("flink-sql", undefined, client as any, (m) => cmdOf(m, { maxTokens: 1600, temperature: 0 }), {}, {
      layers: [{ modelId: KIMI, source: "runtime" }], ...noSleep,
    });
    expect(seen).toEqual([{ maxTokens: 3200 }]);
    expect(r.shaped).toEqual(["temperature"]);
    expect(r.attempts).toBe(1);
    expect(r.usedModelId).toBe(KIMI);
  });
  it("Claude:恒等 —— inferenceConfig 原样、不出现 shaped 字段", async () => {
    const seen: any[] = [];
    const client = { send: vi.fn(async (cmd: any) => { seen.push(cmd.input.inferenceConfig); return { ok: 1 }; }) };
    const r = await invokeConverse("codegen", undefined, client as any, (m) => cmdOf(m, { maxTokens: 3000, temperature: 0 }), {}, {
      layers: [{ modelId: CLAUDE, source: "ssot" }], ...noSleep,
    });
    expect(seen).toEqual([{ maxTokens: 3000, temperature: 0 }]);
    expect("shaped" in r).toBe(false);
  });
  it("🔴 档案没记的模型:Bedrock 原话「doesn't support the topP field」⇒ 学到、同层立刻重试一次(不退避、不降级、attempts=2),第二次已剥 topP", async () => {
    const seen: any[] = [];
    const slept: number[] = [];
    const client = { send: vi.fn(async (cmd: any) => {
      seen.push({ ...cmd.input.inferenceConfig });
      if (seen.length === 1) throw err("ValidationException", "This model doesn't support the topP field. Remove topP and try again.", 400);
      return { ok: 1 };
    }) };
    const r = await invokeConverse("genbi", undefined, client as any, (m) => cmdOf(m, { maxTokens: 500, topP: 0.9 }), {}, {
      layers, sleep: async (ms) => { slept.push(ms); },
    });
    expect(seen).toEqual([{ maxTokens: 500, topP: 0.9 }, { maxTokens: 500 }]);
    expect(slept).toEqual([]);
    expect(r).toMatchObject({ usedModelId: "rt.model-a", usedSource: "runtime", attempts: 2, degraded: false, shaped: ["topP"] });
  });
  it("同层只许学一次:连报两次不支持 ⇒ 第二次按非限流类原样抛,不降级到下一层", async () => {
    let n = 0;
    const client = { send: vi.fn(async () => { n++; throw err("ValidationException", "This model doesn't support the temperature field. Remove temperature and try again."); }) };
    await expect(invokeConverse("genbi", undefined, client as any, (m) => cmdOf(m, { maxTokens: 10, temperature: 0 }), {}, { layers, ...noSleep }))
      .rejects.toMatchObject({ name: "ValidationException" });
    expect(n).toBe(2);
  });
  it("别的 ValidationException(模型 id 写错)不学不重试:一次就抛", async () => {
    let n = 0;
    const client = { send: vi.fn(async () => { n++; throw err("ValidationException", "The provided model identifier is invalid."); }) };
    await expect(invokeConverse("genbi", undefined, client as any, (m) => cmdOf(m, { maxTokens: 10 }), {}, { layers, ...noSleep })).rejects.toThrow("invalid");
    expect(n).toBe(1);
  });
});

describe("错误分类器", () => {
  it("isThrottleError / isUnavailableError", () => {
    expect(isThrottleError(err("ThrottlingException"))).toBe(true);
    expect(isThrottleError(err("X", "y", 429))).toBe(true);
    expect(isThrottleError(err("ModelThrottledError"))).toBe(true);
    expect(isThrottleError(err("ValidationException"))).toBe(false);
    expect(isUnavailableError(err("ServiceUnavailableException"))).toBe(true);
    expect(isUnavailableError(err("X", "y", 503))).toBe(true);
    expect(isUnavailableError(err("AccessDeniedException"))).toBe(false);
  });
});
