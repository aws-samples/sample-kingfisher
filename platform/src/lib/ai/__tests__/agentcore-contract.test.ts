// @kf-batch 50-W5-seg2-WP8
// AgentCore 回执校验单测(51 SPEC §6.1⑤;ACCEPTANCE M17 单测面)。
import { describe, it, expect, beforeEach } from "vitest";
import { assertAgentCoreModelMeta, AgentCoreModelMismatch, agentCoreEchoedModelId, getAgentCoreMetaStatus, _resetAgentCoreContractForTests, currentReleaseId } from "../agentcore-contract";

beforeEach(() => _resetAgentCoreContractForTests());

describe("assertAgentCoreModelMeta", () => {
  it("回执 _meta.modelId == 期望 ⇒ 通过并记 lastOk", () => {
    expect(assertAgentCoreModelMeta({ answer: "x", _meta: { modelId: "m1" } }, "m1", "genbi", 5)).toBe("m1");
    expect(getAgentCoreMetaStatus().lastOk).toEqual({ at: 5, capability: "genbi", modelId: "m1" });
    expect(getAgentCoreMetaStatus().lastMismatch).toBeNull();
  });
  it("缺 _meta ⇒ 抛 AgentCoreModelMismatch(actual=null)并记 lastMismatch(老镜像未透传)", () => {
    expect(() => assertAgentCoreModelMeta({ answer: "x" }, "m1", "genbi", 7)).toThrow(AgentCoreModelMismatch);
    expect(getAgentCoreMetaStatus().lastMismatch).toEqual({ at: 7, capability: "genbi", expected: "m1", actual: null });
  });
  it("不等 ⇒ 抛,消息含两个 modelId", () => {
    let err: unknown;
    try {
      assertAgentCoreModelMeta({ _meta: { modelId: "old" } }, "new", "net-advisor");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AgentCoreModelMismatch);
    expect((err as Error).message).toContain("old");
    expect((err as Error).message).toContain("new");
    expect((err as AgentCoreModelMismatch).actual).toBe("old");
  });
  it("空串 / 非字符串 modelId 视为缺失", () => {
    expect(agentCoreEchoedModelId({ _meta: { modelId: "" } })).toBeNull();
    expect(agentCoreEchoedModelId({ _meta: { modelId: 42 } })).toBeNull();
    expect(agentCoreEchoedModelId(null)).toBeNull();
  });
  it("releaseId 缺省 unknown,可由 BGP_RELEASE_ID 注入", () => {
    expect(currentReleaseId({})).toBe("unknown");
    expect(currentReleaseId({ BGP_RELEASE_ID: "r-1" })).toBe("r-1");
  });
});
