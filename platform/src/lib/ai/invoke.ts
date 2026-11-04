// @kf-batch 50-W5-seg2-WP8
// 模块 51 — `invokeWithFallback`(51 SPEC §3.5;P0-3 Throttle 退避 + P0-4 冷悬崖降级的**唯一归宿**)。
//
// 9 个消费点统一走它。两形态(SPEC §3.5 v1.1):
//   形态① 命令型 `invokeConverse(...)` —— 8 个 ConverseCommand 点(可注入 command,单元=一次 send)
//   形态② agent 型 `invokeAgent(...)`  —— Strands planner(SDK 内部自建 client,无法注入 command
//                                        ⇒ 整个 agent.invoke 作为可重试单元;⚠️ 重试 = 重跑整个多轮 tool 循环,
//                                        planner 工具只读幂等,可接受)
// 两者都是 `invokeWithFallback` 的薄壳,核心语义只写一份:
//   · 候选层 = resolveLayered(capability, targetId) → [runtime?, env?, ssot] 去重(可传 opts.layers 复用循环外求值结果)
//   · 每层最多 MAX_RETRY=2 次重试,指数退避 base 200ms(200 / 400)
//   · 限流 ⇒ 退避重试;仍限流 / 不可用 ⇒ **降级回落下一层模型**;非限流类错误 ⇒ 原样抛给调用方
//   · abortSignal 已触发的 AbortError ⇒ 立即抛(不重试不降级,守 300s 天花板语义)
//   · 返回 `{ response, usedModelId, usedSource, attempts, degraded }` —— `_meta` 回显的是**实际用的**,不是打算用的
//   · `FAULT_THROTTLE_MODEL` seam(fault-seam.ts):armed 且 modelId 命中 ⇒ 强制抛 ThrottlingException(M9)
//   · @kf-batch 51-v2-multi-vendor(51 SPEC §7.2,D12):`invokeConverse` 是平台侧请求整形的**唯一落点** ——
//     build 出命令后按厂商档案剥掉该系列不支持的 inferenceConfig 字段、放大 maxTokens(Kimi K3 ×2),再 send;
//     catch 里若 Bedrock 原话是「This model doesn't support the X field」⇒ 学到 X,**同层立即重试一次**(这次整形会剥掉 X;
//     不占重试额度、不退避、不降级、只许一次),再走原三分支。对 Claude 系列整形是恒等(单测钉住)。
import type { BedrockRuntimeClient, ConverseCommand, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type { Capability, SourceLayer } from "./capabilities";
import { resolveLayered, type ResolvedModel } from "./model";
import { injectedThrottleError, isThrottleInjected } from "./fault-seam";
import { learnUnsupportedField, shapeInferenceConfig } from "./core/converse-shape";
import type { InferenceField } from "./core/vendors";

export const MAX_RETRY = 2;
export const BACKOFF_BASE_MS = 200;

export interface InvokeOutcome<T> {
  response: T;
  usedModelId: string;
  usedSource: SourceLayer;
  /** 总尝试次数(含成功那次;含「学到不支持字段」的同层重试) */
  attempts: number;
  /** 是否发生了跨层降级(usedModelId ≠ 首层) */
  degraded: boolean;
  /** 成功那次请求被整形剥掉的 inferenceConfig 字段(只 `invokeConverse` 填;空 = 原样发出,字段不出现) */
  shaped?: InferenceField[];
}

export interface InvokeOptions {
  kind?: "command" | "agent";
  /** 循环外求值一次的候选层;不传则内部 resolveLayered */
  layers?: ResolvedModel[];
  maxRetry?: number;
  sleep?: (ms: number) => Promise<void>;
  isThrottle?: (e: unknown) => boolean;
  isUnavailable?: (e: unknown) => boolean;
  env?: NodeJS.ProcessEnv;
  /** 观察钩子(日志 / 测试) */
  onAttempt?: (info: { modelId: string; layer: number; attempt: number; error?: unknown }) => void;
}

function errName(e: unknown): string {
  return (e && typeof e === "object" && typeof (e as { name?: unknown }).name === "string" ? (e as { name: string }).name : "") || "";
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? "");
}
function httpStatus(e: unknown): number | undefined {
  return (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

/** 限流类:Bedrock ThrottlingException / 429 / Strands ModelThrottledError / 文案含 throttl。 */
export function isThrottleError(e: unknown): boolean {
  const n = errName(e);
  if (n === "ThrottlingException" || n === "TooManyRequestsException" || n === "ModelThrottledError") return true;
  if (httpStatus(e) === 429) return true;
  return /throttl|too many requests|rate exceeded/i.test(errMsg(e));
}

/** 不可用类(可降级换层):ServiceUnavailable / ModelNotReady / 503 / 模型被下线(ResourceNotFound)。 */
export function isUnavailableError(e: unknown): boolean {
  const n = errName(e);
  if (n === "ServiceUnavailableException" || n === "ModelNotReadyException" || n === "ResourceNotFoundException") return true;
  const s = httpStatus(e);
  return s === 503 || s === 404;
}

export function isAbortError(e: unknown): boolean {
  const n = errName(e);
  return n === "AbortError" || n === "TimeoutError";
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 核心:沿候选层 × 重试执行 `run(modelId)`。
 * `run` 抛什么就按什么分类;成功即返回并带上实际使用的层。
 */
export async function invokeWithFallback<T>(
  capability: Capability,
  targetId: string | undefined,
  run: (modelId: string) => Promise<T>,
  opts: InvokeOptions = {}
): Promise<InvokeOutcome<T>> {
  const layers = opts.layers ?? (await resolveLayered(capability, targetId));
  if (!layers.length) throw new Error("invokeWithFallback: 候选模型层为空");
  const maxRetry = opts.maxRetry ?? MAX_RETRY;
  const sleep = opts.sleep ?? realSleep;
  const isThrottle = opts.isThrottle ?? isThrottleError;
  const isUnavailable = opts.isUnavailable ?? isUnavailableError;
  const env = opts.env ?? process.env;
  let attempts = 0;

  for (let li = 0; li < layers.length; li++) {
    const { modelId, source } = layers[li];
    let learnRetries = 0; // D12:每层最多一次「学到字段后的同层重试」
    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      attempts++;
      try {
        // 故障注入缝(仅非生产标记 + env 命中该模型时生效;否则永远走不进来)。
        if (isThrottleInjected(modelId, env)) throw injectedThrottleError(modelId);
        const response = await run(modelId);
        opts.onAttempt?.({ modelId, layer: li, attempt });
        return { response, usedModelId: modelId, usedSource: source, attempts, degraded: li > 0 };
      } catch (e) {
        opts.onAttempt?.({ modelId, layer: li, attempt, error: e });
        if (isAbortError(e)) throw e; // 天花板 abort:不重试、不降级
        // D12:Bedrock 说「这个模型不支持 inferenceConfig.X」⇒ 学下来(进程级),同层立刻再跑一次 run(这次整形会剥掉 X);
        //   只许一次、不退避、不降级、不占限流重试额度。学不到(别的 ValidationException)⇒ 照旧原样抛,那是请求真写错了。
        const learned = learnUnsupportedField(modelId, e);
        if (learned && learnRetries < 1) {
          learnRetries++;
          console.warn(`[ai-invoke] ${capability}: ${modelId} 不支持 inferenceConfig.${learned}(Bedrock 原话),已学到并剥掉,同层重试一次`);
          attempt--;
          continue;
        }
        const throttled = isThrottle(e);
        if (throttled && attempt < maxRetry) {
          await sleep(BACKOFF_BASE_MS * 2 ** attempt);
          continue;
        }
        if ((throttled || isUnavailable(e)) && li < layers.length - 1) {
          console.warn(
            `[ai-invoke] ${capability}: ${modelId} ${throttled ? "限流" : "不可用"}(${errName(e) || errMsg(e).slice(0, 80)}),降级回落 ${layers[li + 1].modelId}(${layers[li + 1].source})`
          );
          break; // 下一层
        }
        throw e; // 非限流类 / 最后一层耗尽:交给调用方
      }
    }
  }
  // 不可达:最后一层耗尽时上面已 throw。
  throw new Error("invokeWithFallback: 候选层耗尽");
}

// ── 形态① 命令型(8 个 ConverseCommand 点)──────────────────────────────────────

export async function invokeConverse(
  capability: Capability,
  targetId: string | undefined,
  client: Pick<BedrockRuntimeClient, "send">,
  build: (modelId: string) => ConverseCommand,
  sendOpts: { abortSignal?: AbortSignal } = {},
  opts: InvokeOptions = {}
): Promise<InvokeOutcome<ConverseCommandOutput>> {
  // D12 平台侧整形唯一落点:build 之后、send 之前,按厂商档案(+ 运行期学到的)剥字段 / 放大 maxTokens;只动 inferenceConfig。
  let lastShaped: InferenceField[] = [];
  const out = await invokeWithFallback(
    capability,
    targetId,
    (modelId) => {
      const cmd = build(modelId);
      const r = shapeInferenceConfig(modelId, cmd.input.inferenceConfig);
      if (r.stripped.length || r.boosted) cmd.input.inferenceConfig = r.config;
      lastShaped = r.stripped;
      return client.send(cmd, sendOpts) as Promise<ConverseCommandOutput>;
    },
    { ...opts, kind: "command" }
  );
  return lastShaped.length ? { ...out, shaped: lastShaped } : out;
}

// ── 形态② agent 型(Strands planner / 容器)──────────────────────────────────────

/**
 * 整个 agent 调用作为可重试单元。⚠️ 幂等约束:重试会重跑整个多轮 tool 循环 ——
 * 调用方必须保证工具只读幂等(planner 满足);有副作用的 agent 只许 `maxRetry:0`(退避不降级由调用方决定)。
 */
export async function invokeAgent<T>(
  capability: Capability,
  targetId: string | undefined,
  runAgent: (modelId: string) => Promise<T>,
  opts: InvokeOptions = {}
): Promise<InvokeOutcome<T>> {
  return invokeWithFallback(capability, targetId, runAgent, { ...opts, kind: "agent" });
}
