// 模块 37 v2 — ECharts 换肤适配(R5:颜色恒由 --bgp-* 驱动,与全站 12 款皮肤一致)。
// 在客户端读 document.documentElement 上的 CSS 变量(ThemeProvider 注入),编译成 ECharts theme 对象。
// 换肤时 CSS 变量变 → 组件监听 localStorage `bgp-skin` 变化重新 buildTheme + setOption。

// 读一个 CSS 变量(带回退),仅客户端可用。
function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export interface BiTheme {
  color: string[]; // 分类系列色
  text: string;
  subtext: string;
  grid: string;
  panel: string;
  primary: string;
}

// 从 --bgp-* 读当前皮肤色。分类色用已过 dataviz 校验的 s1..s4(+ primary/accent 补足)。
export function readBiTheme(): BiTheme {
  const s1 = cssVar("--bgp-s1", "#3d8bfd");
  const s2 = cssVar("--bgp-s2", "#d8479a");
  const s3 = cssVar("--bgp-s3", "#12a07f");
  const s4 = cssVar("--bgp-s4", "#8b6fe8");
  const primary = cssVar("--bgp-primary", "#22d3ee");
  const accent = cssVar("--bgp-accent", "#7c5cff");
  return {
    color: [s1, s2, s3, s4, primary, accent],
    text: cssVar("--bgp-text", "#cfe6f0"),
    subtext: cssVar("--bgp-text-dim", "#8fb0c2"),
    grid: cssVar("--bgp-panel-border", "#1d4254"),
    panel: cssVar("--bgp-panel", "rgba(9,22,32,0.96)"),
    primary,
  };
}

// 把 BiTheme 编译成 ECharts 通用 option 片段(坐标轴/图例/tooltip 的换肤样式)。
// 各图 buildOption 合并这份基底,保证换肤一致、不硬编码颜色。
export function themeBase(t: BiTheme) {
  return {
    color: t.color,
    textStyle: { color: t.text },
    title: { textStyle: { color: t.text } },
    legend: { textStyle: { color: t.subtext }, inactiveColor: t.grid },
    tooltip: {
      backgroundColor: t.panel,
      borderColor: t.primary,
      borderWidth: 1,
      textStyle: { color: t.text },
    },
    categoryAxis: {
      axisLine: { lineStyle: { color: t.grid } },
      axisTick: { lineStyle: { color: t.grid } },
      axisLabel: { color: t.subtext },
      splitLine: { show: false },
    },
    valueAxis: {
      axisLine: { show: false },
      axisLabel: { color: t.subtext },
      splitLine: { lineStyle: { color: t.grid, opacity: 0.4 } },
    },
  };
}
