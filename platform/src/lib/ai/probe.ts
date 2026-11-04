// @kf-batch 50-W5-seg2-WP8
// 模块 51 — 模型探测器(51 SPEC §3.2;DESIGN D5「ACTIVE 不可信,保存前必须真 invoke」)。
//
//   probeModel(modelId, { place: { targetId, region } })
//     ① tiny invoke:Converse maxTokens=24、超时 = **本系列的探测预算**(vendors.probeTimeoutMs;超时单列 Timeout 类)
//        @kf-batch 51-v2-multi-vendor:8 → 24 —— Kimi K3 恒先出 reasoningContent 块,16 个 token 全被推理吃掉仍是 200,
//        给 24 是为了至少看得见一个块;探测请求同样经 shapeConverseInput(与真调用同一条路,SPEC §7.3)
//     ② 六类错误分类:NotAvailableForAccount(v2.0 新,放最前)/ MarketplaceSCP / AccessDenied / Timeout(v3 新)/ Throttle / NotFound
//        (classifyProbeError,净新;git 4fe5c28 只换了默认模型没留分类)
//     ③ toolUseOk:厂商档案 `toolUse:"probe"` 的系列(GPT / GLM 5 / Kimi K3)再探一次「Converse 下 tool-use 是否可用」
//        (D9 / D11 分支判据);anthropic 系现状即支持 ⇒ true。**与 ① 并行发**(墙钟 ≈ max 而不是和),二探失败的分类记在 toolUseError
//     ④ quotaHint:best-effort。Bedrock 无实时余量 API(Service Quotas 只给已配额值),本仓也不引 ServiceQuotas SDK
//        ⇒ 恒 "unknown",**绝不阻断保存**;冷悬崖真实防线是 invoke.ts 的运行期退避 + 降级(P2-2)
//     ⑤ 写探测缓存 `ai-model#probe#<targetId>#<modelId>`(store 坏了静默跳过)
//
// @kf-batch 51-v3-probe-budget(序 46 / B-106,2026-10-20 临时账号真测):
//   原来两探串行、各 10s、超时归 Throttle。Kimi K3 的 tiny invoke / tool-use 探测 8 次采样 3.0–39.4s(us. / global. 都抖),
//   10s 下 5 次超时 ⇒ 页面「测试该模型」时而「探测通过 · tool-use 不可用」(二探超时被记成不支持工具)、时而保存路由二次探测超时
//   ⇒ 「探测被限流,请稍候重试」(其实不是限流)。改法三件:预算按系列(Kimi 45s)· 两探并行(墙钟留在 ALB 60s 内)·
//   超时单列 Timeout(处方「稍候重试 / 换推理配置」,不冒充限流);保存路由另认 10 分钟内同区通过的探测缓存(isFreshProbe),不再二次探。
//
// 🔴 探测会烧真 Bedrock:调用面只有 PUT /model-config(保存前强制;有新鲜缓存则免)与 POST /probe(限频 6/min)。
//    单测用 deps.send 注入假客户端,零真 invoke。
// @kf-batch 50-WP31-place-first-class —— 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandInput, type ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type { Place } from "@/lib/place/types";
import { putProbe, type ProbeCacheItem } from "@/lib/settings/model-store";
import type { ProbeError, ProbeOk, ProbeResult } from "./capabilities";
// @kf-batch 51-v2-multi-vendor —— 二探与否看厂商档案;探测请求也走整形(单一通道)
import { vendorOf } from "./core/vendors";
import { shapeConverseInput } from "./core/converse-shape";

export const PROBE_MAX_TOKENS = 24;
/** 没有厂商档案的 id(理论上进不了目录)用的保底预算 */
export const PROBE_TIMEOUT_MS = 10_000;
/** 保存路由认「新鲜」探测缓存的窗口:页面「测试该模型」后 10 分钟内保存,不再二次探(51 SPEC §6.1① 的 ProbeOk 仍由这条通过的探测供给) */
export const PROBE_FRESH_MS = 10 * 60_000;

/** 探测预算(ms)**唯一取法**:厂商档案 probeTimeoutMs;无档案 ⇒ PROBE_TIMEOUT_MS。 */
export function probeTimeoutMsFor(modelId: string): number {
  return vendorOf(modelId)?.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
}

