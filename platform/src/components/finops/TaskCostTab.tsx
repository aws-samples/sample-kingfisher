"use client";

// FinOps 任务成本:排行表(任务/引擎/次数/总额/均值)+ 展开行看 run 级明细(usage/priceVersion)。

import React, { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Col, Row, Select, Space, Statistic, Table, Tag, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
// @kf-batch 50-WP4ter-coverage —— 执行范围(工单 SC-11);计数随列表响应回(不走 counts 端点,台账 N-7)
import { useScope } from "@/components/scope/ScopeProvider";
import { ScopeCountsHint } from "@/components/scope/OtherScopesHint";
import { toScopeParam } from "@/lib/scope/scope";

interface TaskRow {
  taskId: string;
  /** @kf-batch 50-WP6-cost-by-region —— 排行按 (task, target) 分行;这一行是哪个执行环境 */
  targetId: string;
  engine: string;
  runCount: number;
  totalUsd: number;
  avgUsd: number;
  lastRunAt: string;
}

interface RunRow {
  runId: string;
  costUsd: number;
  runStatus: string;
  startedAt: string;
  finishedAt: string;
  priceVersion: string;
  triggeredBy?: string;
  usage: Record<string, number | undefined>;
  /** @kf-batch 50-WP6-cost-by-region —— 服务端按 `scalarTargetOf` 判定的归属执行环境 */
  effectiveTargetId: string;
}

/** @kf-batch 50-WP6-cost-by-region —— 「已归因 / 未分摊」按 region 对账(服务端 reconcileByRegion 算) */
interface RegionReconcile {
  region: string;
  targetIds: string[];
  regionCostUsd: number;
  attributedUsd: number;
  unallocatedUsd: number;
}
interface CostReconcile {
  windowFrom: string;
  billCoverageFrom: string | null;
  byRegion: RegionReconcile[];
  unresolvedAttributedUsd: number;
}

const ENGINE_COLOR: Record<string, string> = { glue: "blue", "emr-serverless": "green", athena: "purple" };

function usageText(u: RunRow["usage"]): string {
  if (u.dpuSeconds !== undefined) return `${u.dpuSeconds} DPU-s`;
  if (u.vcpuHours !== undefined) return `${u.vcpuHours} vCPUh + ${u.memoryGbHours ?? 0} GBh`;
  if (u.dataScannedBytes !== undefined) return `${(u.dataScannedBytes / 1024 / 1024).toFixed(1)} MB scanned`;
  return "-";
}

function RunDetail({ taskId, targetId }: { taskId: string; targetId: string }) {
  const t = useT();
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    // @kf-batch 50-WP6-cost-by-region —— 只看这一行的执行环境(同任务另一个区的 run 在另一行);
    // 归属用服务端给的 `effectiveTargetId`(与排行分组同一条规则),前端不自己猜缺章行属于谁
    fetch(`/api/finops/tasks/${encodeURIComponent(taskId)}`)
      .then((r) => r.json())
      .then((d) => setRuns(((d?.data?.items || []) as RunRow[]).filter((x) => x.effectiveTargetId === targetId)))
      .finally(() => setLoading(false));
  }, [taskId, targetId]);
  return (
    <Table<RunRow>
      size="small"
      rowKey="runId"
      loading={loading}
      dataSource={runs}
      pagination={false}
      columns={[
        { title: t("运行 ID"), dataIndex: "runId", width: 240, ellipsis: true },
        { title: t("状态"), dataIndex: "runStatus", width: 100, render: (s: string) => <Tag color={s === "succeeded" ? "green" : s === "failed" ? "red" : "default"}>{s}</Tag> },
        { title: t("用量"), key: "usage", render: (_: unknown, r: RunRow) => usageText(r.usage) },
        { title: t("成本"), dataIndex: "costUsd", width: 120, render: (v: number) => `$${v.toFixed(6)}` },
        { title: t("价目版本"), dataIndex: "priceVersion", width: 130 },
        { title: t("触发"), dataIndex: "triggeredBy", width: 100, render: (v?: string) => v || "manual" },
        { title: t("完成时间"), dataIndex: "finishedAt", width: 180, render: (v: string) => (v ? new Date(v).toLocaleString() : "-") },
      ]}
    />
  );
}

