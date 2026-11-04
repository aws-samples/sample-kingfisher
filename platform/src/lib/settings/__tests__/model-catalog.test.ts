// @kf-batch 50-W5-seg2-WP8
// 目录单测(51 SPEC §2 GET /catalog;DESIGN D3′ 四系列(v2.0 档案驱动)/ M11 只读缓存 / §7.5 排序)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const mem = vi.hoisted(() => ({ db: null as unknown as import("./mem-ddb").MemDdb }));
vi.mock("@/lib/aws/dynamodb", async () => {
  const { createMemDdb } = await import("./mem-ddb");
  mem.db = createMemDdb({ "bgp-settings": ["pk", "sk"], "bgp-audit": ["pk", "ts"] });
  return { TABLES: { SETTINGS: "bgp-settings", AUDIT: "bgp-audit" }, docClient: { send: (cmd: any) => mem.db.send(cmd) } };
});

import { fetchCatalog, isSelectableSeries } from "../model-catalog";
import { putProbe, PROBE_TTL_MS } from "../model-store";

const fm = async () => [
  { modelId: "anthropic.claude-opus-4-8", modelName: "Claude Opus 4.8", outputModalities: ["TEXT"], inferenceTypesSupported: ["INFERENCE_PROFILE"] },
  { modelId: "anthropic.claude-opus-4-6-v1", modelName: "Claude Opus 4.6", outputModalities: ["TEXT"], inferenceTypesSupported: ["ON_DEMAND"] },
  { modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0", modelName: "Sonnet", outputModalities: ["TEXT"] },
  { modelId: "anthropic.claude-haiku-4-5", modelName: "Haiku", outputModalities: ["TEXT"] },
  { modelId: "openai.gpt-5.6-sol", modelName: "GPT-5.6 Sol", outputModalities: ["TEXT"] },
  { modelId: "openai.gpt-oss-120b", modelName: "gpt-oss", outputModalities: ["TEXT"] },
  { modelId: "amazon.titan-image-generator-v2", modelName: "Titan Image", outputModalities: ["IMAGE"] },
  // @kf-batch 51-v2-multi-vendor —— 2026-10-14 临时账号 us-east-1 ListFoundationModels 真实形态
  { modelId: "zai.glm-5.3", modelName: "GLM 5.3", outputModalities: ["TEXT"], inferenceTypesSupported: ["INFERENCE_PROFILE"] },
  { modelId: "zai.glm-5", modelName: "GLM 5", outputModalities: ["TEXT"], inferenceTypesSupported: ["ON_DEMAND"] },
  { modelId: "zai.glm-4.7", modelName: "GLM 4.7", outputModalities: ["TEXT"], inferenceTypesSupported: ["ON_DEMAND"] },
  { modelId: "moonshotai.kimi-k3", modelName: "Kimi K3", outputModalities: ["TEXT"], inferenceTypesSupported: ["INFERENCE_PROFILE"] },
  { modelId: "moonshotai.kimi-k2.5", modelName: "Kimi K2.5", outputModalities: ["TEXT"], inferenceTypesSupported: ["ON_DEMAND"] },
];
const ip = async () => [
  { inferenceProfileId: "us.anthropic.claude-opus-4-8", inferenceProfileName: "US Opus 4.8", models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-8" }], status: "ACTIVE" },
  { inferenceProfileId: "global.anthropic.claude-opus-4-8", inferenceProfileName: "Global Opus 4.8", models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-8" }], status: "ACTIVE" },
  { inferenceProfileId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", inferenceProfileName: "US Sonnet", models: [], status: "ACTIVE" },
  { inferenceProfileId: "global.openai.gpt-5.6-sol", inferenceProfileName: "Global GPT-5.6 Sol", models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-5.6-sol" }], status: "ACTIVE" },
  { inferenceProfileId: "us.zai.glm-5.3", inferenceProfileName: "US GLM 5.3", models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/zai.glm-5.3" }], status: "ACTIVE" },
  { inferenceProfileId: "global.zai.glm-5.3", inferenceProfileName: "Global GLM 5.3", models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/zai.glm-5.3" }], status: "ACTIVE" },
  { inferenceProfileId: "us.moonshotai.kimi-k3", inferenceProfileName: "US Kimi K3", models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/moonshotai.kimi-k3" }], status: "ACTIVE" },
  { inferenceProfileId: "global.moonshotai.kimi-k3", inferenceProfileName: "Global Kimi K3", models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/moonshotai.kimi-k3" }], status: "ACTIVE" },
  { inferenceProfileId: "us.moonshotai.kimi-k2.5", inferenceProfileName: "US Kimi K2.5", models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/moonshotai.kimi-k2.5" }], status: "ACTIVE" },
];

beforeEach(() => mem.db.reset());

// @kf-batch 50-WP31-place-first-class —— 落点必填(原来缺省 = process.env.AWS_REGION + tgt_home)
const HOME_PLACE = { targetId: "tgt_home", region: "us-east-1" };

describe("isSelectableSeries(D3′ 四系列,档案驱动)", () => {
  it("Opus 全版本 + gpt-5.6 + glm-5* + kimi-k3* 进;sonnet / haiku / gpt-oss / glm-4.x / kimi-k2.x / 其它 provider 不进", () => {
    expect(isSelectableSeries("anthropic.claude-opus-4-1-20250805-v1:0")).toBe(true);
    expect(isSelectableSeries("global.anthropic.claude-opus-5")).toBe(true);
    expect(isSelectableSeries("us.openai.gpt-5.6-terra")).toBe(true);
    expect(isSelectableSeries("us.anthropic.claude-haiku-4-5")).toBe(false);
    expect(isSelectableSeries("anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(false);
    expect(isSelectableSeries("openai.gpt-oss-120b")).toBe(false);
    expect(isSelectableSeries("amazon.nova-pro-v1:0")).toBe(false);
    expect(isSelectableSeries("us.zai.glm-5.3")).toBe(true);
    expect(isSelectableSeries("zai.glm-5")).toBe(true);
    expect(isSelectableSeries("global.moonshotai.kimi-k3")).toBe(true);
    expect(isSelectableSeries("zai.glm-4.7")).toBe(false);
    expect(isSelectableSeries("us.moonshotai.kimi-k2.5")).toBe(false);
  });
});

describe("fetchCatalog", () => {
  it("四系列过滤 + profile 前缀挂到基础模型 + 短 id(非 ARN)", async () => {
    const models = await fetchCatalog({ place: HOME_PLACE, deps: { listFoundationModels: fm, listInferenceProfiles: ip, now: () => 1000 } });
    const ids = models.map((m) => m.modelId);
    expect(ids).toEqual(
      expect.arrayContaining([
        "anthropic.claude-opus-4-8", "anthropic.claude-opus-4-6-v1", "us.anthropic.claude-opus-4-8", "global.anthropic.claude-opus-4-8", "openai.gpt-5.6-sol", "global.openai.gpt-5.6-sol",
        "zai.glm-5.3", "zai.glm-5", "us.zai.glm-5.3", "global.zai.glm-5.3", "moonshotai.kimi-k3", "us.moonshotai.kimi-k3", "global.moonshotai.kimi-k3",
      ])
    );
    for (const bad of ["anthropic.claude-sonnet-4-5-20250929-v1:0", "anthropic.claude-haiku-4-5", "openai.gpt-oss-120b", "amazon.titan-image-generator-v2", "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "zai.glm-4.7", "moonshotai.kimi-k2.5", "us.moonshotai.kimi-k2.5"]) {
      expect(ids).not.toContain(bad);
    }
    expect(models.find((m) => m.modelId === "zai.glm-5.3")?.profilePrefixes.sort()).toEqual(["global.", "us."]);
    expect(models.find((m) => m.modelId === "us.moonshotai.kimi-k3")).toMatchObject({ family: "moonshotai", kind: "profile", baseModelId: "moonshotai.kimi-k3" });
    expect(models.find((m) => m.modelId === "us.zai.glm-5.3")?.family).toBe("zai");
    const opus48 = models.find((m) => m.modelId === "anthropic.claude-opus-4-8")!;
    expect(opus48.profilePrefixes.sort()).toEqual(["global.", "us."]);
    expect(models.find((m) => m.modelId === "global.openai.gpt-5.6-sol")?.baseModelId).toBe("openai.gpt-5.6-sol");
    expect(models.find((m) => m.modelId === "global.openai.gpt-5.6-sol")?.family).toBe("openai");
    expect(ids.some((i) => i.startsWith("arn:"))).toBe(false);
  });

  it("available / lastProbe 只读探测缓存:未探测=false 无 lastProbe;24h 内按缓存;过期=未知", async () => {
    await putProbe("tgt_home", "global.anthropic.claude-opus-4-8", { ok: true, toolUseOk: true }, 1000);
    await putProbe("tgt_home", "openai.gpt-5.6-sol", { ok: false, error: "AccessDenied" }, 1000);
    await putProbe("tgt_home", "anthropic.claude-opus-4-6-v1", { ok: true }, 1000 - PROBE_TTL_MS - 1);
    const models = await fetchCatalog({ place: HOME_PLACE, deps: { listFoundationModels: fm, listInferenceProfiles: ip, now: () => 1000 } });
    const by = (id: string) => models.find((m) => m.modelId === id)!;
    expect(by("global.anthropic.claude-opus-4-8").available).toBe(true);
    expect(by("global.anthropic.claude-opus-4-8").lastProbe?.ok).toBe(true);
    expect(by("openai.gpt-5.6-sol").available).toBe(false);
    expect(by("openai.gpt-5.6-sol").lastProbe?.error).toBe("AccessDenied");
    expect(by("anthropic.claude-opus-4-6-v1").available).toBe(false);
    expect(by("anthropic.claude-opus-4-6-v1").lastProbe).toBeUndefined(); // 过期 = 未知
    expect(by("anthropic.claude-opus-4-8").available).toBe(false);
    expect(by("anthropic.claude-opus-4-8").lastProbe).toBeUndefined();
    // 🔴 M11:目录读不改任何 probedAt(零写)
    expect(mem.db.log.filter((l) => l.cmd !== "QueryCommand" && l.cmd !== "GetCommand" && l.cmd !== "PutCommand").length).toBe(0);
    const writesAfterSeed = mem.db.log.slice(3).filter((l) => l.cmd === "PutCommand" || l.cmd === "UpdateCommand" || l.cmd === "TransactWriteCommand");
    expect(writesAfterSeed).toHaveLength(0);
  });

  // @kf-batch 51-v2-multi-vendor —— 51 SPEC §7.5 排序
  it("排序:available 的在前(哪一系都行),其后按档案系列顺序 anthropic → openai → zai → moonshotai,再按 id", async () => {
    await putProbe("tgt_home", "global.moonshotai.kimi-k3", { ok: true, toolUseOk: true }, 1000);
    const models = await fetchCatalog({ place: HOME_PLACE, deps: { listFoundationModels: fm, listInferenceProfiles: ip, now: () => 1000 } });
    expect(models[0].modelId).toBe("global.moonshotai.kimi-k3");
    const rest = models.slice(1).map((m) => m.family);
    const order = ["anthropic", "openai", "zai", "moonshotai"];
    const ranks = rest.map((f) => order.indexOf(f));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(models.slice(1).every((m) => m.available === false)).toBe(true);
  });

  it("探测缓存读失败不阻断目录(全部按未探测)", async () => {
    mem.db.injectError((cmd) => (cmd === "QueryCommand" ? Object.assign(new Error("table missing"), { name: "ResourceNotFoundException" }) : null));
    const models = await fetchCatalog({ place: HOME_PLACE, deps: { listFoundationModels: fm, listInferenceProfiles: ip } });
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.available === false)).toBe(true);
  });

  it("控制面调用失败 ⇒ 抛(路由转 503)", async () => {
    await expect(fetchCatalog({ place: HOME_PLACE, deps: { listFoundationModels: async () => { throw new Error("ListFoundationModels denied"); }, listInferenceProfiles: ip } })).rejects.toThrow("ListFoundationModels denied");
  });
});

// @kf-batch 50-PROD-A-launch-hardening(h)—— 主控区 / 执行区不在美国:该区的推理配置前缀按账号真值推,不枚举
describe("非美国区的推理配置(eu. / apac. / jp. / us-gov.)", () => {
  const arn = (r: string, m: string) => `arn:aws:bedrock:${r}::foundation-model/${m}`;
  const ipGeo = async () => [
    { inferenceProfileId: "eu.anthropic.claude-opus-4-8", inferenceProfileName: "EU Opus 4.8", models: [{ modelArn: arn("eu-west-1", "anthropic.claude-opus-4-8") }], status: "ACTIVE" },
    { inferenceProfileId: "apac.anthropic.claude-opus-4-8", inferenceProfileName: "APAC Opus 4.8", models: [{ modelArn: arn("ap-southeast-1", "anthropic.claude-opus-4-8") }], status: "ACTIVE" },
    { inferenceProfileId: "jp.anthropic.claude-opus-4-8", inferenceProfileName: "JP Opus 4.8", models: [{ modelArn: arn("ap-northeast-1", "anthropic.claude-opus-4-8") }], status: "ACTIVE" },
    { inferenceProfileId: "us-gov.anthropic.claude-opus-4-8", inferenceProfileName: "GovCloud", models: [{ modelArn: arn("us-gov-west-1", "anthropic.claude-opus-4-8") }], status: "ACTIVE" },
    // 形态不对(大写)/ 推不出前缀 ⇒ 不进
    { inferenceProfileId: "EU.anthropic.claude-opus-4-8", inferenceProfileName: "bad", models: [{ modelArn: arn("eu-west-1", "anthropic.claude-opus-4-8") }], status: "ACTIVE" },
  ];
  it("四种地理前缀的配置都进目录,基础模型项挂上全部前缀;形态不对的不进", async () => {
    const cat = await fetchCatalog({ place: { targetId: "tgt_x", region: "eu-west-1" }, deps: { listFoundationModels: fm, listInferenceProfiles: ipGeo, now: () => 0 } });
    const ids = cat.filter((c) => c.kind === "profile").map((c) => c.modelId).sort();
    expect(ids).toEqual(["apac.anthropic.claude-opus-4-8", "eu.anthropic.claude-opus-4-8", "jp.anthropic.claude-opus-4-8", "us-gov.anthropic.claude-opus-4-8"]);
    const base = cat.find((c) => c.modelId === "anthropic.claude-opus-4-8");
    expect([...(base?.profilePrefixes || [])].sort()).toEqual(["apac.", "eu.", "jp.", "us-gov."]);
  });
  it("isSelectableSeries 认任意地理前缀,但前缀只在档案系列 provider 之前才算", () => {
    expect(isSelectableSeries("eu.anthropic.claude-opus-4-8")).toBe(true);
    expect(isSelectableSeries("us-gov.anthropic.claude-opus-4-8")).toBe(true);
    expect(isSelectableSeries("jp.openai.gpt-5.6-sol")).toBe(true);
    expect(isSelectableSeries("eu.anthropic.claude-haiku-4-5")).toBe(false);
    expect(isSelectableSeries("eu.meta.llama-x")).toBe(false);
  });
});
