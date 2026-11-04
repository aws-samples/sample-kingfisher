// @kf-batch 50-W5-seg2-WP8
// 模块 51 — GPT 传输门控(51 SPEC §2 PUT 硬闸 P0-5 / §3.4 补强①–④ / §6.3 本波范围)。
//
// 两个函数,**故意分开**:
//   · `gptTransportReady()` —— PUT /model-config 硬闸读的那个。🔴 **本波恒返 false,不读 DDB**
//     (SPEC §3.4 补强①「门的代码 / 端点 / DDB 项与 M13 负向测试必须同期」;D9 真探测由主会话在合并后做,
//     探测前 GPT 系列**一个都存不进去**,M13a)。P51.2 探测通过后把它改成 `return readTransportGate()`
//     一行即放开 —— 这是全仓唯一的放行点。
//   · `readTransportGate()` —— 读 `ai-model#__transport` 的真实现(GET /transport 用来呈现现状;
//     5s 短 TTL 独立缓存;>24h 视为失效;**任何异常 ⇒ false,fail-closed**)。
//     它有真调用方(GET /transport),不是「没生产调用方的代码」。
import { getTransport, type TransportItem } from "@/lib/settings/model-store";

export const TRANSPORT_TTL_MS = 5_000;
/** 置位证据的有效期(与探测缓存同 24h;模型可能被吊销 / SCP 变更) */
export const TRANSPORT_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let _cache: { item: TransportItem | null; at: number } | null = null;

export function _resetTransportCacheForTests(): void {
  _cache = null;
}

/** 读门控项(带 5s 缓存);异常 ⇒ null(调用方按 fail-closed 处理)。 */
export async function readTransportItem(now = Date.now()): Promise<TransportItem | null> {
  if (_cache && now - _cache.at < TRANSPORT_TTL_MS) return _cache.item;
  try {
    const item = await getTransport();
    _cache = { item, at: now };
    return item;
  } catch (e) {
    console.warn(`[transport-gate] 读 __transport 失败(fail-closed): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** 纯函数:一个门控项现在算不算「已放开」。 */
export function transportItemReady(item: TransportItem | null | undefined, now = Date.now()): boolean {
  if (!item || item.gptReady !== true) return false;
  if (typeof item.probedAt !== "number" || !item.probeModelId) return false;
  if (now - item.probedAt > TRANSPORT_EVIDENCE_MAX_AGE_MS) return false;
  return true;
}

/** 真实现:读 DDB 项判定(fail-closed)。 */
export async function readTransportGate(now = Date.now()): Promise<boolean> {
  try {
    return transportItemReady(await readTransportItem(now), now);
  } catch {
    return false;
  }
}

/**
 * 🔴 PUT /model-config 硬闸读的门。**P51.1/本波恒 false**,不读任何 flag / env / DDB。
 * 放开条件与步骤见文件头注释;门禁单测 (e) 钉住「恒 false」。
 */
export async function gptTransportReady(): Promise<boolean> {
  return false;
}
