"use client";

// Copilot 计划中心(独立页,拍板①-A)。左:计划列表;右:选中计划的执行计划表(全展开大图)。
// 顶部:一句话诉求输入 → 规划大脑产计划。与 Copilot 抽屉内嵌卡片【复用同一 ExecutionPlanCard 组件】。
// 安全:产计划=只读发现+落库;确认某步=建草稿+给指引;执行永远由用户去对应页面点(不在本页发生)。

import React, { useEffect, useState, useCallback } from "react";
import { useScope } from "@/components/scope/ScopeProvider";
import { toScopeParam } from "@/lib/scope/scope";
import { Card, Input, Button, List, Tag, Space, Empty, Spin, message, Row, Col, Typography, Tabs } from "antd";
import { RobotOutlined, SendOutlined, ReloadOutlined, BookOutlined, ProfileOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
import ExecutionPlanCard, { type Plan, type PlanStep } from "@/components/copilot/ExecutionPlanCard";
import RecipeLibrary from "@/components/copilot/RecipeLibrary";

const { Text } = Typography;

const PLAN_STATUS_COLOR: Record<string, string> = {
  planned: "blue", awaiting: "gold", running: "processing",
  paused: "default", cancelled: "default", succeeded: "success", "partially-failed": "error",
};

export default function CopilotPlansPage() {
  // 当前执行范围。
  // 列表按 `?scope=` 过滤(「这个区有哪些计划要落地」);新建时把落点交给服务端。
  const { scope, targets: scopeTargets } = useScope();
  const scopeParam = toScopeParam(scope);
  const scopeQs = scopeParam ? `?scope=${encodeURIComponent(scopeParam)}` : "";
  const planTargetId = scope.kind === "target" ? scope.targetId : undefined;
  const planRegion = planTargetId ? scopeTargets?.find((x) => x.targetId === planTargetId)?.region || planTargetId : "";
  const t = useT();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [planning, setPlanning] = useState(false);
  const [selected, setSelected] = useState<{ plan: Plan; steps: PlanStep[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchPlans = useCallback(() => {
    setLoading(true);
    fetch(`/api/copilot/plan${scopeQs}`)
      .then((r) => r.json())
      .then((d) => setPlans(d?.data || []))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchPlans(); }, [fetchPlans]);

  const openDetail = useCallback((planId: string) => {
    setDetailLoading(true);
    fetch(`/api/copilot/plan/${planId}`)
      .then((r) => r.json())
      .then((d) => { if (d?.success) setSelected({ plan: d.data.plan, steps: d.data.steps }); })
      .finally(() => setDetailLoading(false));
  }, []);

  // 异步提交 + 轮询(planner 重推理 >60s 墙,不能同步等)。
  const createPlan = async () => {
    const p = prompt.trim();
    if (!p || planning) return;
    setPlanning(true);
    try {
      const res = await fetch("/api/copilot/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 🔴 计划面向**当前视角那个区**:
        // 它建出来的同步 / 离线 / Flink 草稿都会落在这个区(执行落点走 body,不读 `?scope=`)。
        body: JSON.stringify({ prompt: p, ...(planTargetId ? { targetId: planTargetId } : {}) }),
      });
      const d = await res.json();
      if (!d?.success || !d.data?.taskId) {
        message.error(d?.error?.message || d?.error || t("规划提交失败"));
        return;
      }
      const taskId = d.data.taskId;
      setPrompt("");
      // 轮询(最多 ~4min)。
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const pr = await fetch(`/api/copilot/plan/task/${taskId}`).then((r) => r.json()).catch(() => null);
        const st = pr?.data?.status;
        if (st === "succeeded") {
          message.success(t("已生成执行计划"));
          setSelected({ plan: pr.data.plan, steps: pr.data.steps || [] });
          fetchPlans();
          return;
        }
        if (st === "failed" || st === "timeout") {
          message.error(pr?.data?.error || t("规划失败或超时"));
          return;
        }
      }
      message.warning(t("规划耗时过长,请稍后刷新列表查看"));
      fetchPlans();
    } catch (e: any) {
      message.error(String(e?.message || e));
    } finally {
      setPlanning(false);
    }
  };

  const planCenter = (
    <>
      {/* 一句话诉求 → 产计划 */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space.Compact style={{ width: "100%" }}>
          <Input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("用一句话描述诉求,例如:帮我把广告 ROI 算出来")}
            onPressEnter={createPlan}
            disabled={planning}
            data-testid="plan-prompt-input"
          />
          <Button type="primary" icon={<SendOutlined />} loading={planning} onClick={createPlan} data-testid="plan-generate-btn">
            {t("生成计划")}
          </Button>
        </Space.Compact>
        <div style={{ marginTop: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t("Copilot 会先查现状(数据在哪·有无现成指标·同步了没),再产出一份可逐步确认的执行计划。执行仍由你在对应页面点。")}
          </Text>
        </div>
      </Card>

      <Row gutter={16}>
        {/* 左:计划列表 */}
        <Col xs={24} md={9} lg={8}>
          <Card
            size="small"
            title={t("我的计划")}
            extra={<Button size="small" icon={<ReloadOutlined />} onClick={fetchPlans} loading={loading} />}
          >
            {plans.length === 0 ? (
              <Empty description={t("还没有计划,在上面输入一句话生成")} />
            ) : (
              <List
                dataSource={plans}
                renderItem={(p) => (
                  <List.Item
                    onClick={() => openDetail(p.planId)}
                    style={{ cursor: "pointer", background: selected?.plan.planId === p.planId ? "var(--bgp-panel, rgba(34,211,238,0.08))" : undefined, padding: "8px 10px", borderRadius: 6 }}
                    data-testid="plan-list-item"
                  >
                    <div style={{ width: "100%" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <Text ellipsis style={{ maxWidth: "70%" }}>{p.prompt}</Text>
                        <Tag color={PLAN_STATUS_COLOR[p.status] || "default"}>{p.status}</Tag>
                      </div>
                      {p.summary && <div style={{ fontSize: 11, color: "#8fb0c2", marginTop: 2 }}>{p.summary}</div>}
                    </div>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>

        {/* 右:选中计划的执行计划表(全展开) */}
        <Col xs={24} md={15} lg={16}>
          {detailLoading ? (
            <Card size="small"><div style={{ textAlign: "center", padding: 40 }}><Spin /></div></Card>
          ) : selected ? (
            <ExecutionPlanCard
              plan={selected.plan}
              steps={selected.steps}
              compact={false}
              onChanged={() => openDetail(selected.plan.planId)}
            />
          ) : (
            <Card size="small"><Empty description={t("从左侧选择一个计划查看详情,或在上面生成新计划")} /></Card>
          )}
        </Col>
      </Row>
    </>
  );

  return (
    <div style={{ padding: 20 }}>
      <Space align="center" style={{ marginBottom: 16 }}>
        <RobotOutlined style={{ fontSize: 22, color: "var(--bgp-primary, #22d3ee)" }} />
        <h2 style={{ margin: 0 }}>{t("Copilot 计划中心")}</h2>
      </Space>
      <Tabs
        defaultActiveKey="plans"
        items={[
          { key: "plans", label: <span><ProfileOutlined /> {t("执行计划")}</span>, children: planCenter },
          { key: "recipes", label: <span><BookOutlined /> {t("工程配方库")}</span>, children: <RecipeLibrary /> },
        ]}
      />
    </div>
  );
}
