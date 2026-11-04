"use client";

// 模块 36 (E2) — 治理工作台 /governance-workbench。
// 治理总览入口 + 行动清单:治理健康总分(Gauge)+ 4 维度分 + 资产榜 + 待办工作台。
// 纯聚合读,数据来自 /api/governance/health 一次聚合。全局 fetch 拦截器自动带 Authorization。

import React, { useEffect, useState, useCallback } from "react";
import { useScope } from "@/components/scope/ScopeProvider";
import { toScopeParam } from "@/lib/scope/scope";
import { Card, Row, Col, Statistic, Tag, Button, Spin, Empty, Space, Typography, Table, Progress } from "antd";
import { SafetyCertificateOutlined, ReloadOutlined, WarningOutlined, RightOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { Gauge } from "@/components/dashboard/charts";
import { useT } from "@/lib/i18n/useT";

const { Title, Text } = Typography;

// 待办分组元信息(颜色 + 分组标题)。kind → 展示。label 是 i18n 源串(中文即 key)。
const TODO_META: Record<string, { color: string; label: string }> = {
  unclassified_sensitive: { color: "#f5222d", label: "未分级的疑似敏感表" },
  sla_breach: { color: "#f5222d", label: "SLA 违约" },
  quality_below: { color: "#faad14", label: "质量不达标" },
  ungoverned: { color: "#8c8c8c", label: "尚未治理" },
};

function dimColor(s: number): string {
  return s < 60 ? "#f5577a" : s < 85 ? "#e0a23c" : "#2dd4bf";
}

export default function GovernanceWorkbenchPage() {
  // @kf-batch 50-WP4quater-reads(工单 SC-8)—— 当前执行范围
  const { scope } = useScope();
  const scopeParam = toScopeParam(scope);
  const t = useT();
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      // @kf-batch 50-WP4quater-reads(工单 SC-8)—— 🔴 健康分按执行范围取:三路信号已按区分区,
      // 表全集也从那个区的数仓探。不带范围 = 永远看主控区的分(而它看起来完全正常)。
      const qs = new URLSearchParams();
      if (refresh) qs.set("refresh", "1");
      if (scopeParam) qs.set("scope", scopeParam);
      const q = qs.toString();
      const res = await fetch(`/api/governance/health${q ? `?${q}` : ""}`, { cache: "no-store" });
      const d = await res.json();
      if (d?.success) setData(d.data);
    } finally { setLoading(false); }
  // 🔴 `scopeParam` 进 deps:切范围不重载页面,靠这里重拉(护栏 4)
  }, [scopeParam]);

  useEffect(() => { load(); }, [load]);

  // 待办按 kind 分组。
  const todos: any[] = data?.todos || [];
  const grouped: Record<string, any[]> = {};
  for (const it of todos) (grouped[it.kind] ||= []).push(it);
  const groupOrder = ["unclassified_sensitive", "sla_breach", "quality_below", "ungoverned"];

  return (
    <div style={{ padding: 16 }}>
      <Space style={{ marginBottom: 16, width: "100%", justifyContent: "space-between" }}>
        <Title level={4} style={{ margin: 0 }}><SafetyCertificateOutlined /> {t("治理工作台")}</Title>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => load(true)}>{t("刷新")}</Button>
      </Space>

      {loading && !data ? <Spin style={{ display: "block", margin: "80px auto" }} /> : !data ? (
        <Card><Empty description={t("暂无治理数据")} /></Card>
      ) : (
        <>
          {/* 健康总分 + 维度分 */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col xs={24} md={7}>
              <Card>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                  <Gauge value={data.score} label={t("治理健康总分")} size={170} />
                  <Text type="secondary" style={{ marginTop: 8, fontSize: 12 }}>
                    {t("表 {a} · 字段 {b} · 已分级表 {c}", { a: data.totals.tables, b: data.totals.columns, c: data.totals.classifiedTables })}
                  </Text>
                </div>
              </Card>
            </Col>
            <Col xs={24} md={17}>
              <Card title={t("治理维度")} style={{ height: "100%" }}>
                <Row gutter={[16, 16]}>
                  {(data.dimensions || []).map((d: any) => (
                    <Col xs={12} md={6} key={d.key}>
                      <Statistic title={t(d.labelKey)} value={d.score} suffix="/ 100" valueStyle={{ color: dimColor(d.score), fontSize: 22 }} />
                      <Progress percent={d.score} showInfo={false} strokeColor={dimColor(d.score)} size="small" />
                      <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>{t("权重")} {Math.round(d.weight * 100)}% · {t(d.detail.key, d.detail.params)}</div>
                    </Col>
                  ))}
                </Row>
              </Card>
            </Col>
          </Row>

          <Row gutter={16}>
            {/* 待办工作台 */}
            <Col xs={24} md={14}>
              <Card title={<span><WarningOutlined /> {t("治理待办 ({n})", { n: todos.length })}</span>}>
                {todos.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("暂无待办,治理良好")} /> : (
                  <Space direction="vertical" style={{ width: "100%" }} size={12}>
                    {groupOrder.filter((k) => grouped[k]?.length).map((k) => (
                      <div key={k}>
                        <div style={{ marginBottom: 6 }}>
                          <Tag color={TODO_META[k].color}>{t(TODO_META[k].label)}</Tag>
                          <Text type="secondary" style={{ fontSize: 12 }}>{grouped[k].length}</Text>
                        </div>
                        <Table size="small" rowKey="fqn" pagination={grouped[k].length > 5 ? { pageSize: 5 } : false}
                          dataSource={grouped[k]} showHeader={false}
                          columns={[
                            { key: "fqn", render: (_: any, r: any) => (
                              <div><div style={{ fontWeight: 500 }}>{r.fqn.split(".").pop()}</div><div style={{ fontSize: 11, color: "#888" }}>{r.fqn}</div></div>
                            ) },
                            { key: "detail", render: (_: any, r: any) => <Text type="secondary" style={{ fontSize: 12 }}>{t(r.detail.key, r.detail.params)}</Text> },
                            { key: "action", width: 90, render: (_: any, r: any) => (
                              <Button size="small" type="link" onClick={() => router.push(r.link)}>{t("去处理")} <RightOutlined /></Button>
                            ) },
                          ]} />
                      </div>
                    ))}
                  </Space>
                )}
              </Card>
            </Col>

            {/* 资产风险榜 */}
            <Col xs={24} md={10}>
              <Card title={t("最需治理的数据资产")}>
                {(data.worstAssets || []).length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("无高风险资产")} /> : (
                  <Table size="small" rowKey="fqn" pagination={false} dataSource={data.worstAssets}
                    columns={[
                      { title: t("数据表"), key: "table", render: (_: any, r: any) => (
                        <div><div style={{ fontWeight: 500 }}>{r.table}</div>{!r.classified && <Tag color="default" style={{ fontSize: 10 }}>{t("未分级")}</Tag>}</div>
                      ) },
                      { title: t("问题"), key: "issues", render: (_: any, r: any) => (
                        <Space size={4} wrap>{r.issues.map((i: any, idx: number) => <Tag key={idx} color="orange" style={{ fontSize: 11 }}>{t(i.key, i.params)}</Tag>)}</Space>
                      ) },
                    ]} />
                )}
              </Card>
            </Col>
          </Row>
        </>
      )}
    </div>
  );
}
