import { type InferenceField } from "./vendors";
export interface InferenceConfigLike {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
}
/** Bedrock 原话(2026-10-14 实测 Kimi K3 / GLM 5):「This model doesn't support the temperature field. Remove temperature and try again.」 */
export declare const UNSUPPORTED_FIELD_RE: RegExp;
/**
 * 从一次失败里学「该模型不支持某字段」。命中 ⇒ 记住并返回字段名(调用方据此同层重试一次);否则 null。
 * 只认 Bedrock 的这句原话,别的 ValidationException 一律不学、不重试(那是请求真写错了)。
 */
export declare function learnUnsupportedField(modelId: string, err: unknown): InferenceField | null;
export declare function learnedUnsupportedFields(modelId: string): InferenceField[];
/** 仅供单测。 */
export declare function _resetLearnedForTests(): void;
export interface ShapeResult<T extends InferenceConfigLike | undefined> {
    config: T;
    /** 这次剥掉了哪些字段(供 `_meta.shaped` / 日志;空 = 原样) */
    stripped: InferenceField[];
    /** maxTokens 是否被系数放大 */
    boosted: boolean;
}
/**
 * 整形一份 inferenceConfig:剥掉档案 / 学习里标为不支持的字段,maxTokens 乘系数。
 * 未知系列(档案没有的厂商)⇒ 只应用学习结果、系数 1。cfg 为空 ⇒ 原样返回。
 */
export declare function shapeInferenceConfig<T extends InferenceConfigLike | undefined>(modelId: string, cfg: T): ShapeResult<T>;
/** 对一份 Converse 入参(含 modelId 与 inferenceConfig)整形;只动 inferenceConfig,其余字段原引用。 */
export declare function shapeConverseInput<T extends {
    modelId?: string;
    inferenceConfig?: InferenceConfigLike;
}>(input: T): {
    input: T;
    stripped: InferenceField[];
    boosted: boolean;
};
