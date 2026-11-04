// 模块 40 — 成本异常判定(纯函数,零 IO,单测覆盖)。
// 复用 43-B 稳健统计(import 纯函数,零改动):MAD 去异常后取中位数作基线,
// 当前值偏离 > k×(1.4826·MAD) 且样本足够(≥7,冷启动不误报)才算异常。
// backfill 触发的 run 由调用方在喂样本前排除(43-B 硬约束同款)。

import { median, removeOutliersMAD } from "@/lib/baseline/stats";
import { ANOMALY_MAD_K, ANOMALY_MIN_SAMPLES } from "./constants";

export interface SpikeVerdict {
  isSpike: boolean;
  baseline: number; // 历史中位数(MAD 去异常后)
  deviationX: number; // 当前值 / 基线(基线为 0 时按绝对阈值兜底)
  samples: number;
}

// history:历史样本(不含 current,时间序无要求);current:待判定的当前值。
export function detectSpike(history: number[], current: number, opts?: { k?: number; minSamples?: number }): SpikeVerdict {
  const k = opts?.k ?? ANOMALY_MAD_K;
  const minSamples = opts?.minSamples ?? ANOMALY_MIN_SAMPLES;
  const clean = removeOutliersMAD(history);
  const base = median(clean);
  const samples = history.length;

  if (samples < minSamples) {
    return { isSpike: false, baseline: base, deviationX: base > 0 ? current / base : 0, samples };
  }

  // MAD 尺度:全等历史(mad=0)时用基线的 20% 作最小离散度,避免"任何微小波动都是异常"。
  const absDev = clean.map((x) => Math.abs(x - base));
  const mad = median(absDev);
  const scale = mad > 0 ? 1.4826 * mad : Math.max(base * 0.2, 1e-9);

  const isSpike = current > base + k * scale && current > base * 1.5; // 双条件:统计显著 + 至少 1.5 倍(防微额噪声)
  const deviationX = base > 0 ? current / base : current > 0 ? Infinity : 0;
  return { isSpike, baseline: base, deviationX, samples };
}
