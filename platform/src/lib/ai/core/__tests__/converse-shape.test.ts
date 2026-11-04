// 请求整形单测(51 SPEC §7.2;DESIGN §12 D12)。夹具用 2026-10-14 Bedrock 真实原话。
// 钉三件事:① Claude 系列恒等(一个字节都不动);② Kimi / GLM 按档案剥字段、Kimi maxTokens ×2;
// ③ 运行期从 ValidationException 原话里学到字段后,后续整形会剥掉它(进程级,挂 globalThis)。
import { describe, it, expect, beforeEach } from "vitest";
import {
  UNSUPPORTED_FIELD_RE,
  _resetLearnedForTests,
  learnUnsupportedField,
  learnedUnsupportedFields,
  shapeConverseInput,
  shapeInferenceConfig,
} from "../converse-shape";

const CLAUDE = "us.anthropic.claude-opus-4-5-20251101-v1:0";
const KIMI = "global.moonshotai.kimi-k3";
const GLM = "zai.glm-5";
const UNKNOWN = "amazon.nova-pro-v1:0";

beforeEach(() => _resetLearnedForTests());

describe("① Claude 系列恒等", () => {
  it("任意 cfg 深等于输入、stripped 空、boosted false;shapeConverseInput 原引用返回", () => {
    const cfg = { maxTokens: 1600, temperature: 0, topP: 0.9, stopSequences: ["</sql>"] };
    const r = shapeInferenceConfig(CLAUDE, cfg);
    expect(r.config).toEqual(cfg);
    expect(r.stripped).toEqual([]);
    expect(r.boosted).toBe(false);
    const input = { modelId: CLAUDE, messages: [{ role: "user", content: [{ text: "hi" }] }], inferenceConfig: cfg };
    const s = shapeConverseInput(input);
    expect(s.input).toBe(input); // 没动就不复制
    expect(s.stripped).toEqual([]);
  });
  it("cfg 为空 ⇒ 原样返回(不编造 inferenceConfig)", () => {
    expect(shapeInferenceConfig(KIMI, undefined)).toEqual({ config: undefined, stripped: [], boosted: false });
    const input = { modelId: KIMI, messages: [] as unknown[] };
    expect(shapeConverseInput(input).input).toBe(input);
  });
});

describe("② 按档案整形(只减字段、只放大 maxTokens、不碰消息体)", () => {
  it("Kimi K3:剥 temperature / topP / stopSequences,maxTokens 2200 → 4400;messages / system 同一引用", () => {
    const messages = [{ role: "user", content: [{ text: "hi" }] }];
    const system = [{ text: "sys" }];
    const s = shapeConverseInput({
      modelId: KIMI,
      system,
      messages,
      inferenceConfig: { maxTokens: 2200, temperature: 0, topP: 0.9, stopSequences: ["x"] },
    });
    expect(s.input.inferenceConfig).toEqual({ maxTokens: 4400 });
    expect(s.stripped.sort()).toEqual(["stopSequences", "temperature", "topP"]);
    expect(s.boosted).toBe(true);
    expect(s.input.messages).toBe(messages);
    expect(s.input.system).toBe(system);
    expect(s.input.modelId).toBe(KIMI);
  });
  it("Kimi K3 只给 maxTokens ⇒ 只放大、stripped 空(没有的字段不算剥)", () => {
    const r = shapeInferenceConfig(KIMI, { maxTokens: 1000 });
    expect(r).toEqual({ config: { maxTokens: 2000 }, stripped: [], boosted: true });
  });
  it("GLM 5:只剥 stopSequences,temperature / topP 保留,maxTokens 不变", () => {
    const r = shapeInferenceConfig(GLM, { maxTokens: 1600, temperature: 0, topP: 0.8, stopSequences: ["x"] });
    expect(r.config).toEqual({ maxTokens: 1600, temperature: 0, topP: 0.8 });
    expect(r.stripped).toEqual(["stopSequences"]);
    expect(r.boosted).toBe(false);
  });
  it("未知系列(档案没有):不剥、不放大", () => {
    const cfg = { maxTokens: 300, temperature: 0.2 };
    expect(shapeInferenceConfig(UNKNOWN, cfg)).toEqual({ config: cfg, stripped: [], boosted: false });
  });
  it("不改输入对象本身(纯函数)", () => {
    const cfg = { maxTokens: 100, temperature: 0 };
    shapeInferenceConfig(KIMI, cfg);
    expect(cfg).toEqual({ maxTokens: 100, temperature: 0 });
  });
});

describe("③ 运行期学习(Bedrock 原话 → 剥字段)", () => {
  const bedrockSays = (field: string) =>
    Object.assign(new Error(`This model doesn't support the ${field} field. Remove ${field} and try again.`), { name: "ValidationException" });

  it("UNSUPPORTED_FIELD_RE 认三种字段的原话,不认别的 ValidationException", () => {
    expect(UNSUPPORTED_FIELD_RE.test("This model doesn't support the temperature field. Remove temperature and try again.")).toBe(true);
    expect(UNSUPPORTED_FIELD_RE.test("This model doesn't support the topP field.")).toBe(true);
    expect(UNSUPPORTED_FIELD_RE.test("This model doesn't support the stopSequences field.")).toBe(true);
    expect(UNSUPPORTED_FIELD_RE.test("The provided model identifier is invalid.")).toBe(false);
    expect(UNSUPPORTED_FIELD_RE.test("Invocation of model ID zai.glm-5.3 with on-demand throughput isn't supported.")).toBe(false);
  });
  it("学到 ⇒ 返回字段名并记住;之后对**该模型**整形会剥掉它,别的模型不受影响", () => {
    expect(learnUnsupportedField(UNKNOWN, bedrockSays("temperature"))).toBe("temperature");
    expect(learnedUnsupportedFields(UNKNOWN)).toEqual(["temperature"]);
    const r = shapeInferenceConfig(UNKNOWN, { maxTokens: 10, temperature: 0, topP: 0.5 });
    expect(r.config).toEqual({ maxTokens: 10, topP: 0.5 });
    expect(r.stripped).toEqual(["temperature"]);
    expect(shapeInferenceConfig(CLAUDE, { maxTokens: 10, temperature: 0 }).stripped).toEqual([]);
  });
  it("学不到(别的错误 / 非 Error)⇒ null 且不记", () => {
    expect(learnUnsupportedField(UNKNOWN, Object.assign(new Error("The provided model identifier is invalid"), { name: "ValidationException" }))).toBeNull();
    expect(learnUnsupportedField(UNKNOWN, { message: "rate exceeded" })).toBeNull();
    expect(learnUnsupportedField(UNKNOWN, undefined)).toBeNull();
    expect(learnedUnsupportedFields(UNKNOWN)).toEqual([]);
  });
  it("🔴 学习表挂 globalThis(Symbol.for):Next 产物里同一源文件多个模块实例也共享(记忆 next-bundle-duplicate-module-instances)", () => {
    learnUnsupportedField(GLM, bedrockSays("topP"));
    const g = globalThis as unknown as Record<symbol, Map<string, Set<string>> | undefined>;
    const m = g[Symbol.for("kf.ai.converse-shape.learnedUnsupportedFields")];
    expect(m).toBeInstanceOf(Map);
    expect(Array.from(m!.get(GLM) ?? [])).toEqual(["topP"]);
    _resetLearnedForTests();
    expect(m!.size).toBe(0);
  });
});
