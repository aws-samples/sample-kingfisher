"use client";

// FinOps 成本异常:GET /anomalies 纯读列表;「检测并推送」走 POST /detect(34 通道 + 43-A 沉淀,幂等)。

import React, { useCallback, useEffect, useState } from "react";
import { Alert, Button, Space, Table, Tag, message } from "antd";
import { ReloadOutlined, BellOutlined, LinkOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
// @kf-batch 50-WP4ter-coverage —— 执行范围(工单 SC-11):任务级异常按区检测。
// @kf-batch 50-WP6-cost-by-region —— 服务级(来自账单)也已按区检测(账单 v2 带 region),不再有 `unscoped`;
// 每条异常都显示它「属于哪里」:任务级 = 执行环境,服务级 = AWS region。
import { useScope } from "@/components/scope/ScopeProvider";
import { toScopeParam } from "@/lib/scope/scope";

interface AnomalyRowBase {
  key: string;
  displayName: string;
  date: string;
  actualUsd: number;
  baselineUsd: number;
  deviationX: number;
  samples: number;
  incidentRecorded: boolean;
  notified: boolean;
}

/**
 * @kf-batch 50-WP6-cost-by-region —— 与服务端 `CostAnomaly` 同形的判别联合:
 * 任务级必带 `targetId`(基线按 (task, target) 各算各的),服务级必带 `region`(按 (service, region))。
 */
type AnomalyRow =
  | (AnomalyRowBase & { scope: "task"; targetId: string })
  | (AnomalyRowBase & { scope: "service"; region: string });

const whereOf = (r: AnomalyRow) => (r.scope === "task" ? r.targetId : r.region);

export default function AnomalyTab() {
  const t = useT();
  const [items, setItems] = useState<AnomalyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [detecting, setDetecting] = useState(false);
  // @kf-batch 50-WP4ter-coverage
  const { scope, targets } = useScope();
  const targetName = (id: string) => (targets || []).find((x) => x.targetId === id)?.displayName || id;
  const scopeParam = toScopeParam(scope);
  const scopeQs = scopeParam ? `?scope=${encodeURIComponent(scopeParam)}` : "";

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/finops/anomalies${scopeQs}`)
      .then((r) => r.json())
      .then((d) => setItems(d?.data?.items || []))
      .finally(() => setLoading(false));
  }, [scopeQs]);

  useEffect(() => { load(); }, [load]);

  const detect = async () => {
    setDetecting(true);
    try {
      const r = await fetch("/api/finops/detect", { method: "POST" });
      const d = await r.json();
      if (r.ok) {
        const n = (d?.data?.anomalies || []).length;
        message.success(t("检测完成:{n} 条异常已处理(推送+沉淀知识库,幂等去重)", { n }));
        setItems(d?.data?.anomalies || []);
      } else {
        message.error(d?.error || t("检测失败"));
      }
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={t("突增判定:相对自身历史基线(MAD 稳健统计,样本≥7,排除补数运行);确认异常经告警通道推送并沉淀进运维知识库(/incidents)供诊断 Agent 学习。")}
      />
      <Space style={{ marginBottom: 12 }}>
        <Button type="primary" icon={<BellOutlined />} loading={detecting} onClick={detect}>{t("检测并推送")}</Button>
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>{t("刷新")}</Button>
      </Space>
      <Table<AnomalyRow>
        rowKey={(r) => `${r.scope}#${r.key}#${whereOf(r)}#${r.date}`}
        size="small"
        loading={loading}
        dataSource={items}
        columns={[
          {
            title: t("类型"), dataIndex: "scope", width: 90,
            render: (s: string) => <Tag color={s === "task" ? "blue" : "gold"}>{s === "task" ? t("任务") : t("服务")}</Tag>,
          },
          { title: t("对象"), dataIndex: "displayName", ellipsis: true },
          // @kf-batch 50-WP6-cost-by-region —— 「属于哪里」:任务级 = 执行环境,服务级 = AWS region
          {
            title: t("执行范围"), key: "where", width: 180,
            render: (_: unknown, r: AnomalyRow) =>
              r.scope === "task" ? (
                <Tag data-testid="anomaly-where" data-target={r.targetId}>{targetName(r.targetId)}</Tag>
              ) : (
                <Tag data-testid="anomaly-where" data-region={r.region}>{r.region}</Tag>
              ),
          },
          { title: t("日期"), dataIndex: "date", width: 110 },
          { title: t("实际"), dataIndex: "actualUsd", width: 110, render: (v: number) => `$${v.toFixed(4)}` },
          { title: t("基线"), dataIndex: "baselineUsd", width: 110, render: (v: number) => `$${v.toFixed(4)}` },
          { title: t("偏离"), dataIndex: "deviationX", width: 90, render: (v: number) => <Tag color={v >= 5 ? "red" : "orange"}>{v.toFixed(1)}×</Tag>, sorter: (a, b) => a.deviationX - b.deviationX, defaultSortOrder: "descend" },
          { title: t("样本"), dataIndex: "samples", width: 70 },
          {
            title: t("状态"), key: "state", width: 200,
            render: (_: unknown, r: AnomalyRow) => (
              <Space size={4}>
                {r.notified && <Tag color="green">{t("已推送")}</Tag>}
                {r.incidentRecorded && (
                  <Tag color="purple" icon={<LinkOutlined />}>
                    <a href="/incidents" style={{ color: "inherit" }}>{t("已沉淀知识库")}</a>
                  </Tag>
                )}
                {!r.notified && !r.incidentRecorded && <Tag>{t("待处理")}</Tag>}
              </Space>
            ),
          },
        ]}
      />
    </div>
  );
}
