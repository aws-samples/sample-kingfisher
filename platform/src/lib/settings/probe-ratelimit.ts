// @kf-batch 50-W5-seg2-WP8
// 模块 51 — probe 限频(51 SPEC §3.4a 卡点④:6 次 / 分钟 / 管理员)。
//
// 形状照房内 `data-service/ratelimit.ts` 的固定窗口计数(**不 import 它** —— B 流正在删整个
// `lib/data-service`;这里按合同自实现同一形状):
//   · sk = `ratelimit#probe#<adminSub>#m#<floor(epochSec/60)>`(与 `windowBuckets` 的 m#<bucket> 同形)
//   · **一次** `UpdateItem`:`ADD #c :one SET #ttl = if_not_exists(#ttl, :ttl)` + `ReturnValues:"UPDATED_NEW"`
//     原子读回新值判超限(分开两次调用有竞态,SPEC 明确否决)
//   · `ttl` = epoch **秒**(5min),表级 TTL 自动清理 —— 这是 `bgp-settings` 里**唯一**允许带 ttl 的项
//   · 超限 ⇒ 429 `{ error:"RateLimited", retryAfterSec }`
//   · 🔴 store 出错 ⇒ **fail-closed 返「拒绝」**(probe 会烧真 Bedrock,宁拒不放;51 SPEC §3.4a④)
//
// demo 模式(Cognito 未配)下 adminSub = LEGACY_PARTITION 常量 ⇒ 限频塌缩成全平台共享一个桶(可接受,合同已记)。
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { SETTINGS_PK } from "./model-store";

export const PROBE_RATE_LIMIT_PER_MINUTE = 6;
const TTL_SECONDS = 5 * 60;

export interface ProbeRateDecision {
  allowed: boolean;
  /** 本窗口内已消费次数(含本次) */
  count: number;
  limit: number;
  retryAfterSec?: number;
  /** fail-closed 时带上原因,便于 wiring / 日志定位 */
  reason?: "over-limit" | "store-error";
}

/** 纯函数:窗口 bucket(便于单测钉窗口) */
export function probeMinuteBucket(epochSec: number): number {
  return Math.floor(epochSec / 60);
}

/** 纯函数:限频计数项的 sk。 */
export function probeRateLimitSk(adminSub: string, epochSec: number): string {
  if (!adminSub) throw new Error("限频键必须带 adminSub");
  return `ratelimit#probe#${adminSub}#m#${probeMinuteBucket(epochSec)}`;
}

/**
 * 消费一次 probe 配额。epochSec 由调用方传入(便于测试 / 避免散落 Date.now)。
 * 🔴 任何 store 异常 ⇒ `{ allowed:false, reason:"store-error" }`(fail-closed)。
 */
export async function consumeProbeQuota(
  adminSub: string,
  epochSec: number,
  limit = PROBE_RATE_LIMIT_PER_MINUTE
): Promise<ProbeRateDecision> {
  const retryAfterSec = 60 - (epochSec % 60);
  try {
    const res = await docClient.send(
      new UpdateCommand({
        TableName: TABLES.SETTINGS,
        Key: { pk: SETTINGS_PK, sk: probeRateLimitSk(adminSub, epochSec) },
        UpdateExpression: "ADD #c :one SET #ttl = if_not_exists(#ttl, :ttl)",
        ExpressionAttributeNames: { "#c": "count", "#ttl": "ttl" },
        ExpressionAttributeValues: { ":one": 1, ":ttl": epochSec + TTL_SECONDS },
        ReturnValues: "UPDATED_NEW",
      })
    );
    const count = Number((res.Attributes as { count?: number } | undefined)?.count ?? NaN);
    if (!Number.isFinite(count)) {
      // 读不回计数 = 无法证明未超限 ⇒ 拒绝。
      return { allowed: false, count: 0, limit, retryAfterSec, reason: "store-error" };
    }
    if (count > limit) return { allowed: false, count, limit, retryAfterSec, reason: "over-limit" };
    return { allowed: true, count, limit };
  } catch (e) {
    console.warn(`[probe-ratelimit] 计数器写失败,fail-closed 拒绝: ${e instanceof Error ? e.message : String(e)}`);
    return { allowed: false, count: 0, limit, retryAfterSec, reason: "store-error" };
  }
}
