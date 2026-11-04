"use client";

// BI 分析看板(F3,v4 整合)。QuickSight 式单面板:一个画布 N 个视觉对象 + 绑字段·作用域筛选器。
// v4 把旧的"报表库 + 仪表盘"两 Tab 整合成一个「分析看板」面板(用户拍板)。
//   - 旧 bgp-bi-reports / bgp-bi-dashboards 的表 / lib / API **完全保留不动**(老数据零风险),仅从 UI 入口移除;
//     新面板通过「从报表库导入」复用旧报表。
//   - 全部逻辑在 BI 私有组件 AnalysisWorkbench 里,复用 FieldConfigurator / WidgetRenderer / DashboardGrid(均不改)。
//   - 隔离红线:不碰 charts.tsx、不碰非 BI 代码;echarts/react-grid-layout import 只在 components/bi/**。

import AnalysisWorkbench from "@/components/bi/AnalysisWorkbench";

export default function BiPage() {
  return <AnalysisWorkbench />;
}