export default function TaskCostTab() {
  const t = useT();
  const [items, setItems] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [engine, setEngine] = useState<string | undefined>();
  const [days, setDays] = useState(30);
  // @kf-batch 50-WP4ter-coverage
  const { scope, targets } = useScope();
  const scopeParam = toScopeParam(scope);
  const [countsByTarget, setCountsByTarget] = useState<Record<string, number>>({});
  // @kf-batch 50-WP6-cost-by-region
  const [reconcile, setReconcile] = useState<CostReconcile | null>(null);
  const targetName = (id: string) => (targets || []).find((x) => x.targetId === id)?.displayName || id;

  const load = useCallback(() => {
    setLoading(true);
    const qs = new URLSearchParams({ days: String(days), ...(engine ? { engine } : {}), ...(scopeParam ? { scope: scopeParam } : {}) });
    fetch(`/api/finops/tasks?${qs}`)
      .then((r) => r.json())
      .then((d) => {
        setItems(d?.data?.items || []);
        setCountsByTarget(d?.data?.countsByTarget || {});
        setReconcile(d?.data?.reconcile || null);
      })
      .finally(() => setLoading(false));
  }, [engine, days, scopeParam]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Select
          allowClear
          placeholder={t("全部引擎")}
          style={{ width: 160 }}
          value={engine}
          onChange={setEngine}
          options={[
            { value: "glue", label: "Glue" },
            { value: "emr-serverless", label: "EMR Serverless" },
            { value: "athena", label: "Athena" },
          ]}
        />
        <Select
          style={{ width: 140 }}
          value={days}
          onChange={setDays}
          options={[
            { value: 7, label: t("近 7 天") },
            { value: 30, label: t("近 30 天") },
            { value: 90, label: t("近 90 天") },
          ]}
        />
        <Button icon={<ReloadOutlined />} onClick={load}>{t("刷新")}</Button>
      </Space>
      {/* @kf-batch 50-WP6-cost-by-region(O3b,E-172)—— 🔴 KPI 按 region 对账:未分摊 = region 账单 − Σ已归因。
          对账粒度只能是 region(CE 只给到 region),同区其他执行环境的 run 也计入已归因;不按引擎筛。 */}
      {reconcile && reconcile.byRegion.length > 0 && (
        <Card
          size="small"
          style={{ marginBottom: 12 }}
          data-testid="finops-reconcile"
          title={
            <Space size={8}>
              <span>{t("已归因 / 未分摊(按区对账)")}</span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t("未分摊 = 该区账单 − 该区全部任务运行的归因成本;不随引擎筛选变化")}
              </Typography.Text>
            </Space>
          }
        >
          <Row gutter={[12, 12]}>
            {reconcile.byRegion.map((r) => (
              <Col key={r.region} xs={24} md={12} lg={8}>
                <Card size="small" data-testid="finops-reconcile-region" data-region={r.region}>
                  <Typography.Text strong>{r.region}</Typography.Text>
                  <Row gutter={8} style={{ marginTop: 6 }}>
                    <Col span={8}><Statistic title={t("区账单")} value={r.regionCostUsd} precision={2} prefix="$" /></Col>
                    <Col span={8}><Statistic title={t("已归因")} value={r.attributedUsd} precision={2} prefix="$" /></Col>
                    <Col span={8}>
                      <span data-testid="finops-unallocated" data-value={r.unallocatedUsd}>
                        <Statistic title={t("未分摊")} value={r.unallocatedUsd} precision={2} prefix="$" />
                      </span>
                    </Col>
                  </Row>
                  {r.unallocatedUsd < 0 && (
                    <Typography.Text type="warning" style={{ fontSize: 12 }}>
                      {t("归因多于账单:账单 T+1 迟到,或价目表偏高")}
                    </Typography.Text>
                  )}
                </Card>
              </Col>
            ))}
          </Row>
          {reconcile.billCoverageFrom && reconcile.billCoverageFrom > reconcile.windowFrom && (
            <Alert
              type="warning" showIcon style={{ marginTop: 8 }}
              message={t("账单只覆盖 {from} 起(窗口从 {win} 起),更早的未分摊偏小", { from: reconcile.billCoverageFrom, win: reconcile.windowFrom })}
            />
          )}
          {reconcile.billCoverageFrom === null && (
            <Alert type="warning" showIcon style={{ marginTop: 8 }} message={t("窗口内还没有按区账单:到「成本大盘」点「立即采集」")} />
          )}
          {reconcile.unresolvedAttributedUsd > 0 && (
            <Alert
              type="info" showIcon style={{ marginTop: 8 }}
              message={t("另有 ${amt} 的运行成本解析不出所在区(执行环境已删除或读不到),未计入任何区", { amt: reconcile.unresolvedAttributedUsd.toFixed(2) })}
            />
          )}
        </Card>
      )}
      <Table<TaskRow>
        rowKey={(r) => `${r.taskId}#${r.targetId}`}
        size="small"
        loading={loading}
        dataSource={items}
        expandable={{ expandedRowRender: (r) => <RunDetail taskId={r.taskId} targetId={r.targetId} /> }}
        columns={[
          { title: t("任务 ID"), dataIndex: "taskId", ellipsis: true },
          // @kf-batch 50-WP6-cost-by-region —— 「执行范围」列:这一行的运行发生在哪个执行环境
          {
            title: t("执行范围"), dataIndex: "targetId", width: 180,
            render: (v: string) => <Tag data-testid="finops-task-target" data-target={v}>{targetName(v)}</Tag>,
          },
          { title: t("引擎"), dataIndex: "engine", width: 140, render: (e: string) => <Tag color={ENGINE_COLOR[e] || "default"}>{e}</Tag> },
          { title: t("运行次数"), dataIndex: "runCount", width: 100 },
          { title: t("总成本"), dataIndex: "totalUsd", width: 130, render: (v: number) => `$${v.toFixed(4)}`, sorter: (a, b) => a.totalUsd - b.totalUsd, defaultSortOrder: "descend" },
          { title: t("单次均值"), dataIndex: "avgUsd", width: 130, render: (v: number) => `$${v.toFixed(6)}` },
          { title: t("最近运行"), dataIndex: "lastRunAt", width: 180, render: (v: string) => (v ? new Date(v).toLocaleString() : "-") },
        ]}
      />
      {/* @kf-batch 50-WP4ter-coverage —— 护栏 1:同一天窗口径的「别处还有 N 条」 */}
      <ScopeCountsHint counts={countsByTarget} noun={t("成本运行")} />
    </div>
  );
}
