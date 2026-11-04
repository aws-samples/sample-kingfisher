// **Converse 请求整形(唯一作者)**:按厂商档案剥掉该系列不支持的 inferenceConfig 字段、放大 maxTokens;
// 运行期再从 Bedrock 的 ValidationException 原话里**学**到档案没记的字段(51 DESIGN §12 D12;SPEC §7.2)。
//
// 🔴 只减字段、只放大 maxTokens,绝不增字段、不改消息体;对 Claude 系列必须是恒等(单测钉住)。
// 🔴 零 `@/`、零 SDK:处理的是纯对象(ConverseCommandInput 的 inferenceConfig 形态),容器与平台共用(core-dist/ai)。
// 🔴 「学到的不支持字段」挂 globalThis(Symbol.for):Next 产物里同一源文件会有多个模块实例,模块级 Map 会互相看不见
//    (记忆 next-bundle-duplicate-module-instances);进程重启即忘 —— 档案是底线,学习只是补洞。
import { INFERENCE_FIELDS, vendorOf, type InferenceField } from "./vendors";

export interface InferenceConfigLike {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
}

/** Bedrock 原话(2026-10-14 实测 Kimi K3 / GLM 5):「This model doesn't support the temperature field. Remove temperature and try again.」 */
export const UNSUPPORTED_FIELD_RE = /doesn't support the (temperature|topP|stopSequences) field/i;

const LEARNED_KEY = Symbol.for("kf.ai.converse-shape.learnedUnsupportedFields");
type LearnedMap = Map<string, Set<InferenceField>>;
function learnedMap(): LearnedMap {
  const g = globalThis as unknown as Record<symbol, LearnedMap | undefined>;
  let m = g[LEARNED_KEY];
  if (!m) {
    m = new Map();
    g[LEARNED_KEY] = m;
  }
  return m;
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message || "";
  if (typeof e === "string") return e;
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : "";
}

/**
 * 从一次失败里学「该模型不支持某字段」。命中 ⇒ 记住并返回字段名(调用方据此同层重试一次);否则 null。
 * 只认 Bedrock 的这句原话,别的 ValidationException 一律不学、不重试(那是请求真写错了)。
 */
export function learnUnsupportedField(modelId: string, err: unknown): InferenceField | null {
  const m = UNSUPPORTED_FIELD_RE.exec(errMessage(err));
  if (!m) return null;
  const field = m[1] as InferenceField;
  const map = learnedMap();
  const set = map.get(modelId) ?? new Set<InferenceField>();
  set.add(field);
  map.set(modelId, set);
  return field;
}

export function learnedUnsupportedFields(modelId: string): InferenceField[] {
  return Array.from(learnedMap().get(modelId) ?? []);
}

/** 仅供单测。 */
export function _resetLearnedForTests(): void {
  learnedMap().clear();
}

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
export function shapeInferenceConfig<T extends InferenceConfigLike | undefined>(modelId: string, cfg: T): ShapeResult<T> {
  if (!cfg) return { config: cfg, stripped: [], boosted: false };
  const v = vendorOf(modelId);
  const learned = learnedMap().get(modelId);
  const out: InferenceConfigLike = { ...cfg };
  const stripped: InferenceField[] = [];
  for (const f of INFERENCE_FIELDS) {
    if (!(f in out) || out[f] === undefined) continue;
    if ((v && !v.inferenceFields[f]) || learned?.has(f)) {
      delete out[f];
      stripped.push(f);
    }
  }
  let boosted = false;
  if (v && v.maxTokensFactor !== 1 && typeof out.maxTokens === "number" && out.maxTokens > 0) {
    out.maxTokens = Math.round(out.maxTokens * v.maxTokensFactor);
    boosted = true;
  }
  return { config: out as T, stripped, boosted };
}

/** 对一份 Converse 入参(含 modelId 与 inferenceConfig)整形;只动 inferenceConfig,其余字段原引用。 */
export function shapeConverseInput<T extends { modelId?: string; inferenceConfig?: InferenceConfigLike }>(
  input: T
): { input: T; stripped: InferenceField[]; boosted: boolean } {
  const modelId = input.modelId || "";
  const r = shapeInferenceConfig(modelId, input.inferenceConfig);
  if (!r.stripped.length && !r.boosted) return { input, stripped: [], boosted: false };
  return { input: { ...input, inferenceConfig: r.config }, stripped: r.stripped, boosted: r.boosted };
}
