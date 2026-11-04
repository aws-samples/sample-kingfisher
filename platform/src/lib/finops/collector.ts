// L1 成本采集器:Cost Explorer 按服务 × 区 × 日 → bgp-cost-daily(v2 分区)。
// CE 数据 T+1 且账单可能迟到,故每次采集近 N 日滚动重采(幂等 upsert 覆盖旧值)。
// 触发:页面 stale 检测 detached + 手动「立即采集」;绝不在读路径同步跑(43-A 二期教训)。
//
// 写 v2 分区 `costv2#<month>`、sk `<date>#<service>#<region>`。
// 🔴 **不再删除任何旧行**(合同 §④「旧行留待 TTL」):旧分区 `cost#<month>`
//    已不在任何读路径上,删不删都不影响合计;删除反而让「读侧切回 v1」这条回滚路径失效。
// 🔴 **v2 首次采集自动回填**:v2 水位缺失 ⇒ 本次按回填窗口采(≥30 天且回到上月 1 日),
//    否则升级后大盘只有最近 3 天、区卡片环比全是空的。手动回填仍走 `POST /api/finops/collect?backfill=1`。

import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { BACKFILL_MIN_DAYS, categorizeService, WATERMARK_SK } from "./constants";
import { getWatermark, setWatermark, upsertCostDaily } from "./store";
// 散建收口到唯一工厂(数据面凭证注入点只有这一处)
import { sdkClient } from "@/lib/aws/clients";

const ce = sdkClient("control-plane", CostExplorerClient, { region: "us-east-1" }); // CE 是全局服务,endpoint 固定 us-east-1

const LOOKBACK_DAYS = 3; // 常规滚动窗口(覆盖迟到账单)

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * 采集窗口起点(纯函数,单测钉):
 *  · 常规 = 今天 − 3 天;
 *  · 回填 = min(今天 − 30 天, 上月 1 日)—— 区卡片环比要「上月同期」,只回 30 天在月中会缺上月头几天。
 */
export function collectWindowStart(now: Date, backfill: boolean): Date {
  if (!backfill) return new Date(now.getTime() - LOOKBACK_DAYS * 86400_000);
  const byDays = new Date(now.getTime() - BACKFILL_MIN_DAYS * 86400_000);
  const prevMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return byDays < prevMonthStart ? byDays : prevMonthStart;
}

export interface CollectResult {
  days: number;
  rows: number;
  /** 本次是否按回填窗口采(手动 backfill=1,或 v2 从未采过的自动回填) */
  backfill: boolean;
  /** 本次为什么走回填:手动 / v2 首次 / 否 */
  backfillReason: "manual" | "v2-first-run" | null;
  /** CE GetCostAndUsage 实际调用次数(含翻页;每次计费 $0.01) */
  ceCalls: number;
}

// 采集 [start, end) 的服务 × 区日成本(CE 语义:End 不含当天)。金额<0.000001 的行跳过(降噪)。
export async function collectDailyCosts(opts?: { backfill?: boolean }): Promise<CollectResult> {
  const now = new Date();
  const firstRun = !(await getWatermark(WATERMARK_SK.CE_DAILY));
  const backfillReason: CollectResult["backfillReason"] = opts?.backfill ? "manual" : firstRun ? "v2-first-run" : null;
  const backfill = backfillReason !== null;
  const start = collectWindowStart(now, backfill);
  const end = new Date(now.getTime() + 86400_000); // 含今日(部分账单当日已可见)
  const days = Math.round((Date.parse(isoDate(now)) - Date.parse(isoDate(start))) / 86400_000);

  let rows = 0;
  let ceCalls = 0;
  let nextToken: string | undefined;
  do {
    ceCalls++;
    const resp = await ce.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: isoDate(start), End: isoDate(end) },
        Granularity: "DAILY",
        Metrics: ["UnblendedCost"],
        // SERVICE + REGION 两个分组(CE 上限正好两个)。
        // 🔴 采不到 REGION 的行(全局服务)CE 会回 `NoRegion` / `global` —— 那是**真实的**
        // 「不属于任何区」,原样存下来,不硬塞给某个区。
        GroupBy: [
          { Type: "DIMENSION", Key: "SERVICE" },
          { Type: "DIMENSION", Key: "REGION" },
        ],
        NextPageToken: nextToken,
      })
    );
    for (const rt of resp.ResultsByTime ?? []) {
      const date = rt.TimePeriod?.Start ?? "";
      for (const g of rt.Groups ?? []) {
        const service = g.Keys?.[0] ?? "";
        // 两个 GroupBy ⇒ Keys 是 [SERVICE, REGION]。REGION 缺失时用 `NoRegion`
        // (CE 自己就用这个字面量表示「无区域归属」),**不留空** —— v2 写侧对空 region fail-closed。
        const region = (g.Keys?.[1] ?? "").trim() || "NoRegion";
        const amountUsd = Number(g.Metrics?.UnblendedCost?.Amount ?? 0);
        if (!date || !service || !(amountUsd > 0.000001)) continue;
        await upsertCostDaily({
          date,
          service,
          region,
          category: categorizeService(service),
          amountUsd,
          collectedAt: now.toISOString(),
        });
        rows++;
      }
    }
    nextToken = resp.NextPageToken;
  } while (nextToken);

  await setWatermark(WATERMARK_SK.CE_DAILY, now.toISOString());
  return { days, rows, backfill, backfillReason, ceCalls };
}

export async function getCeWatermark(): Promise<string | null> {
  return getWatermark(WATERMARK_SK.CE_DAILY);
}
