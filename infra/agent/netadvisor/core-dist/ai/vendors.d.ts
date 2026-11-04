export type Family = "anthropic" | "openai" | "zai" | "moonshotai";
export type InferenceField = "temperature" | "topP" | "stopSequences";
export declare const INFERENCE_FIELDS: readonly InferenceField[];
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
export declare const VENDORS: Record<Family, VendorProfile>;
/** 系列键(顺序 = 下拉分组顺序) */
export declare const FAMILIES: readonly Family[];
/**
 * 推理配置的地理前缀**唯一作者**(由系列键生成;原来手写 `anthropic|openai`,加一家就漏一家 ——
 * `us.zai.glm-5.3` 在旧正则下会被判成「不是任何系列」)。按形态认:小写段 + 点,且只在已知系列之前才算前缀。
 */
export declare const GEO_PREFIX_RE: RegExp;
export declare function stripGeoPrefix(modelId: string): string;
export declare function familyOf(modelId: string): Family | null;
export declare function vendorOf(modelId: string): VendorProfile | null;
/** 四系列可选判定(基础 id 或带任意地理前缀的推理配置 id 都认;sonnet / haiku / glm-4.x / kimi-k2.5 / 其它厂商不进)。 */
export declare function isSelectableSeries(modelId: string): boolean;
export declare function isOpenAIFamily(modelId: string): boolean;
/** 给前端分组用的只读摘要(GET /catalog 的 `families[]`;前端不再硬编码系列名)。 */
export interface FamilySummary {
    family: Family;
    label: string;
    toolUse: VendorProfile["toolUse"];
    reasoningBlocks: boolean;
}
export declare function familySummaries(): FamilySummary[];
