"use client";

// 统一图表入口 <BiChart>(ECharts 实现,屏蔽底层库)。
// 只在 BI 模块内使用;不碰共享 charts.tsx。换肤:读 --bgp-* 编译 theme,监听 bgp-skin 变化重绘。
// 支持 bar / line / pie / gauge / scatter;table/metric 由 WidgetRenderer 用 antd/自绘处理(不进这里)。

import React from "react";
import { echarts } from "./echarts-core";
import { readBiTheme, themeBase, type BiTheme } from "./theme";
import { toSeries } from "@/lib/bi/chart-series";

export type BiEChartType = "bar" | "line" | "pie" | "gauge" | "scatter";

interface BiChartProps {
  type: BiEChartType;
  columns: string[];
  rows: (string | null)[][];
  xField?: string; // 维度列名
  yField?: string; // 度量列名(单系列;兼容 v1/v2)
  // v3 图表增强(全部可选;不传即单系列 = 原行为)。
  yFields?: string[]; // 多度量 → 多系列
  seriesField?: string; // 分组 / 颜色维度 → pivot 多系列
  stack?: boolean; // 堆叠(仅 bar)
  orient?: "v" | "h"; // 横向 barh(仅 bar)
  height?: number;
}

// 数值解析(非法/空 → 0);与 WidgetRenderer 口径一致。
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// 依 type + 数据 + 主题构造 ECharts option。
function buildOption(
  type: BiEChartType,
  columns: string[],
  rows: (string | null)[][],
  xField: string | undefined,
  yField: string | undefined,
  t: BiTheme,
  opts?: { yFields?: string[]; seriesField?: string; stack?: boolean; orient?: "v" | "h" }
): any {
  const base = themeBase(t);
  const xi = Math.max(0, xField ? columns.indexOf(xField) : 0);
  const yi = Math.max(0, yField ? columns.indexOf(yField) : columns.length - 1);
  const labels = rows.map((r) => String(r[xi] ?? ""));
  const values = rows.map((r) => num(r[yi]));

  const commonTooltip = { ...base.tooltip };

  if (type === "pie") {
    return {
      color: base.color,
      tooltip: { ...commonTooltip, trigger: "item", formatter: "{b}: {c} ({d}%)" },
      legend: { ...base.legend, orient: "vertical", right: 8, top: "middle" },
      series: [
        {
          type: "pie",
          radius: ["45%", "70%"], // 环形(donut),与 v1 Donut 视觉延续
          center: ["38%", "50%"],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: t.panel, borderWidth: 2 },
          label: { color: t.subtext },
          data: labels.map((l, i) => ({ name: l, value: values[i] })),
        },
      ],
    };
  }

  if (type === "gauge") {
    const v = Math.max(0, Math.min(100, values[0] || 0));
    return {
      tooltip: { ...commonTooltip },
      series: [
        {
          type: "gauge",
          progress: { show: true, width: 14 },
          axisLine: { lineStyle: { width: 14 } },
          detail: { valueAnimation: true, formatter: "{value}", color: t.text, fontSize: 24 },
          data: [{ value: v, name: yField || "" }],
          title: { color: t.subtext },
          anchor: { show: false },
        },
      ],
    };
  }

  if (type === "scatter") {
    return {
      color: base.color,
      tooltip: { ...commonTooltip, trigger: "item" },
      xAxis: { type: "category", data: labels, ...base.categoryAxis },
      yAxis: { type: "value", ...base.valueAxis },
      grid: { left: 56, right: 20, top: 24, bottom: 56, containLabel: true },
      series: [{ type: "scatter", symbolSize: 10, data: values }],
    };
  }

  // bar / line —— 经 toSeries 归一成 { categories, series[] },一条路径支撑单系列/多度量/分组透视。
  const { categories, series } = toSeries(columns, rows, {
    xField,
    yFields: opts?.yFields,
    seriesField: opts?.seriesField,
  });
  const multi = series.length > 1;
  const horizontal = type === "bar" && opts?.orient === "h";
  const stacked = type === "bar" && !!opts?.stack;

  const categoryAxis = {
    type: "category",
    data: categories,
    ...base.categoryAxis,
    axisLabel: { ...base.categoryAxis.axisLabel, ...(horizontal ? {} : { rotate: categories.length > 8 ? 30 : 0 }) },
  };
  const valueAxis = { type: "value", ...base.valueAxis };

  const seriesOpt = series.map((s, idx) => {
    if (type === "line") {
      return {
        type: "line", name: s.name, data: s.data, smooth: true,
        areaStyle: multi ? undefined : { opacity: 0.15 },
        lineStyle: { width: 2 },
        ...(multi ? {} : { itemStyle: { color: t.primary } }), // 单系列保持 primary(v2 视觉延续)
      };
    }
    return {
      type: "bar", name: s.name, data: s.data, barMaxWidth: 48,
      // 横向条形圆角在右端;纵向在顶端;堆叠时不加圆角(避免层间缝隙)。
      ...(stacked ? { stack: "total" } : {}),
      itemStyle: stacked ? {} : { borderRadius: horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0] },
    };
  });

  return {
    color: base.color,
    tooltip: { ...commonTooltip, trigger: "axis", axisPointer: { type: type === "bar" ? "shadow" : "line" } },
    // 多系列才显图例(单系列保持 v2 无图例的简洁外观)。
    legend: multi ? { ...base.legend, top: 0, type: "scroll" } : { show: false },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? categoryAxis : valueAxis,
    grid: { left: horizontal ? 90 : 56, right: 20, top: multi ? 34 : 24, bottom: 60, containLabel: true },
    series: seriesOpt,
  };
}

export default function BiChart({ type, columns, rows, xField, yField, yFields, seriesField, stack, orient, height = 280 }: BiChartProps) {
  const elRef = React.useRef<HTMLDivElement | null>(null);
  const chartRef = React.useRef<any>(null);

  // 多度量 / 分组维度以字符串签名参与依赖(数组引用每次变,序列化后才稳定)。
  const yFieldsKey = (yFields || []).join(",");

  // 初始化 / 数据或类型变化时重绘。
  const render = React.useCallback(() => {
    if (!elRef.current) return;
    if (!chartRef.current) {
      chartRef.current = echarts.init(elRef.current);
    }
    const theme = readBiTheme();
    const option = buildOption(type, columns, rows, xField, yField, theme, {
      yFields, seriesField, stack, orient,
    });
    chartRef.current.setOption(option, true); // notMerge=true:类型切换时彻底重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, columns, rows, xField, yField, yFieldsKey, seriesField, stack, orient]);

  React.useEffect(() => {
    render();
  }, [render]);

  // 换肤:ThemeProvider 换肤时会改 <html data-skin> 属性并更新 --bgp-* 变量(不派发事件)。
  // 用 MutationObserver 观察 data-skin 变化重绘——**不改 ThemeProvider**(隔离红线),纯观察者。
  // 另监听 storage 事件覆盖跨标签页换肤。
  React.useEffect(() => {
    const onSkin = () => render();
    const mo = new MutationObserver(onSkin);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin"] });
    window.addEventListener("storage", onSkin);
    return () => {
      mo.disconnect();
      window.removeEventListener("storage", onSkin);
    };
  }, [render]);

  // 自适应容器宽度。
  React.useEffect(() => {
    const onResize = () => chartRef.current?.resize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 卸载销毁,防内存泄漏。
  React.useEffect(() => {
    return () => {
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  return <div ref={elRef} style={{ width: "100%", height }} />;
}
