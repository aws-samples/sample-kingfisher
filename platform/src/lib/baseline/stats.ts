// 模块 43-B — 稳健统计(纯函数,可单测,零依赖)。
// MAD(中位数绝对偏差)去异常是关键:一次 backfill 大跑或偶发慢跑不能污染基线 p90。

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// 线性插值分位数(p ∈ [0,100])。
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const rank = (p / 100) * (s.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (rank - lo);
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

// MAD 去异常:剔除偏离中位数超过 k×(1.4826·MAD) 的点(1.4826 使 MAD 对正态一致于 stdev)。
// 样本极少(<4)时不剔(信息不足,剔了更失真)。返回过滤后的数组(至少保留中位数附近的点)。
export function removeOutliersMAD(xs: number[], k = 3): number[] {
  if (xs.length < 4) return [...xs];
  const med = median(xs);
  const absDev = xs.map((x) => Math.abs(x - med));
  const mad = median(absDev);
  if (mad === 0) return [...xs]; // 全等或近乎 → 无离散,不剔
  const scaled = 1.4826 * mad;
  const filtered = xs.filter((x) => Math.abs(x - med) <= k * scaled);
  return filtered.length ? filtered : [...xs];
}

// EWMA(指数加权移动平均):按时间序(旧→新)加权,近期权重高。alpha 越大越跟随近期。
export function ewma(xsChrono: number[], alpha = 0.3): number {
  if (xsChrono.length === 0) return 0;
  let acc = xsChrono[0];
  for (let i = 1; i < xsChrono.length; i++) acc = alpha * xsChrono[i] + (1 - alpha) * acc;
  return acc;
}
