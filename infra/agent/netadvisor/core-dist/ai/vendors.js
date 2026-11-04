"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.GEO_PREFIX_RE = exports.FAMILIES = exports.VENDORS = exports.INFERENCE_FIELDS = void 0;
exports.stripGeoPrefix = stripGeoPrefix;
exports.familyOf = familyOf;
exports.vendorOf = vendorOf;
exports.isSelectableSeries = isSelectableSeries;
exports.isOpenAIFamily = isOpenAIFamily;
exports.familySummaries = familySummaries;
exports.INFERENCE_FIELDS = ["temperature", "topP", "stopSequences"];
exports.VENDORS = {
    anthropic: {
        family: "anthropic",
        label: "Claude Opus",
        selectable: /^anthropic\.claude-opus-/,
        toolUse: "assumed",
        inferenceFields: { temperature: true, topP: true, stopSequences: true },
        reasoningBlocks: false,
        maxTokensFactor: 1,
        probeTimeoutMs: 10000,
    },
    openai: {
        family: "openai",
        label: "OpenAI GPT-5.6(经 Bedrock)",
        selectable: /^openai\.gpt-5\.6-/,
        toolUse: "probe",
        inferenceFields: { temperature: true, topP: true, stopSequences: true },
        reasoningBlocks: false,
        maxTokensFactor: 1,
        probeTimeoutMs: 10000,
    },
    zai: {
        family: "zai",
        label: "GLM 5(Z.AI 智谱,经 Bedrock)",
        selectable: /^zai\.glm-5(?![0-9])/,
        toolUse: "probe",
        inferenceFields: { temperature: true, topP: true, stopSequences: false },
        reasoningBlocks: false,
        maxTokensFactor: 1,
        probeTimeoutMs: 10000,
    },
    moonshotai: {
        family: "moonshotai",
        label: "Kimi K3(Moonshot AI,经 Bedrock)",
        selectable: /^moonshotai\.kimi-k3(?![0-9])/,
        toolUse: "probe",
        inferenceFields: { temperature: false, topP: false, stopSequences: false },
        reasoningBlocks: true,
        maxTokensFactor: 2,
        probeTimeoutMs: 45000,
    },
};
/** 系列键(顺序 = 下拉分组顺序) */
exports.FAMILIES = ["anthropic", "openai", "zai", "moonshotai"];
/**
 * 推理配置的地理前缀**唯一作者**(由系列键生成;原来手写 `anthropic|openai`,加一家就漏一家 ——
 * `us.zai.glm-5.3` 在旧正则下会被判成「不是任何系列」)。按形态认:小写段 + 点,且只在已知系列之前才算前缀。
 */
exports.GEO_PREFIX_RE = new RegExp(`^[a-z]+(?:-[a-z]+)*\\.(?=(?:${exports.FAMILIES.join("|")})\\.)`);
function stripGeoPrefix(modelId) {
    return modelId.replace(exports.GEO_PREFIX_RE, "");
}
function familyOf(modelId) {
    const bare = stripGeoPrefix(modelId);
    for (const f of exports.FAMILIES)
        if (bare.startsWith(`${f}.`))
            return f;
    return null;
}
function vendorOf(modelId) {
    const f = familyOf(modelId);
    return f ? exports.VENDORS[f] : null;
}
/** 四系列可选判定(基础 id 或带任意地理前缀的推理配置 id 都认;sonnet / haiku / glm-4.x / kimi-k2.5 / 其它厂商不进)。 */
function isSelectableSeries(modelId) {
    const v = vendorOf(modelId);
    return !!v && v.selectable.test(stripGeoPrefix(modelId));
}
function isOpenAIFamily(modelId) {
    return familyOf(modelId) === "openai";
}
function familySummaries() {
    return exports.FAMILIES.map((f) => {
        const v = exports.VENDORS[f];
        return { family: f, label: v.label, toolUse: v.toolUse, reasoningBlocks: v.reasoningBlocks };
    });
}
