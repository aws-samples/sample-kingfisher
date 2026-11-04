// @kf-batch 50-W5-seg2-WP8
// 🔴 结构门(51 ACCEPTANCE M6-②):agentcore 后端下 genbi 的检索重排腿也必须可观测 ——
//   容器只给检索用的 model client 每次真发 Converse 都回报 ⇒ 回执 `_meta.invocations[]` 带 genbi-retrieval;
//   平台 client 合并这一腿并**逐条**做回执校验(子调用换了模型与主调用不等是同一类接线故障);execute.ts 的 agentcore 分支并进 `_meta.invocations[]`。
// 真环境 p51 M6-② 抓到:GENBI_BACKEND=agentcore 时 invocations 只有 genbi + genbi-memory,检索腿凭空消失(inprocess 才有 sink)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { echoedSubInvocationsForTests } from "../agentcore-client";
import { AgentCoreModelMismatch } from "@/lib/ai/agentcore-contract";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
const strip = (raw: string) => raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("🔴 genbi agentcore:检索重排腿回显", () => {
  it("容器:只给检索用的 model client 带 onInvocation 回报;runAgent 的 _meta 带 invocations 且只压一条 genbi-retrieval", () => {
    const src = strip(read("infra/agent/genbi/agent.js"));
    expect(src).toContain("const makeBedrockModelClient = (MODEL_ID, onInvocation) =>");
    expect(src).toContain('if (typeof onInvocation === "function") onInvocation();');
    // @kf-batch 50-B26-lake-place —— `_meta` 多了 `ranIn: []`(执行层回报的真落点)
    expect(src).toContain("const _meta = { modelId: MODEL_ID, modelSource, invocations: [], ranIn: [] };");
    expect(src).toContain('capability: "genbi-retrieval", modelId: MODEL_ID, modelSource');
    // 该 client 仍只有一个消费点(检索);若将来主循环也用它,capability 就得区分 —— 数量断言钉住
    expect(src.split("bedrockModelClient").length - 1).toBe(2);
  });
  it("平台:client 合并子调用腿;execute.ts 的 agentcore 分支 push 进 invocations", () => {
    const client = strip(read("platform/src/lib/genbi/agentcore-client.ts"));
    expect(client).toContain("invocations: echoedSubInvocations(out, resolved.modelId)");
    const exec = strip(read("platform/src/lib/genbi/execute.ts"));
    const branch = exec.slice(exec.indexOf("if (useAgentCore) {"), exec.indexOf("} else {", exec.indexOf("if (useAgentCore) {")));
    expect(branch).toContain("invocations.push(...(out.invocations ?? []))");
  });
  it("回执逐条校验:子调用 modelId ≠ 透传值 ⇒ AgentCoreModelMismatch(不吞);形状不合法的条目跳过;缺 invocations ⇒ []", () => {
    const M = "global.anthropic.claude-opus-4-5-20251101-v1:0";
    expect(echoedSubInvocationsForTests({ _meta: { modelId: M, invocations: [{ capability: "genbi-retrieval", modelId: M, modelSource: "runtime" }] } }, M)).toEqual([
      { capability: "genbi-retrieval", modelId: M, modelSource: "runtime" },
    ]);
    expect(echoedSubInvocationsForTests({ _meta: { modelId: M } }, M)).toEqual([]);
    expect(echoedSubInvocationsForTests({ _meta: { modelId: M, invocations: [{ capability: 1 }, "x"] } }, M)).toEqual([]);
    expect(() => echoedSubInvocationsForTests({ _meta: { modelId: M, invocations: [{ capability: "genbi-retrieval", modelId: "us.anthropic.claude-opus-4-6-v1" }] } }, M)).toThrow(AgentCoreModelMismatch);
  });
});
