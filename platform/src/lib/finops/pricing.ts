// 内置价目表(us-east-1 按需单价,来源 AWS 官网定价页,2026-07 快照)。
// 设计拍板:不动态拉 Pricing API(响应巨大格式复杂,收益低);每条归因记录带 priceVersion
// 可审计;collector 用 CE 实付/用量反推校准,偏差 >10% 由 advice 出提醒(人工更新常量)。

import type { CostEngine, EngineUsage } from "./types";

export const PRICE_VERSION = "use1-2026-07";

export const UNIT_PRICES = {
  glueDpuHourUsd: 0.44,
  emrVcpuHourUsd: 0.052624,
  emrMemoryGbHourUsd: 0.0057785,
  emrStorageGbHourUsd: 0.000111, // >20GB 免费额度部分;计费值已在 billedResourceUtilization 扣除
  athenaPerTbUsd: 5.0,
  redshiftRpuHourUsd: 0.375, // serverless;一期仅 workgroup 日成本展示用
} as const;

const BYTES_PER_TB = 1024 ** 4;

// 引擎计量 → 美元(确定性纯函数,单测覆盖)。未知/缺失计量返回 0 并由调用方决定是否落记录。
export function costOfUsage(engine: CostEngine, usage: EngineUsage): number {
  switch (engine) {
    case "glue":
      return ((usage.dpuSeconds ?? 0) / 3600) * UNIT_PRICES.glueDpuHourUsd;
    case "emr-serverless":
      return (
        (usage.vcpuHours ?? 0) * UNIT_PRICES.emrVcpuHourUsd +
        (usage.memoryGbHours ?? 0) * UNIT_PRICES.emrMemoryGbHourUsd +
        (usage.storageGbHours ?? 0) * UNIT_PRICES.emrStorageGbHourUsd
      );
    case "athena": {
      // Athena 最低计费 10MB/查询;0 字节(DDL/失败)不计费。
      const bytes = usage.dataScannedBytes ?? 0;
      if (bytes <= 0) return 0;
      const MIN_BYTES = 10 * 1024 * 1024;
      return (Math.max(bytes, MIN_BYTES) / BYTES_PER_TB) * UNIT_PRICES.athenaPerTbUsd;
    }
  }
}

// 金额展示统一 6 位小数截断(单次 run 常在 $0.000x 量级,4 位会失真归零)。
export function roundUsd(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
