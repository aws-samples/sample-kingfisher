// 平台 AI 默认模型 —— 运行时侧出口(SSOT re-export)。
//
// 唯一真源是 repo 根 `ai-model.json`(见其 $comment)。本文件是它在【运行时侧(platform/Next.js)】
// 的出口:全平台 AI 能力(GenBI/Copilot/网络顾问/参数顾问 + 下游 Flink SQL 生成/需求 codegen/检索)
// 的默认 modelId 都经 `DEFAULT_MODEL_ID` 追溯到那一个 json。运行时仍可用 env `BEDROCK_MODEL_ID` 覆盖。
//
// 为什么 import json 而非 readFileSync:resolveJsonModule 已开,bundler 把 json 内联进 bundle,
// 零运行时文件读取——比 readFileSync 在 Next standalone 输出下更安全(无 __dirname/cwd 漂移风险)。
// 部署期侧(infra/CDK)另有 `infra/lib/shared/model.ts` 读同一 json(ts-node 用 readFileSync),
// 二者跨构建边界物理隔离,但同源同值。
// ⚠️ json 必须在 platform/ 内(而非 repo 根):platform Docker 构建上下文 = fromAsset("../platform"),
// Dockerfile COPY . . 只拷 platform 目录;放 repo 根会 Next build 报 Module not found(已踩)。
import modelConfig from "../../../ai-model.json";
// @kf-batch 50-W5-seg2-WP8 — 模块 51:运行时解析链(bgp-settings → env → SSOT)。
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { getModelSetting, getVersion } from "@/lib/settings/model-store";
import type { Capability, SourceLayer } from "./capabilities";

/** 平台默认大模型 id(唯一真源 ai-model.json)。 */
export const DEFAULT_MODEL_ID: string = modelConfig.defaultModelId;

/** 解析生效的 modelId:env 覆盖优先,否则用 SSOT 默认值。所有消费方都应经此,勿再硬编码。 */
export const resolveModelId = (): string => process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID;

// ═══════════════════════════════════════════════════════════════════════════════
// @kf-batch 50-W5-seg2-WP8 — 模块 51 运行时解析链(51 SPEC §3.1 / §3.1a / §6.1② / §6.2①②③)
//
// 三层:① bgp-settings 运行时配置(页面可改,秒级生效)→ ② env BEDROCK_MODEL_ID → ③ SSOT。
// ① 为空时与上面同步 `resolveModelId()` **逐字节等价**(D2 零迁移 / 可回滚)。
//
// 缓存三件:
//   _cache    Map<scopeKey, {modelId, source, ver, at}>   配置项 60s TTL + 与 `__version` 比对主动失活
//   _lastGood Map<scopeKey, {modelId, at}>                 兜底:配置面读失败时沿用,来源标 `runtime-stale`
//   _verCache {ver, at}                                    `__version` 独立 5s 短 TTL(P0-1:不让每次 AI 调用打单热分区)
//
// 🔴 scopeKey 从第一行按 `<targetId>#<capability>` 定形(SPEC §6.2①:Map 而非单例;一期 targetId 恒 tgt_home、
//    capability 恒 global-等价,但两个形参都**真接上**);deriveScope() 一期恒返 "global" ⇒ 一期写入 sk 仍是 ai-model#global。
// 🔴 热路径**绝不抛**:任何异常 ⇒ last-good ⇒ env ⇒ SSOT(P1-1:配置面故障不比现状差)。
// ═══════════════════════════════════════════════════════════════════════════════

export type { Capability, SourceLayer } from "./capabilities";

export const MODEL_CACHE_TTL_MS = 60_000;
export const VERSION_TTL_MS = 5_000;

export interface ResolvedModel {
  modelId: string;
  source: SourceLayer;
  /** source === "runtime-stale" 时 true(GET /model-config 的 effective[].stale) */
  stale?: boolean;
}

interface CacheHit extends ResolvedModel {
  ver: number;
  at: number;
}

const _cache = new Map<string, CacheHit>();
const _lastGood = new Map<string, { modelId: string; at: number }>();
let _verCache = { ver: 0, at: 0 };

/** 仅供单测。 */
export function _resetModelCacheForTests(): void {
  _cache.clear();
  _lastGood.clear();
  _verCache = { ver: 0, at: 0 };
}

/** 仅供单测 / 门禁:窥视缓存键(M18:第二个 targetId 不共用同一条目)。 */
export function _cacheKeysForTests(): string[] {
  return Array.from(_cache.keys());
}

/**
 * 逻辑 scope(决定读哪条 sk)。🔴 一期恒 "global"(DESIGN D3:9 能力全走全局默认;D8:per-target 二期 P51.3)。
 * 两个形参**都真接**:P51.3 / P51.4 只改这一处(`<targetId>#global` / `<capability>`)。
 */
export function deriveScope(capability?: Capability, targetId?: string): string {
  void capability;
  void targetId;
  return "global";
}

/** 缓存键(与 scope 分开:scope 是「读哪条 sk」,scopeKey 是「哪个 target × 哪个能力的进程内缓存」)。 */
export function scopeKeyOf(capability?: Capability, targetId?: string): string {
  return `${targetId || HOME_TARGET_ID}#${capability ?? "global"}`;
}

/** `__version` 5s 短 TTL 读取(冷表 0)。抛出交给调用方兜底。 */
export async function readVersionCached(now = Date.now()): Promise<number> {
  if (now - _verCache.at < VERSION_TTL_MS) return _verCache.ver;
  const ver = await getVersion();
  _verCache = { ver, at: now };
  return ver;
}

