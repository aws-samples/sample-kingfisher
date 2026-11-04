// @kf-batch 54-genbi-session-cards
// 🔴🔴 `_meta.contextTurns` = **这次问数实际喂进去的前序对话轮数**(2026-09-13 新增的可观测量)。
//
// 为什么加它:「续聊是不是真接上了」原来只能去**猜模型措辞** —— 判据写「追问『那按分类呢?』⇒
// 新 SQL 必须与全新对话不同」,而在有码表的库里,接上与没接上给出的是**同一张表**(真环境实测)
// ⇒ 判据没有判别力。与当初给 `_meta` 补 `backend` 是同一条:**判据需要的真值,产品有义务暴露出来**。
// 运维侧同样受益:「它到底看没看见上文」现在看得到。
import { describe, it, expect } from "vitest";
import { buildAiMeta } from "@/lib/ai/meta";

const primary = { modelId: "m", modelSource: "default" as const };

describe("🔴 _meta.contextTurns", () => {
  it("有上下文 ⇒ 如实回显轮数", () => {
    const m = buildAiMeta(null, primary, { correlationId: "c", contextTurns: 4 });
    expect(m.contextTurns).toBe(4);
  });

  it("🔴 **0 也要回显**(抹成 undefined 会让判据分不清「没接上」与「产品没暴露这个量」)", () => {
    const m = buildAiMeta(null, primary, { correlationId: "c", contextTurns: 0 });
    expect(m).toHaveProperty("contextTurns");
    expect(m.contextTurns).toBe(0);
  });

  it("压根没给 ⇒ 不出现该字段(不许编一个 0 出来)", () => {
    const m = buildAiMeta(null, primary, { correlationId: "c" });
    expect(m).not.toHaveProperty("contextTurns");
  });
});
