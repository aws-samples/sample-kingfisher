"use client";

// 模块 40 — FinOps 成本治理页(4 Tab:大盘/任务成本/异常/预算与建议)。
// 隔离红线:只 import 共享稳定组件(charts.tsx/FeatureGuide),所有业务组件在 components/finops/。

import React, { useEffect, useState } from "react";
import { Tabs } from "antd";
import { useT } from "@/lib/i18n/useT";
import FeatureGuide from "@/components/common/FeatureGuide";
import OverviewTab from "@/components/finops/OverviewTab";
import TaskCostTab from "@/components/finops/TaskCostTab";
import AnomalyTab from "@/components/finops/AnomalyTab";
import BudgetTab from "@/components/finops/BudgetTab";

export default function FinOpsPage() {
  const t = useT();
  return (
    <div style={{ padding: 16 }}>
      <FeatureGuide
        title={t("成本治理 FinOps")}
        what="把 AWS 账单从「服务维度 T+1」下钻到「任务/运行级近实时」:大盘看趋势、排行找烧钱任务、突增自动告警并沉淀运维知识库、预算越档推送。"
        steps={[
          "「成本大盘」看本月/昨日花费与底座 vs 引擎分类趋势(首次使用点「立即采集」拉取账单)",
          "「任务成本」看每个任务/每次运行折算成本排行(Glue/EMR/Athena 精确归因)",
          "「成本异常」查突增检测结果;点「检测并推送」把确认异常推告警通道并沉淀知识库",
          "「预算护栏」设月预算与阈值通道;「优化建议」给确定性省钱项",
        ]}
        tips={[
          "账单数据 T+1(Cost Explorer),任务归因近实时(引擎计量×价目表,记录带价目版本可审计)",
          "成本突增会沉淀进运维知识库(/incidents),诊断 Agent 可学习历史成本事件",
        ]}
      />
      <Tabs
        defaultActiveKey="overview"
        items={[
          { key: "overview", label: t("成本大盘"), children: <OverviewTab /> },
          { key: "tasks", label: t("任务成本"), children: <TaskCostTab /> },
          { key: "anomalies", label: t("成本异常"), children: <AnomalyTab /> },
          { key: "budgets", label: t("预算护栏"), children: <BudgetTab /> },
        ]}
      />
    </div>
  );
}
