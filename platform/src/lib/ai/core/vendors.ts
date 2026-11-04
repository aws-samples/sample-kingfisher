// **厂商档案(唯一作者)**:系列 / 地理前缀 / 可选判定 / inferenceConfig 字段支持 / 推理块 / maxTokens 系数
// (51 DESIGN §12 D3′ / D10;SPEC §7.1)。
//
// 🔴 零 `@/` 依赖、零 AWS SDK 依赖:本目录由 scripts/core-prebuild.sh(能力 `ai`)编成 CJS 分发到三个 AgentCore 容器的
//    `core-dist/ai/`,容器与平台**读同一份档案**(用户 2026-10-14:「全部走同一个模型通道」)。
// 🔴 全仓系列判定只许在这里写(门禁单测 model-config-guard:`anthropic\.claude-opus-` 这类正则只许出现在本文件)。
//
// 字段支持矩阵来自 2026-10-14 临时账号真 converse(51 DESIGN §12.2):
//   · moonshotai(Kimi K3):temperature / topP / stopSequences 三个字段**都拒**(ValidationException「This model doesn't
//     support the <field> field」);恒回 reasoningContent 块;问数式提示输出 token ≈ Claude 2.1× ⇒ maxTokensFactor 2
//   · zai(GLM 5,以 zai.glm-5 实测;glm-5.3 本体账号级未开放):temperature / topP 收,stopSequences 拒;无推理块
//   · anthropic / openai:三字段都收(现状)
// 运行期若遇到档案没记的「不支持字段」,converse-shape.ts 会学下来并同层重试一次 —— 档案是底线,不是天花板。
// 探测预算来自 2026-10-20 临时账号真 converse:Kimi K3 tiny invoke(maxTokens 24)与 tool-use 探测各 8 次采样 3.0–39.4s,
//   10s 预算下 5 次超时且被归成「限流」⇒ 页面保存随机失败 ⇒ 预算按系列给(probeTimeoutMs),超时单列 Timeout 类。

export type Family = "anthropic" | "openai" | "zai" | "moonshotai";

export type InferenceField = "temperature" | "topP" | "stopSequences";
export const INFERENCE_FIELDS: readonly InferenceField[] = ["temperature", "topP", "stopSequences"];

export type InferenceFieldSupport = Record<InferenceField, boolean>;

export interface VendorProfile {
  family: Family;
  /** 下拉分组标题(中文原文,前端经 i18n) */
  label: string;
  /** 可选系列判定 —— 作用在**去掉地理前缀后**的 id 上 */
  selectable: RegExp;
  /** assumed = 不做 tool-use 二探(Claude 现状即支持);probe = 探测必做二探,PUT 要求 toolUseOk === true(D11) */
  toolUse: "assumed" | "probe";
  /** 该系列的 inferenceConfig 字段支持矩阵;false 的字段整形时剥掉(D12) */
  inferenceFields: InferenceFieldSupport;
  /** 恒回 reasoningContent 块(只做标注与系数依据,调用方对推理块透明,D13) */
  reasoningBlocks: boolean;
  /** maxTokens 系数(量出来的,不是拍的;见文件头) */
  maxTokensFactor: number;
  /**
   * 探测预算(ms):tiny invoke 与 tool-use 二探各自的超时(两探并行,墙钟 ≈ max)。量出来的,不是拍的(见文件头):
   * 推理模型首字延迟大 —— Kimi K3 2026-10-20 us-east-1 8 次采样 3.0–39.4s(us. / global. 都抖),10s 预算 5 次超时;
   * 其余系列 10s 够用。上限受 ALB 60s 墙约束(保存 / 探测路由同步回包)。
   */
  probeTimeoutMs: number;
}

export const VENDORS: Record<Family, VendorProfile> = {
  anthropic: {
    family: "anthropic",
    label: "Claude Opus",
    selectable: /^anthropic\.claude-opus-/,
    toolUse: "assumed",
    inferenceFields: { temperature: true, topP: true, stopSequences: true },
    reasoningBlocks: false,
    maxTokensFactor: 1,
    probeTimeoutMs: 10_000,
  },
  openai: {
    family: "openai",
    label: "OpenAI GPT-5.6(经 Bedrock)",
    selectable: /^openai\.gpt-5\.6-/,
    toolUse: "probe",
    inferenceFields: { temperature: true, topP: true, stopSequences: true },
    reasoningBlocks: false,
    maxTokensFactor: 1,
    probeTimeoutMs: 10_000,
  },
  zai: {
    family: "zai",
    label: "GLM 5(Z.AI 智谱,经 Bedrock)",
    selectable: /^zai\.glm-5(?![0-9])/,
    toolUse: "probe",
    inferenceFields: { temperature: true, topP: true, stopSequences: false },
    reasoningBlocks: false,
    maxTokensFactor: 1,
    probeTimeoutMs: 10_000,
  },
  moonshotai: {
    family: "moonshotai",
    label: "Kimi K3(Moonshot AI,经 Bedrock)",
    selectable: /^moonshotai\.kimi-k3(?![0-9])/,
    toolUse: "probe",
    inferenceFields: { temperature: false, topP: false, stopSequences: false },
    reasoningBlocks: true,
    maxTokensFactor: 2,
    probeTimeoutMs: 45_000,
  },
};

/** 系列键(顺序 = 下拉分组顺序) */
export const FAMILIES: readonly Family[] = ["anthropic", "openai", "zai", "moonshotai"];

/**
 * 推理配置的地理前缀**唯一作者**(由系列键生成;原来手写 `anthropic|openai`,加一家就漏一家 ——
 * `us.zai.glm-5.3` 在旧正则下会被判成「不是任何系列」)。按形态认:小写段 + 点,且只在已知系列之前才算前缀。
 */
export const GEO_PREFIX_RE = new RegExp(`^[a-z]+(?:-[a-z]+)*\\.(?=(?:${FAMILIES.join("|")})\\.)`);

export function stripGeoPrefix(modelId: string): string {
  return modelId.replace(GEO_PREFIX_RE, "");
}

export function familyOf(modelId: string): Family | null {
  const bare = stripGeoPrefix(modelId);
  for (const f of FAMILIES) if (bare.startsWith(`${f}.`)) return f;
  return null;
}

export function vendorOf(modelId: string): VendorProfile | null {
  const f = familyOf(modelId);
  return f ? VENDORS[f] : null;
}

/** 四系列可选判定(基础 id 或带任意地理前缀的推理配置 id 都认;sonnet / haiku / glm-4.x / kimi-k2.5 / 其它厂商不进)。 */
export function isSelectableSeries(modelId: string): boolean {
  const v = vendorOf(modelId);
  return !!v && v.selectable.test(stripGeoPrefix(modelId));
}

export function isOpenAIFamily(modelId: string): boolean {
  return familyOf(modelId) === "openai";
}

/** 给前端分组用的只读摘要(GET /catalog 的 `families[]`;前端不再硬编码系列名)。 */
export interface FamilySummary {
  family: Family;
  label: string;
  toolUse: VendorProfile["toolUse"];
  reasoningBlocks: boolean;
}
export function familySummaries(): FamilySummary[] {
  return FAMILIES.map((f) => {
    const v = VENDORS[f];
    return { family: f, label: v.label, toolUse: v.toolUse, reasoningBlocks: v.reasoningBlocks };
  });
}
