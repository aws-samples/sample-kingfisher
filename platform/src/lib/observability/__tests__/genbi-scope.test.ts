// 可观测看板按区。🔴 这条判据同时钉住**写侧**:历史行必须带 `targetId`,
// 否则读侧再怎么过滤都只会得到「全都在主控区」——那正是这一刀之前的状态。
import { describe, it, expect, vi } from "vitest";

let history: Array<Record<string, unknown>> = [];
vi.mock("@/lib/genbi/history", () => ({ scanGenBiHistory: vi.fn(async () => history) }));
vi.mock("@aws-sdk/client-bedrock-agentcore-control", () => ({
  BedrockAgentCoreControlClient: class { async send() { throw new Error("no aws in test"); } },
  ListAgentRuntimesCommand: class {},
  ListGatewaysCommand: class {},
  ListGatewayTargetsCommand: class {},
}));
vi.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: class { async send() { throw new Error("no aws in test"); } },
  GetMetricStatisticsCommand: class {},
  ListMetricsCommand: class {},
}));
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class { async send() { throw new Error("no aws in test"); } },
  GetFunctionCommand: class {},
}));

import { getGenBiObservability } from "../genbi";

const rows = () => [
  { historyId: "h1", targetId: "tgt_home", question: "q", createdAt: "2026-09-10T00:00:00Z" },
  { historyId: "h2", targetId: "tgt_usw2_a", question: "q", createdAt: "2026-09-10T00:00:00Z" },
  { historyId: "h3", question: "q", createdAt: "2026-09-10T00:00:00Z" }, // 存量无章 ⇒ 主控区
];

describe("按区过滤", () => {
  it("不传 scope = 全部(回滚点)", async () => {
    history = rows();
    const d = await getGenBiObservability();
    expect(d.genbi.total).toBe(3);
  });
  it("主控区视角含存量无章的行", async () => {
    history = rows();
    const d = await getGenBiObservability({ scope: { kind: "target", targetId: "tgt_home" } });
    expect(d.genbi.total).toBe(2);
  });
  it("🔴 非主控区只算真在那儿跑过的(历史行没有 targetId 时这里恒为 0 —— 那说明写侧漏了章)", async () => {
    history = rows();
    const d = await getGenBiObservability({ scope: { kind: "target", targetId: "tgt_usw2_a" } });
    expect(d.genbi.total).toBe(1);
  });
});
