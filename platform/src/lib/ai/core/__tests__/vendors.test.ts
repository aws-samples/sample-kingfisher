// 厂商档案单测(51 SPEC §7.1;DESIGN §12 D3′ / D10)。钉的是**事实**:哪些 id 进选择面、剥前缀后归哪一系、
// 字段支持矩阵与 2026-10-14 真环境勘定一致(DESIGN §12.2),以及地理前缀正则由系列键生成(加一家不漏一家)。
import { describe, it, expect } from "vitest";
import {
  FAMILIES,
  GEO_PREFIX_RE,
  VENDORS,
  familyOf,
  familySummaries,
  isOpenAIFamily,
  isSelectableSeries,
  stripGeoPrefix,
  vendorOf,
} from "../vendors";

describe("isSelectableSeries(D3′ 四系列)", () => {
  it.each([
    "anthropic.claude-opus-4-5-20251101-v1:0",
    "us.anthropic.claude-opus-4-8",
    "global.anthropic.claude-opus-5",
    "openai.gpt-5.6-sol",
    "jp.openai.gpt-5.6-terra",
    "zai.glm-5.3",
    "us.zai.glm-5.3",
    "global.zai.glm-5.3",
    "zai.glm-5", // 账号级拿不到 5.3 时的同系列替身(DESIGN §12.2)
    "moonshotai.kimi-k3",
    "us.moonshotai.kimi-k3",
    "global.moonshotai.kimi-k3",
  ])("进:%s", (id) => expect(isSelectableSeries(id)).toBe(true));

  it.each([
    "anthropic.claude-sonnet-4-5-20250929-v1:0",
    "us.anthropic.claude-haiku-4-5",
    "openai.gpt-oss-120b",
    "zai.glm-4.7",
    "zai.glm-4.7-flash",
    "zai.glm-50", // (?![0-9]):glm-5 后面紧跟数字不算 GLM 5 系
    "moonshotai.kimi-k2.5",
    "moonshotai.kimi-k30",
    "amazon.nova-pro-v1:0",
    "eu.meta.llama-x",
    "arn:aws:bedrock:us-east-1:123456789abc:inference-profile/us.zai.glm-5.3",
  ])("不进:%s", (id) => expect(isSelectableSeries(id)).toBe(false));
});

describe("地理前缀 / 系列归属(前缀只在已知系列之前才算)", () => {
  it("stripGeoPrefix 剥任意形态的地理段(us. / global. / us-gov. / jp.),基础 id 原样", () => {
    expect(stripGeoPrefix("us.zai.glm-5.3")).toBe("zai.glm-5.3");
    expect(stripGeoPrefix("global.moonshotai.kimi-k3")).toBe("moonshotai.kimi-k3");
    expect(stripGeoPrefix("us-gov.anthropic.claude-opus-4-8")).toBe("anthropic.claude-opus-4-8");
    expect(stripGeoPrefix("jp.openai.gpt-5.6-sol")).toBe("openai.gpt-5.6-sol");
    expect(stripGeoPrefix("zai.glm-5.3")).toBe("zai.glm-5.3");
    expect(stripGeoPrefix("eu.meta.llama-x")).toBe("eu.meta.llama-x"); // 未知系列:不剥(不知道哪段是前缀)
  });
  it("familyOf / vendorOf / isOpenAIFamily", () => {
    expect(familyOf("us.zai.glm-5.3")).toBe("zai");
    expect(familyOf("global.moonshotai.kimi-k3")).toBe("moonshotai");
    expect(familyOf("eu.anthropic.claude-opus-4-8")).toBe("anthropic");
    expect(familyOf("jp.openai.gpt-5.6-sol")).toBe("openai");
    expect(familyOf("amazon.nova-pro-v1:0")).toBeNull();
    expect(vendorOf("us.moonshotai.kimi-k3")?.family).toBe("moonshotai");
    expect(vendorOf("amazon.nova-pro-v1:0")).toBeNull();
    expect(isOpenAIFamily("global.openai.gpt-5.6-sol")).toBe(true);
    expect(isOpenAIFamily("zai.glm-5.3")).toBe(false);
  });
  it("🔴 GEO_PREFIX_RE 由系列键生成:每个系列名都在正则源里(原来手写 anthropic|openai,加 zai 就漏)", () => {
    for (const f of FAMILIES) expect(GEO_PREFIX_RE.source).toContain(f);
    expect(FAMILIES).toEqual(["anthropic", "openai", "zai", "moonshotai"]);
    expect(Object.keys(VENDORS).sort()).toEqual([...FAMILIES].sort());
  });
});

describe("字段支持矩阵 = 2026-10-14 真环境勘定(DESIGN §12.2)", () => {
  it("moonshotai(Kimi K3):三字段都拒、恒推理块、maxTokens ×2、tool-use 要探", () => {
    const v = VENDORS.moonshotai;
    expect(v.inferenceFields).toEqual({ temperature: false, topP: false, stopSequences: false });
    expect(v.reasoningBlocks).toBe(true);
    expect(v.maxTokensFactor).toBe(2);
    expect(v.toolUse).toBe("probe");
  });
  // (2026-10-20 真测):Kimi K3 tiny / tool-use 探测 8 次采样 3.0–39.4s ⇒ 10s 预算 5 次超时
  it("探测预算 probeTimeoutMs:每个系列都有且 ≥ 10s;Kimi K3 ≥ 40s(量出来的首字延迟上限)且 < 60s(ALB 墙,两探并行墙钟 ≈ max)", () => {
    for (const f of FAMILIES) {
      expect(typeof VENDORS[f].probeTimeoutMs, f).toBe("number");
      expect(VENDORS[f].probeTimeoutMs, f).toBeGreaterThanOrEqual(10_000);
      expect(VENDORS[f].probeTimeoutMs, f).toBeLessThan(60_000);
    }
    expect(VENDORS.moonshotai.probeTimeoutMs).toBeGreaterThanOrEqual(40_000);
    expect(VENDORS.anthropic.probeTimeoutMs).toBe(10_000);
  });
  it("zai(GLM 5):收 temperature / topP、拒 stopSequences、无推理块、×1、tool-use 要探", () => {
    const v = VENDORS.zai;
    expect(v.inferenceFields).toEqual({ temperature: true, topP: true, stopSequences: false });
    expect(v.reasoningBlocks).toBe(false);
    expect(v.maxTokensFactor).toBe(1);
    expect(v.toolUse).toBe("probe");
  });
  it("anthropic(Claude Opus):全收、不探(现状即支持)、×1;openai:全收、要探", () => {
    expect(VENDORS.anthropic.inferenceFields).toEqual({ temperature: true, topP: true, stopSequences: true });
    expect(VENDORS.anthropic.toolUse).toBe("assumed");
    expect(VENDORS.anthropic.maxTokensFactor).toBe(1);
    expect(VENDORS.openai.inferenceFields).toEqual({ temperature: true, topP: true, stopSequences: true });
    expect(VENDORS.openai.toolUse).toBe("probe");
  });
  it("familySummaries 顺序 = FAMILIES,带分组标题与两个前端要的标注", () => {
    const s = familySummaries();
    expect(s.map((x) => x.family)).toEqual([...FAMILIES]);
    for (const x of s) {
      expect(x.label.length).toBeGreaterThan(0);
      expect(["assumed", "probe"]).toContain(x.toolUse);
      expect(typeof x.reasoningBlocks).toBe("boolean");
    }
    expect(s.find((x) => x.family === "moonshotai")?.reasoningBlocks).toBe(true);
  });
});
