"use client";

// 执行计划表卡片(唯一真实来源,两处复用:Copilot 抽屉内嵌 + /copilot/plans 独立页)。
// 拍板①:同一组件,compact 控制形态——抽屉里紧凑 + "展开看大图"跳转;独立页里全展开步骤矩阵。
// 绝不写两套 UI 逻辑(防漂移)。消费同一份计划数据(GET /api/copilot/plan/[planId]),同一套确认动作。
//
// 安全语义可视化(L2):每步显示状态 + 依赖 + "确认这步"按钮;确认后展示 execHint("去 X 页点")。
// 不出现任何"运行/执行"按钮——执行永远由用户去对应页面点(引擎 autoExecute 默认关)。

import React, { useState } from "react";
import { Card, Tag, Button, Steps, Typography, Space, Tooltip, message } from "antd";
import {
  CheckCircleOutlined, ClockCircleOutlined, LockOutlined, ArrowRightOutlined,
  ExpandOutlined, LoadingOutlined, StopOutlined, ExclamationCircleOutlined,
} from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";

const { Text, Paragraph } = Typography;

export interface PlanStep {
  planId: string;
  stepId: string;
  seq: number;
  stepType: string;
  title: string;
  rationale: string;
  status: string;
  dependsOn: string[];
  execHint?: { page: string; action: string };
  draftResourceId?: string;
  draftResourceKind?: string;
  lastError?: string;
}
export interface Plan {
  planId: string;
  prompt: string;
  summary: string;
  findings?: string;
  status: string;
  autoExecute?: boolean;
  progress?: Record<string, number>;
}

// 步骤状态 → 展示样式(中文标签 + 颜色 + 图标)。
const STEP_STATUS_META: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  "awaiting-confirmation": { label: "等待确认", color: "gold", icon: <ClockCircleOutlined /> },
  confirmed: { label: "已确认", color: "cyan", icon: <CheckCircleOutlined /> },
  blocked: { label: "等待上游", color: "default", icon: <LockOutlined /> },
  pending: { label: "待执行", color: "blue", icon: <ClockCircleOutlined /> },
  running: { label: "执行中", color: "processing", icon: <LoadingOutlined /> },
  succeeded: { label: "已完成", color: "success", icon: <CheckCircleOutlined /> },
  failed: { label: "失败", color: "error", icon: <ExclamationCircleOutlined /> },
  skipped: { label: "已跳过", color: "default", icon: <StopOutlined /> },
};

const STEP_TYPE_LABEL: Record<string, string> = {
  "sync-glue": "批同步(Glue)",
  "sync-dms": "实时同步(DMS)",
  "redshift-sql": "数仓 SQL 作业",
  glue: "Glue 计算作业",
  emr: "EMR Serverless 作业",
  "query-only": "直接查询",
};

const PLAN_STATUS_META: Record<string, { label: string; color: string }> = {
  planned: { label: "已规划", color: "blue" },
  awaiting: { label: "待确认", color: "gold" },
  running: { label: "进行中", color: "processing" },
  paused: { label: "已暂停", color: "default" },
  cancelled: { label: "已取消", color: "default" },
  succeeded: { label: "已完成", color: "success" },
  "partially-failed": { label: "部分失败", color: "error" },
};