export interface ProbeDeps {
  /** 注入点:默认按 region 建 BedrockRuntimeClient 真发;单测传假 send */
  send?: (cmd: ConverseCommand, opts?: { abortSignal?: AbortSignal }) => Promise<ConverseCommandOutput>;
  now?: () => number;
  /** 是否写探测缓存(默认写) */
  persist?: boolean;
}

const _clients = new Map<string, BedrockRuntimeClient>();
function clientFor(region: string): BedrockRuntimeClient {
  let c = _clients.get(region);
  if (!c) {
    c = sdkClient("model", BedrockRuntimeClient, { region });
    _clients.set(region, c);
  }
  return c;
}

function errName(e: unknown): string {
  return (e && typeof e === "object" && typeof (e as { name?: unknown }).name === "string" ? (e as { name: string }).name : "") || "";
}
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message || "";
  return typeof e === "string" ? e : String((e as { message?: unknown })?.message ?? e ?? "");
}
function httpStatus(e: unknown): number | undefined {
  return (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

/**
 * 六类分类(顺序有意:
 *   · 「not available for this account」的报错本体也是 AccessDeniedException,且含 "not available" —— 不先判它就会被
 *     AccessDenied / NotFound 吞掉,而它的处方(找 AWS 账号团队开通)与那两类完全不同(51 SPEC §7.3,2026-10-14 实测 zai.glm-5.3);
 *   · Marketplace/SCP 的报错本体通常也是 AccessDeniedException,必须先于 AccessDenied,
 *     否则 INTERACTION 场景二那条「你的账号策略禁止订阅第三方模型」的友好文案永远出不来;
 *   · Timeout(本地 AbortSignal.timeout 抛的 TimeoutError / AbortError,或 SDK 的 timed out)先于 Throttle:
 *     它是「预算内没等到」,与 Bedrock 限流(ThrottlingException / 429)处方不同)。
 */
export function classifyProbeError(e: unknown): ProbeError {
  const name = errName(e);
  const msg = errMsg(e);
  const status = httpStatus(e);
  if (/is not available for this account|contact AWS Sales/i.test(msg)) return "NotAvailableForAccount";
  if (/marketplace|subscri|explicit deny|organizations|service control polic|\bSCP\b/i.test(msg)) return "MarketplaceSCP";
  if (name === "AccessDeniedException" || /access ?denied|not authorized|is not authorized/i.test(msg) || status === 403) return "AccessDenied";
  if (name === "AbortError" || name === "TimeoutError" || /timed? ?out|aborted due to timeout/i.test(msg)) return "Timeout";
  if (
    name === "ThrottlingException" ||
    name === "ServiceUnavailableException" ||
    name === "ModelNotReadyException" ||
    name === "TooManyRequestsException" ||
    status === 429 ||
    status === 503 ||
    /throttl|too many requests|rate exceeded/i.test(msg)
  ) {
    return "Throttle";
  }
  if (
    name === "ResourceNotFoundException" ||
    name === "ValidationException" ||
    status === 404 ||
    /not (be )?(found|available|supported)|isn'?t supported|invalid model|model identifier|does not exist|doesn'?t exist/i.test(msg)
  ) {
    return "NotFound";
  }
  // 未知错误:归到 NotFound(文案「此模型在当前 region 不可用」是对未知失败最不误导的一类),errorDetail 带原文。
  return "NotFound";
}

function tinyCommand(modelId: string): ConverseCommand {
  const input: ConverseCommandInput = {
    modelId,
    messages: [{ role: "user", content: [{ text: "ping" }] }],
    inferenceConfig: { maxTokens: PROBE_MAX_TOKENS },
  };
  return new ConverseCommand(shapeConverseInput(input).input);
}

/** toolUse:"probe" 系列(GPT / GLM 5 / Kimi K3)的 tool-use 探测:给一个无害工具并强制调用,看 Converse 能否产出 toolUse 块。 */
function toolUseCommand(modelId: string): ConverseCommand {
  const input: ConverseCommandInput = {
    modelId,
    messages: [{ role: "user", content: [{ text: "请调用 ping_tool,text 参数填 pong。" }] }],
    toolConfig: {
      tools: [
        {
          toolSpec: {
            name: "ping_tool",
            description: "回显输入文本(探测用,无副作用)",
            inputSchema: { json: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
          },
        },
      ],
      toolChoice: { any: {} },
    },
    inferenceConfig: { maxTokens: 64 },
  };
  return new ConverseCommand(shapeConverseInput(input).input);
}

function hasToolUse(resp: ConverseCommandOutput): boolean {
  if (resp.stopReason === "tool_use") return true;
  return (resp.output?.message?.content || []).some((b) => "toolUse" in b && !!b.toolUse);
}

/**
 * 探测缓存是否「新鲜且可直接供保存使用」(保存路由用;51 SPEC §3.3 ④′):
 *   同一 targetId 下、probeOk === true、probedAt 在 PROBE_FRESH_MS 内;档案 toolUse:"probe" 的系列还要 toolUseOk === true。
 * 返回可直接写库的 ProbeOk,否则 null(⇒ 保存路由自己再探一次)。
 */
export function freshProbeFromCache(
  cache: ProbeCacheItem | null | undefined,
  modelId: string,
  now = Date.now(),
  freshMs = PROBE_FRESH_MS
): ProbeOk | null {
  if (!cache || cache.modelId !== modelId || cache.probeOk !== true) return null;
  if (typeof cache.probedAt !== "number" || now - cache.probedAt > freshMs || cache.probedAt > now + 60_000) return null;
  if (vendorOf(modelId)?.toolUse === "probe" && cache.toolUseOk !== true) return null;
  return {
    ok: true,
    toolUseOk: cache.toolUseOk ?? true,
    quotaHint: cache.quotaHint ?? "unknown",
    probedAt: cache.probedAt,
  };
}

/**
 * 真探测。返回值同时写进探测缓存(带 targetId 维;P0-8)。
 * 🔴 本函数**不抛**:任何失败都归成 `{ ok:false, error, errorDetail }`。
 */
// @kf-batch 50-WP31-place-first-class —— B-35 同形:🔴 原来 `targetId || HOME_TARGET_ID` + `region || process.env.AWS_REGION`
//   ⇒ 只传 targetId 时探的是主控区、缓存却记在那个 target 名下(张冠李戴:在别的区判 available)。落点必填,region 只从落点来。
export async function probeModel(
  modelId: string,
  opts: { place: Pick<Place, "targetId" | "region">; deps?: ProbeDeps }
): Promise<ProbeResult> {
  const { targetId, region } = opts.place;
  const now = opts.deps?.now ?? Date.now;
  const send =
    opts.deps?.send ??
    ((cmd: ConverseCommand, o?: { abortSignal?: AbortSignal }) => clientFor(region).send(cmd, o));
  const persist = opts.deps?.persist ?? true;
  const budgetMs = probeTimeoutMsFor(modelId);
  const startedAt = now();

  let result: ProbeResult;
  try {
    // ① 与 ③ 并行:各自独立预算;tiny 失败 ⇒ 整体失败(二探结论不再有意义);二探失败只记 toolUseOk=false + toolUseError
    const tiny = send(tinyCommand(modelId), { abortSignal: AbortSignal.timeout(budgetMs) });
    const needToolUse = vendorOf(modelId)?.toolUse === "probe";
    const second: Promise<{ ok: boolean; error?: ProbeError }> = needToolUse
      ? send(toolUseCommand(modelId), { abortSignal: AbortSignal.timeout(budgetMs) })
          .then((r) => ({ ok: hasToolUse(r) }))
          .catch((e: unknown) => {
            console.warn(`[probe] ${modelId} tool-use 探测失败(按 toolUseOk=false 记,分类 ${classifyProbeError(e)}): ${errMsg(e).slice(0, 200)}`);
            return { ok: false, error: classifyProbeError(e) };
          })
      : Promise.resolve({ ok: true });
    // tiny 抛时也要等二探收尾(不留悬空 promise 的 unhandled rejection;它自身已 catch)
    const [, tool] = await Promise.all([tiny, second]);
    result = {
      ok: true,
      toolUseOk: tool.ok,
      ...(tool.error ? { toolUseError: tool.error } : {}),
      quotaHint: "unknown",
      probedAt: now(),
      elapsedMs: Math.max(0, now() - startedAt),
    };
  } catch (e) {
    result = {
      ok: false,
      error: classifyProbeError(e),
      errorDetail: `${errName(e)}: ${errMsg(e)}`.slice(0, 500),
      probedAt: now(),
      elapsedMs: Math.max(0, now() - startedAt),
    };
  }
  if (persist) await putProbe(targetId, modelId, result, result.probedAt);
  return result;
}
