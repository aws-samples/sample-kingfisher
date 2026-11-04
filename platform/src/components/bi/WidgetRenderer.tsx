"use client";

// 模块 37 — Widget 渲染器:把取数结果 {columns, rows} + 可视化 spec(viz)映射到具体图表。
// v2:图形类(bar/line/pie/barh/gauge/scatter)走 ECharts <BiChart>(精致+交互);table 用 antd Table;
// metric 用 charts.tsx 的 MetricCard(只 import 不改它)。auto=true 时用 suggestChart 推断。
// 隔离红线:本文件是 BI 私有组件;不改共享 charts.tsx。

import React from "react";
import { Table, Empty } from "antd";
import { MetricCard } from "@/components/dashboard/charts";
import BiChart, { type BiEChartType } from "@/components/bi/charts/BiChart";
import { suggestChart } from "@/lib/genbi/chart";
import { useT } from "@/lib/i18n/useT";
import type { BiChartType, WidgetViz } from "@/lib/bi/types";

export interface WidgetData {
  columns: string[];
  rows: unknown[][];
}

// 选定 x(维度)/y(度量)字段名:显式 viz 优先,否则退回 suggestChart。返回有效图表类型 + 字段名。
function resolve(
  columns: string[],
  rows: (string | null)[][],
  viz: WidgetViz
): { chart: BiChartType; xField: string; yField: string } {
  let chart: BiChartType = viz.chart;
  let xField = viz.xField;
  let yField = viz.yField;
  if (viz.auto || !xField || !yField) {
    const spec = suggestChart(columns, rows);
    if (viz.auto) {
      // auto:采纳推断类型;但 pie/barh/gauge 是 suggestChart 不产出的显式选择,予以保留。
      chart = spec.type === "bar" && (viz.chart === "pie" || viz.chart === "barh" || viz.chart === "gauge")
        ? viz.chart
        : (spec.type as BiChartType);
    }
    xField = xField || spec.xField || columns[0];
    yField = yField || spec.yField || columns[columns.length - 1];
  }
  return { chart, xField: xField || columns[0], yField: yField || columns[columns.length - 1] };
}

// BI 图表类型 → ECharts 类型(barh 横向条形在 ECharts 里也是 bar,方向由 BiChart 的 orient 处理)。
const ECHART_TYPE: Partial<Record<BiChartType, BiEChartType>> = {
  bar: "bar",
  line: "line",
  pie: "pie",
  gauge: "gauge",
  barh: "bar", // v3:横向 = type=bar + orient=h,真正横过来(不再降级成纵向)
};

export default function WidgetRenderer({ data, viz }: { data: WidgetData; viz: WidgetViz }) {
  const t = useT();
  const columns = data.columns || [];
  const rows = (data.rows || []) as (string | null)[][];

  if (!columns.length || !rows.length) {
    return <Empty description={t("暂无数据")} image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  const { chart, xField, yField } = resolve(columns, rows, viz);

  // 指标卡:第一行的度量(或指定 yField)。
  if (chart === "metric") {
    const idx = viz.yField ? Math.max(0, columns.indexOf(viz.yField)) : columns.length - 1;
    return <MetricCard value={String(rows[0]?.[idx] ?? "")} label={columns[idx]} />;
  }

  // 表格:antd Table(自动换肤)。
  if (chart === "table") {
    const tableColumns = columns.map((c, idx) => ({ title: c, dataIndex: String(idx), key: String(idx), ellipsis: true }));
    const tableData = rows.map((row, i) => {
      const rec: Record<string, unknown> = { _key: i };
      row.forEach((cell, idx) => (rec[String(idx)] = cell));
      return rec;
    });
    return <Table size="small" columns={tableColumns} dataSource={tableData} rowKey="_key" scroll={{ x: true }} pagination={{ pageSize: 10, size: "small" }} />;
  }

  // 图形类 → ECharts。v3:透传多系列(yFields/seriesField)、堆叠(stack)、方向(barh→orient=h)。
  const echType = ECHART_TYPE[chart] || "bar";
  const orient: "v" | "h" = chart === "barh" ? "h" : viz.orient === "h" ? "h" : "v";
  return (
    <BiChart
      type={echType}
      columns={columns}
      rows={rows}
      xField={xField}
      yField={yField}
      yFields={viz.yFields}
      seriesField={viz.seriesField}
      stack={viz.stack}
      orient={orient}
    />
  );
}
