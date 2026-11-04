// 模块 37 v2 — ECharts 按需注册(tree-shaking:只引 BI 报表用到的图表/组件,不引全量 echarts)。
// 依赖隔离红线:echarts 的 import 只允许出现在 components/bi/** 与 app/bi/**。此文件是唯一注册点。

import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart, GaugeChart, ScatterChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DatasetComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GaugeChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DatasetComponent,
  CanvasRenderer,
]);

export { echarts };
