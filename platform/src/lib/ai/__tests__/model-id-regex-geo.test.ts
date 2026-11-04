// @kf-batch 50-PROD-A-launch-hardening(h)
// 模型 id 形态:地理前缀按形态收(Bedrock 真实存在 us-gov. / jp. / au. …),不再只认四个;注入形态照样拒。
import { describe, it, expect } from "vitest";
import { MODEL_ID_REGEX } from "@/lib/ai/model";

describe("MODEL_ID_REGEX 地理前缀", () => {
  it.each(["us.anthropic.claude-opus-4-5-20251101-v1:0", "eu.anthropic.claude-opus-4-8", "apac.anthropic.claude-opus-4-8",
           "jp.anthropic.claude-opus-4-8", "us-gov.anthropic.claude-opus-4-8", "global.openai.gpt-5.6-sol", "anthropic.claude-opus-4-8",
           // @kf-batch 51-v2-multi-vendor —— GLM 5.3 / Kimi K3 的基础 id 与推理配置 id(2026-10-14 Bedrock 真实形态)
           "zai.glm-5.3", "us.zai.glm-5.3", "moonshotai.kimi-k3", "global.moonshotai.kimi-k3"])(
    "收 %s", (id) => expect(MODEL_ID_REGEX.test(id)).toBe(true));
  it.each(["EU.anthropic.claude-opus", "eu.anthropic.claude opus", "eu.anthropic.claude-opus;rm", "../anthropic.x", "eu."])(
    "拒 %s", (id) => expect(MODEL_ID_REGEX.test(id)).toBe(false));
});
