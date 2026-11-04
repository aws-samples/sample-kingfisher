// 回退兜底单测(标准 §7② + §10.4)——验证 advise() 的双层 try:
//   ① PARAMADVISOR_BACKEND=agentcore 且 Runtime 调用成功 → backend="agentcore",直用容器结构化结果。
//   ② Runtime 调用抛错 → 自动回退进程内,backend="inprocess",仍出确定性推荐。
//   ③ 进程内 Converse 也失败 → llmAvailable:false,推荐仍来自确定性引擎(双重兜底)。
//   ④ 未启用 agentcore → 直接进程内,不碰 Runtime。
// 策略:mock agentcore-client(隔离 Runtime)+ bedrock-runtime(隔离 Converse)+ history-probe(隔离 AWS)。
// 推荐引擎用真实纯函数,端到端验证组装骨架。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HistoryFacts, ParamAdviceRequest } from "../types";

// ── mock agentcore-client ──
const invokeMock = vi.fn();
const configuredMock = vi.fn(() => true);
vi.mock("../agentcore-client", () => ({
  isAgentCoreConfigured: () => configuredMock(),
  invokeParamAdvisorAgent: (sid: string, input: unknown) => invokeMock(sid, input),
}));

// ── mock history-probe ──
const probeMock = vi.fn<() => Promise<HistoryFacts>>();
vi.mock("../history-probe", () => ({
  probeHistory: () => probeMock(),
}));

// ── mock Bedrock Converse(进程内解释环)──
const converseMock = vi.fn();
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: class { send(cmd: unknown) { return converseMock(cmd); } },
  ConverseCommand: class { constructor(public input: unknown) {} },
}));

import { advise, recommendOnly } from "../index";

const noHistory: HistoryFacts = { kind: "none", degraded: false, missing: [], capturedAt: "2026-07-01T00:00:00Z" };
const req: ParamAdviceRequest = { channel: "flink", workload: { kinesisShards: 4 } };

const OLD_ENV = process.env.PARAMADVISOR_BACKEND;
beforeEach(() => {
  invokeMock.mockReset();
  probeMock.mockReset();
  converseMock.mockReset();
  configuredMock.mockReturnValue(true);
  probeMock.mockResolvedValue(noHistory);
  converseMock.mockResolvedValue({
    output: { message: { content: [{ text: "模型解释文本" }] } },
    usage: { inputTokens: 10, outputTokens: 20 },
  });
});
afterEach(() => { process.env.PARAMADVISOR_BACKEND = OLD_ENV; });

describe("advise() 后端开关 + 回退兜底", () => {
  it("agentcore 成功 → backend=agentcore,直用容器结构化结果", async () => {
    process.env.PARAMADVISOR_BACKEND = "agentcore";
    invokeMock.mockResolvedValue({
      reasoning: "容器给的解释",
      recommendations: [{ key: "parallelism", label: "作业并行度", value: 4, reason: "shard 1:1", confidence: 0.85, changed: false }],
      prefill: { channel: "flink", parallelism: 4, parallelismPerKPU: 2, autoScalingEnabled: false },
      questions: [],
      historyFacts: null,
      confidence: 0.8,
      llmAvailable: true,
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    const rec = await advise(req, [], { conversationId: "c1" });
    expect(rec.backend).toBe("agentcore");
    expect(rec.reasoning).toBe("容器给的解释");
    expect(rec.prefill).toMatchObject({ channel: "flink", parallelism: 4 });
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(converseMock).not.toHaveBeenCalled(); // 未走进程内
  });

  it("agentcore 抛错 → 自动回退进程内,backend=inprocess,仍出确定性推荐", async () => {
    process.env.PARAMADVISOR_BACKEND = "agentcore";
    invokeMock.mockRejectedValue(new Error("Runtime 冷启动超时"));
    const rec = await advise(req, [], { conversationId: "c1" });
    expect(rec.backend).toBe("inprocess"); // 铁证:回退后如实标 inprocess
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(converseMock).toHaveBeenCalledOnce(); // 确实走了进程内
    expect(rec.recommendations.find((x) => x.key === "parallelism")?.value).toBe(4); // 引擎真实推荐
    expect(rec.reasoning).toBe("模型解释文本");
    expect(rec.llmAvailable).toBe(true);
  });

  it("进程内 Converse 也失败 → llmAvailable:false,确定性文本兜底(双重兜底)", async () => {
    process.env.PARAMADVISOR_BACKEND = "agentcore";
    invokeMock.mockRejectedValue(new Error("Runtime down"));
    converseMock.mockRejectedValue(new Error("Bedrock throttled"));
    const rec = await advise(req, []);
    expect(rec.backend).toBe("inprocess");
    expect(rec.llmAvailable).toBe(false); // 诚实标记降级
    expect(rec.recommendations.length).toBeGreaterThan(0); // 推荐仍来自确定性引擎
    expect(rec.reasoning).toContain("作业并行度"); // 确定性文本
  });

  it("未启用 agentcore(默认) → 直接进程内,不碰 Runtime", async () => {
    process.env.PARAMADVISOR_BACKEND = "inprocess";
    const rec = await advise(req, []);
    expect(rec.backend).toBe("inprocess");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("agentcore 已配但 RUNTIME_ARN 未配 → 走进程内", async () => {
    process.env.PARAMADVISOR_BACKEND = "agentcore";
    configuredMock.mockReturnValue(false);
    const rec = await advise(req, []);
    expect(rec.backend).toBe("inprocess");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("recommendOnly() 快路径", () => {
  it("零大模型:不碰 Converse/Runtime,出确定性推荐", async () => {
    const rec = await recommendOnly(req);
    expect(rec.llmAvailable).toBe(false);
    expect(rec.recommendations.find((x) => x.key === "parallelism")?.value).toBe(4);
    expect(converseMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });
  it("探测失败 → degraded 历史,推荐仍可用", async () => {
    probeMock.mockRejectedValue(new Error("denied"));
    const rec = await recommendOnly(req);
    expect(rec.historyFacts?.degraded).toBe(true);
    expect(rec.recommendations.length).toBeGreaterThan(0);
  });
});
