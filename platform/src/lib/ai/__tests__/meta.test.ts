// `_meta` 回显契约单测(51 SPEC §3.3a)+ apiOk 兼容第三参。
import { describe, it, expect } from "vitest";
import { buildAiMeta } from "../meta";
import { apiOk } from "@/lib/api-response";

const req = (cid?: string) => ({ headers: { get: (n: string) => (n === "x-correlation-id" ? cid ?? null : null) } });

describe("buildAiMeta", () => {
  it("modelId / modelSource / correlationId 必带;correlationId 取请求头", () => {
    const m = buildAiMeta(req("cid-123"), { modelId: "m", modelSource: "runtime" });
    expect(m).toEqual({ modelId: "m", modelSource: "runtime", correlationId: "cid-123" });
  });
  it("无请求头 / 无请求 ⇒ 生成一个非空 correlationId", () => {
    expect(buildAiMeta(req(), { modelId: "m", modelSource: "ssot" }).correlationId).toBeTruthy();
    expect(buildAiMeta(null, { modelId: "m", modelSource: "ssot" }).correlationId).toBeTruthy();
  });
  it("degraded / invocations 只在有值时出现", () => {
    const m = buildAiMeta(req("c"), { modelId: "m", modelSource: "env", degraded: true }, {
      invocations: [{ capability: "genbi-retrieval", modelId: "m", modelSource: "env" }],
    });
    expect(m.degraded).toBe(true);
    expect(m.invocations).toHaveLength(1);
    expect(buildAiMeta(req("c"), { modelId: "m", modelSource: "env" }, { invocations: [] })).not.toHaveProperty("invocations");
  });
});

describe("apiOk 兼容第三参", () => {
  it("两参调用信封逐字节不变;三参加 _meta", async () => {
    expect(await apiOk({ a: 1 }).json()).toEqual({ success: true, data: { a: 1 } });
    expect(await apiOk({ a: 1 }, 201).json()).toEqual({ success: true, data: { a: 1 } });
    const res = apiOk({ a: 1 }, 200, { modelId: "m", modelSource: "runtime", correlationId: "c" });
    expect(await res.json()).toEqual({ success: true, data: { a: 1 }, _meta: { modelId: "m", modelSource: "runtime", correlationId: "c" } });
  });
});