export default function ExecutionPlanCard(props: {
  plan: Plan;
  steps: PlanStep[];
  compact?: boolean; // 抽屉内嵌=true(紧凑+展开跳转);独立页=false(全展开)
  onExpand?: () => void; // compact 下点"展开看大图"
  onChanged?: () => void; // 确认某步后回调(让父组件刷新)
}) {
  const t = useT();
  const { plan, steps, compact, onExpand, onChanged } = props;
  const [confirming, setConfirming] = useState<string>("");

  const pm = PLAN_STATUS_META[plan.status] || { label: plan.status, color: "default" };

  const confirmStep = async (stepId: string) => {
    if (confirming) return;
    setConfirming(stepId);
    try {
      const res = await fetch(`/api/copilot/plan/${plan.planId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepId }),
      });
      const d = await res.json();
      if (d?.success) {
        message.success(t("已确认并创建草稿,请按指引去对应页面执行"));
        onChanged?.();
      } else {
        message.error(d?.error?.message || d?.error || t("确认失败"));
      }
    } catch (e: any) {
      message.error(String(e?.message || e));
    } finally {
      setConfirming("");
    }
  };

  // 0 步计划:直接答复(summary 就是答案)。
  const noSteps = !steps || steps.length === 0;

  return (
    <Card
      size="small"
      data-testid="execution-plan-card"
      style={{ background: "var(--bgp-panel, rgba(12,28,40,0.66))", border: "1px solid var(--bgp-panel-border, rgba(86,224,242,0.22))" }}
      title={
        <Space size={8} wrap>
          <span style={{ fontWeight: 600 }}>{t("执行计划")}</span>
          <Tag color={pm.color}>{t(pm.label)}</Tag>
          {plan.autoExecute === false && (
            <Tooltip title={t("本计划仅产出步骤指引,执行由你在对应页面确认操作,Copilot 不会自动运行")}>
              <Tag icon={<LockOutlined />} color="default">{t("仅指引·不自动执行")}</Tag>
            </Tooltip>
          )}
        </Space>
      }
      extra={compact && onExpand ? (
        <Button size="small" type="link" icon={<ExpandOutlined />} onClick={onExpand} data-testid="plan-expand">
          {t("展开看大图")}
        </Button>
      ) : null}
    >
      {/* 诉求 + 一句话说明 + 发现结论 */}
      {plan.summary && <Paragraph style={{ marginBottom: 8 }}><Text strong>{plan.summary}</Text></Paragraph>}
      {plan.findings && (
        <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 10, whiteSpace: "pre-wrap" }}
          ellipsis={compact ? { rows: 3, expandable: true, symbol: t("更多") } : false}>
          {plan.findings}
        </Paragraph>
      )}

      {noSteps ? (
        <Text type="secondary" style={{ fontSize: 12 }}>{t("无需执行步骤(可直接查看上面的结论)")}</Text>
      ) : (
        <div data-testid="plan-steps">
          {steps.map((s) => {
            const sm = STEP_STATUS_META[s.status] || { label: s.status, color: "default", icon: null };
            const deps = (s.dependsOn || []).map((d) => `#${parseInt(d, 10)}`).join(", ");
            return (
              <div key={s.stepId} style={{
                borderLeft: `3px solid var(--bgp-primary, #22d3ee)`, paddingLeft: 10, marginBottom: 12,
              }}>
                <Space size={6} wrap style={{ marginBottom: 2 }}>
                  <Text strong style={{ fontSize: 13 }}>#{s.seq} {s.title}</Text>
                  <Tag>{t(STEP_TYPE_LABEL[s.stepType] || s.stepType)}</Tag>
                  <Tag icon={sm.icon} color={sm.color}>{t(sm.label)}</Tag>
                  {deps && <Tag color="default">{t("依赖")} {deps}</Tag>}
                </Space>
                {s.rationale && <div style={{ fontSize: 12, color: "#8fb0c2", marginBottom: 4 }}>{s.rationale}</div>}

                {/* 等待确认 → 给"确认这步"按钮 */}
                {s.status === "awaiting-confirmation" && (
                  <Button
                    size="small" type="primary" ghost
                    loading={confirming === s.stepId}
                    onClick={() => confirmStep(s.stepId)}
                    data-testid={`confirm-step-${s.seq}`}
                  >
                    {t("确认这步(建草稿)")}
                  </Button>
                )}
                {/* 已确认 → 展示 execHint 指引 */}
                {(s.status === "confirmed" || s.status === "succeeded") && s.execHint && (
                  <div style={{ fontSize: 12, color: "var(--bgp-primary, #22d3ee)", marginTop: 2 }}>
                    <ArrowRightOutlined /> {s.execHint.action}
                  </div>
                )}
                {s.status === "blocked" && (
                  <Text type="secondary" style={{ fontSize: 12 }}>{t("等待上游步骤完成后可确认")}</Text>
                )}
                {s.status === "failed" && s.lastError && (
                  <Text type="danger" style={{ fontSize: 12 }}>{s.lastError}</Text>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
