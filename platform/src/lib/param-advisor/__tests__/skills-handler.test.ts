// 技能 Lambda 单测 — mock history-probe(隔离 AWS),真实 heuristics/catalog。
// 覆盖:工具名解析、request 校验、两工具分发、workloadOverride 合并、错误封装、未知工具。
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HistoryFacts } from "../types";

const probeMock = vi.fn<() => Promise<HistoryFacts>>();
vi.mock("../history-probe", () => ({
  probeHistory: (jobRef: unknown) => probeMock(jobRef as never),
}));

import { handler, toolNameOf } from "../skills-handler";

const ctxOf = (tool: string) => ({ clientContext: { Custom: { bedrockAgentCoreToolName: tool } } });
const noHistory: HistoryFacts = { kind: "none", degraded: false, missing: [], capturedAt: "2026-07-01T00:00:00Z" };

beforeEach(() => {
  probeMock.mockReset();
  probeMock.mockResolvedValue(noHistory);
});

describe("toolNameOf", () => {
  it("按 ___ 取末段(Gateway 契约 <target>___<tool>)", () => {
    expect(toolNameOf(ctxOf("paramadvisorskills___recommend_parameters"))).toBe("recommend_parameters");
    expect(toolNameOf(ctxOf("recommend_parameters"))).toBe("recommend_parameters");
    expect(toolNameOf(undefined)).toBe("");
  });
  it("兼容小写 custom", () => {
    expect(toolNameOf({ clientContext: { custom: { bedrockAgentCoreToolName: "t___x" } } })).toBe("x");
  });
});

describe("handler 校验与分发", () => {
  it("缺 request → error", async () => {
    const r = await handler({}, ctxOf("recommend_parameters"));
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain("request");
  });
  it("未知 channel → error", async () => {
    const r = await handler({ request: { channel: "spark" as never } }, ctxOf("recommend_parameters"));
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain("未知参数通道");
  });
  it("未知工具 → error", async () => {
    const r = await handler({ request: { channel: "flink" } }, ctxOf("no_such_tool"));
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain("unknown tool");
  });

  it("recommend_parameters:出推荐清单 + prefill + confidence", async () => {
    const r = await handler(
      { request: { channel: "flink", workload: { kinesisShards: 4 } } },
      ctxOf("paramadvisorskills___recommend_parameters")
    );
    expect(r.success).toBe(true);
    const recs = r.recommendations as { key: string; value: unknown }[];
    expect(recs.find((x) => x.key === "parallelism")?.value).toBe(4);
    expect(r.prefill).toMatchObject({ channel: "flink", parallelism: 4 });
    expect(r.confidence).toBeGreaterThan(0);
    expect(probeMock).toHaveBeenCalledOnce();
  });

  it("workloadOverride 合并进 workload(模型抽取的特征生效)", async () => {
    const r = await handler(
      {
        request: { channel: "glue-etl", workload: { estimatedDataGB: 10 } },
        workloadOverride: { estimatedDataGB: 400 }, // 用户在对话中更正为 400GB
      },
      ctxOf("recommend_parameters")
    );
    expect(r.success).toBe(true);
    const recs = r.recommendations as { key: string; value: unknown }[];
    expect(recs.find((x) => x.key === "glueConfig.workerType")?.value).toBe("G.2X"); // 400GB 档位
  });

  it("有 jobRef 时把历史传给引擎(P90 超时生效)", async () => {
    probeMock.mockResolvedValue({
      kind: "glue-job", degraded: false, missing: [], capturedAt: "2026-07-01T00:00:00Z",
      glue: { runs: 10, successRate: 1, avgDurationMin: 30, p90DurationMin: 40, maxDurationMin: 50, lastErrors: [] },
    });
    const r = await handler(
      { request: { channel: "glue-etl", workload: { estimatedDataGB: 50 }, jobRef: { kind: "glue-job", id: "bgp-etl-x" } } },
      ctxOf("recommend_parameters")
    );
    const recs = r.recommendations as { key: string; value: unknown; basedOnHistory?: boolean }[];
    const t = recs.find((x) => x.key === "glueConfig.timeoutMinutes");
    expect(t?.value).toBe(60); // P90 40×1.5
    expect(t?.basedOnHistory).toBe(true);
  });

  it("inspect_job_history:jobRef 入参优先,缺失回落 request.jobRef,都无 → error", async () => {
    probeMock.mockResolvedValue({ kind: "glue-job", degraded: false, missing: [], capturedAt: "t", glue: { runs: 5, successRate: 1, avgDurationMin: 3, p90DurationMin: 4, maxDurationMin: 5, lastErrors: [] } });
    const r1 = await handler(
      { request: { channel: "glue-etl" }, jobRef: { kind: "glue-job", id: "job-a" } },
      ctxOf("inspect_job_history")
    );
    expect(r1.success).toBe(true);
    expect(probeMock).toHaveBeenLastCalledWith({ kind: "glue-job", id: "job-a" });

    const r2 = await handler(
      { request: { channel: "glue-etl", jobRef: { kind: "glue-job", id: "job-b" } } },
      ctxOf("inspect_job_history")
    );
    expect(r2.success).toBe(true);
    expect(probeMock).toHaveBeenLastCalledWith({ kind: "glue-job", id: "job-b" });

    const r3 = await handler({ request: { channel: "glue-etl" } }, ctxOf("inspect_job_history"));
    expect(r3.success).toBe(false);
  });

  it("inspect_job_history 探测降级 → error 带 missing 原因", async () => {
    probeMock.mockResolvedValue({ kind: "glue-job", degraded: true, missing: ["glue:GetJobRuns denied"], capturedAt: "t" });
    const r = await handler(
      { request: { channel: "glue-etl", jobRef: { kind: "glue-job", id: "job-x" } } },
      ctxOf("inspect_job_history")
    );
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain("denied");
  });

  it("引擎/探测抛错 → 封装为 {success:false},不裸抛", async () => {
    probeMock.mockRejectedValue(new Error("throttled"));
    const r = await handler(
      { request: { channel: "glue-etl", jobRef: { kind: "glue-job", id: "x" } } },
      ctxOf("recommend_parameters")
    );
    // probeHistory 内部本会兜错,这里模拟外层意外异常路径:handler 不裸抛。
    expect(r.success).toBe(false);
  });
});