/**
 * 三处共用的「解析 + 报告命中层」原语(51 SPEC §3.1a):resolveModelRuntime / GET model-config / DELETE 的 fellBackTo。
 * 会抛(DDB 异常)—— 由 `resolveModelRuntime` 兜底,路由层按需 catch。
 */
export async function resolveWithProvenance(scope: string, targetId?: string): Promise<ResolvedModel> {
  const item =
    (await getModelSetting(scope)) ??
    // 二期 per-target scope miss ⇒ 回落全局(一期 scope 恒 "global",此分支不触发)。
    (targetId && scope !== "global" ? await getModelSetting("global") : null);
  if (item?.modelId) return { modelId: item.modelId, source: "runtime" };
  if (process.env.BEDROCK_MODEL_ID) return { modelId: process.env.BEDROCK_MODEL_ID, source: "env" };
  return { modelId: DEFAULT_MODEL_ID, source: "ssot" };
}

/** env / SSOT 两层的纯本地回落(不打库)。 */
function localFallback(): ResolvedModel {
  if (process.env.BEDROCK_MODEL_ID) return { modelId: process.env.BEDROCK_MODEL_ID, source: "env" };
  return { modelId: DEFAULT_MODEL_ID, source: "ssot" };
}

/**
 * 带来源的运行时解析(热路径;**绝不抛**)。
 *   命中缓存(ver 一致且未过 60s)⇒ 直接返回;否则重解析并更新 cache + lastGood。
 *   配置面异常 ⇒ lastGood(来源 `runtime-stale`, stale:true)⇒ env ⇒ SSOT。
 */
export async function resolveModelRuntime(capability?: Capability, targetId?: string, now = Date.now()): Promise<ResolvedModel> {
  const scope = deriveScope(capability, targetId);
  const key = scopeKeyOf(capability, targetId);
  try {
    const ver = await readVersionCached(now);
    const hit = _cache.get(key);
    if (hit && hit.ver === ver && now - hit.at < MODEL_CACHE_TTL_MS) {
      return { modelId: hit.modelId, source: hit.source };
    }
    const r = await resolveWithProvenance(scope, targetId);
    _cache.set(key, { ...r, ver, at: now });
    _lastGood.set(key, { modelId: r.modelId, at: now });
    return r;
  } catch (e) {
    // 🔴 P0-1 韧性:配置读取子系统故障【绝不】拖垮 AI 主功能。
    const lg = _lastGood.get(key);
    if (lg) {
      console.warn(`[ai-model] 配置面读取失败,沿用 last-good(${lg.modelId}): ${e instanceof Error ? e.message : String(e)}`);
      return { modelId: lg.modelId, source: "runtime-stale", stale: true };
    }
    console.warn(`[ai-model] 配置面读取失败且无 last-good,回落 env/SSOT: ${e instanceof Error ? e.message : String(e)}`);
    return localFallback();
  }
}

/** 只要 modelId 的便捷形态(51 SPEC §3.1 签名)。 */
export async function resolveModelIdRuntime(capability?: Capability, targetId?: string): Promise<string> {
  return (await resolveModelRuntime(capability, targetId)).modelId;
}

/**
 * 有序去重的候选层(51 SPEC §3.5 `resolveLayered`):[runtime?, env?, ssot]。
 * `invokeWithFallback` 限流 / 不可用时沿此回落到下一层模型。首层即 `resolveModelRuntime` 的结果
 * (含 runtime-stale),因此降级链与实际解析一致。
 */
export async function resolveLayered(capability?: Capability, targetId?: string): Promise<ResolvedModel[]> {
  const primary = await resolveModelRuntime(capability, targetId);
  const layers: ResolvedModel[] = [primary];
  const push = (r: ResolvedModel) => {
    if (!layers.some((l) => l.modelId === r.modelId)) layers.push(r);
  };
  if (process.env.BEDROCK_MODEL_ID) push({ modelId: process.env.BEDROCK_MODEL_ID, source: "env" });
  push({ modelId: DEFAULT_MODEL_ID, source: "ssot" });
  return layers;
}

// ── 格式校验(51 SPEC §2 正则 + §6.2③ region 钩子)───────────────────────────────

/** 廉价预筛正则(短 id / inference profile id;**拒 ARN**,P1-3 有意为之)。 */
// @kf-batch 50-PROD-A-launch-hardening(h):地理前缀按形态收(us-gov. / jp. / au. … 都是 Bedrock 真实存在的),
//   不再只认四个 —— 只认四个 ⇒ 主控区放在日本 / GovCloud 时,该区唯一可用的推理配置被当成「格式非法」拒掉。
export const MODEL_ID_REGEX = /^([a-z]+(?:-[a-z]+)*\.)?[a-z]+\.[a-z0-9.:-]+$/;

/**
 * modelId 格式是否合法。`region` 钩子一期缺省不判;P51.3 在此填实
 * 「`us.` 推理配置在非 US region 必炸」的判据(50 R10 P0)。
 */
export function isModelIdFormatValid(modelId: string, opts: { region?: string } = {}): boolean {
  if (typeof modelId !== "string" || modelId.length < 5 || modelId.length > 200) return false;
  if (!MODEL_ID_REGEX.test(modelId)) return false;
  if (opts.region) {
    // P51.3 填实:例如 us.* profile 只能在 us-* region 调用。一期不启用,只留钩子(避免误伤现网 us.* 配置)。
    void opts.region;
  }
  return true;
}
