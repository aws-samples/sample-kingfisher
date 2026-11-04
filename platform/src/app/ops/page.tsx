"use client";

// 模块 34 — 运维大屏 /ops。只读、深色投屏风格、自动刷新。复用自绘 SVG 图表
// (Donut/TrendArea/Gauge/GanttTimeline + 最近告警列表),数据来自 /api/ops/summary 一次聚合。
// 全局 fetch 拦截器自动带 Authorization + x-bgp-project(见 AuthProvider)。

import React, { useEffect, useState, useCallback, useRef } from "react";
import { Card, Row, Col, Statistic, Tag, Select, Button, Spin, Empty, Space, Typography } from "antd";
import { FundProjectionScreenOutlined, ReloadOutlined, BellOutlined, AlertOutlined } from "@ant-design/icons";
import { Donut, TrendArea, Gauge, GanttTimeline, BarList, type Slice, type GanttRow } from "@/components/dashboard/charts";
import { useT } from "@/lib/i18n/useT";
// @kf-batch 50-WP4ter-coverage —— 执行范围(工单 SC-19):大屏按区。
// 🔴 大屏原来是全平台一锅端,而它恰恰最需要按区看:一个区成功率塌了,混进另一个区的健康数据后
// 大屏上还是一片绿(与告警池化同一个病,只是这里表现为「看不出来」)。
import { useScope } from "@/components/scope/ScopeProvider";
import { toScopeParam } from "@/lib/scope/scope";

const { Title, Text } = Typography;

// 运行态 → 中文标签 + 图表色(与 charts.tsx statusColor 口径一致)。
const STATUS_META: Record<string, { color: string }> = {
  succeeded: { color: "#2dd4bf" },
  failed: { color: "#f5577a" },
  running: { color: "#22d3ee" },
  stopped: { color: "#8fb0c2" },
  unknown: { color: "#647c8c" },
};
const SEVERITY_COLOR: Record<string, string> = { P1: "red", P2: "orange", P3: "blue" };
const RISK_COLOR: Record<string, string> = { green: "#2dd4bf", yellow: "#e0a23c", red: "#f5577a" };

export default function OpsScreenPage() {
  const t = useT();
  const [data, setData] = useState<any>(null);
  const [riskBoard, setRiskBoard] = useState<any>(null); // 43-B SLA 风险看板(独立 fetch,不改模块34聚合)
  const [loading, setLoading] = useState(true);
  const [interval, setIntervalMs] = useState(0); // 0=手动;否则毫秒
  const timerRef = useRef<any>(null);
  // @kf-batch 50-WP4ter-coverage
  const { scope } = useScope();
  const scopeParam = toScopeParam(scope);
  const scopeQs = scopeParam ? `?scope=${encodeURIComponent(scopeParam)}` : "";
  // @kf-batch 50-WP4quater-reads(工单 SC-15 已闭环)—— 两张 SLA 卡已按区,不再需要「全部区域」标注。
  // 🔴 保留一个开关位:基线里仍可能有**落章之前学出来的行**(没有区维),那种行由接口回的
  // `legacy: true` 逐行标注 —— 整卡级的免责标注撤掉,免得把已经修好的事说成没修。
  const hasLegacyBaseline = (riskBoard?.baselineTop || []).some((b: any) => b?.legacy);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/ops/summary${scopeQs}`).then((x) => x.json());
      if (res?.success) setData(res.data);
      // 43-B:独立拉 SLA 风险看板(失败不影响主大屏)。
      // @kf-batch 50-WP4quater-reads(工单 SC-15 已闭环)—— 风险看板与基线偏离 Top 现在都按区:
      // SLA 行的区维派生自绑定对象,基线摊平成「任务 × 区」后再排 Top(原来是跨区排序,
      // 同一个任务在 usw2 慢、在主控区快 ⇒ 合计 p90 落在中间,真正的慢链路两边都上不了榜)。
      fetch(`/api/sla/risk-board${scopeQs}`).then((x) => x.json()).then((r) => { if (r?.success) setRiskBoard(r.data); }).catch(() => {});
    } finally {
      setLoading(false);
    }
  }, [scopeQs]);

  useEffect(() => { load(); }, [load]);

  // 自动刷新
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (interval > 0) timerRef.current = setInterval(load, interval);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [interval, load]);

  const s = data?.stats || {};
  const statusSlices: Slice[] = (data?.statusDist || []).map((d: any) => ({
    label: t(statusLabel(d.label)), value: d.value, color: (STATUS_META[d.label] || STATUS_META.unknown).color,
  }));
  const trendPoints = (data?.trend || []).map((p: any) => ({ label: p.label, value: p.value }));
  const topSlowSlices: Slice[] = (data?.topSlow || []).map((r: any, i: number) => ({
    label: r.taskName, value: r.duration, color: ["#22d3ee", "#e0a23c", "#2dd4bf", "#8b6fe8"][i % 4],
  }));
  const ganttRows: GanttRow[] = (data?.gantt || []).map((g: any) => ({
    taskName: g.taskName, taskType: g.taskType, status: g.status, startedAt: g.startedAt, finishedAt: g.finishedAt, duration: g.duration,
  }));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <Title level={3} style={{ marginBottom: 0 }}><FundProjectionScreenOutlined /> {t("运维大屏")}</Title>
        <Space>
          <Select
            value={interval}
            onChange={setIntervalMs}
            style={{ width: 130 }}
            options={[
              { value: 0, label: t("手动刷新") },
              { value: 10000, label: t("每 10 秒") },
              { value: 30000, label: t("每 30 秒") },
              { value: 60000, label: t("每 60 秒") },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={load}>{t("刷新")}</Button>
        </Space>
      </div>

      {loading && !data ? (
        <Spin size="large" style={{ display: "block", margin: "80px auto" }} />
      ) : !data ? (
        <Card><Empty description={t("暂无数据")} /></Card>
      ) : (
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          {/* KPI 行 */}
          <Row gutter={16}>
            <Col span={4}><Card size="small"><Statistic title={t("运行中")} value={s.running ?? 0} valueStyle={{ color: "#22d3ee" }} /></Card></Col>
            <Col span={4}><Card size="small"><Statistic title={t("今日运行")} value={s.todayTotal ?? 0} /></Card></Col>
            <Col span={4}><Card size="small"><Statistic title={t("今日成功")} value={s.todaySuccess ?? 0} valueStyle={{ color: "#2dd4bf" }} /></Card></Col>
            <Col span={4}><Card size="small"><Statistic title={t("今日失败")} value={s.todayFailed ?? 0} valueStyle={{ color: (s.todayFailed ?? 0) > 0 ? "#f5577a" : undefined }} /></Card></Col>
            <Col span={4}><Card size="small"><Statistic title={t("平均耗时")} value={s.avgDuration ?? 0} suffix={t("秒")} /></Card></Col>
            <Col span={4}><Card size="small"><Statistic title={t("成功率")} value={s.successRate ?? 0} suffix="%" valueStyle={{ color: (s.successRate ?? 0) >= 85 ? "#2dd4bf" : "#e0a23c" }} /></Card></Col>
          </Row>

          {/* 分布 / 仪表 / 趋势 */}
          <Row gutter={16}>
            <Col span={8}>
              <Card size="small" title={t("任务态分布")} style={{ height: "100%" }}>
                {statusSlices.length ? <Donut data={statusSlices} centerLabel={t("运行数")} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("暂无运行")} />}
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small" title={t("成功率 / 准点率")} style={{ height: "100%" }}>
                <Row>
                  <Col span={12}><Gauge value={s.successRate ?? 0} label={t("今日成功率")} /></Col>
                  <Col span={12}><Gauge value={data.punctualityRate ?? 100} label={t("今日准点率")} /></Col>
                </Row>
                <Text type="secondary" style={{ fontSize: 12 }}>{t("准点率：终态运行中未超 30 分钟的占比（基线学习留后续）")}</Text>
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small" title={t("近 7 日运行趋势")} style={{ height: "100%" }}>
                {trendPoints.length ? <TrendArea points={trendPoints} height={190} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("暂无趋势")} />}
              </Card>
            </Col>
          </Row>

          {/* 甘特 / Top 慢任务 */}
          <Row gutter={16}>
            <Col span={14}>
              <Card size="small" title={t("最近运行时间线（甘特）")}>
                {ganttRows.length ? <GanttTimeline rows={ganttRows} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("暂无运行记录")} />}
              </Card>
            </Col>
            <Col span={10}>
              <Card size="small" title={t("Top 慢任务（耗时秒）")}>
                {topSlowSlices.length ? <BarList data={topSlowSlices} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("暂无数据")} />}
              </Card>
            </Col>
          </Row>

          {/* 43-B SLA 风险看板(预测破线,破线前预警)——独立卡,不改模块34现有卡 */}
          <Row gutter={16}>
            <Col span={14}>
              <Card size="small" title={<Space size={6}><AlertOutlined /> {t("SLA 风险看板")}
                </Space>}
                extra={<Tag color={(riskBoard?.atRisk || 0) > 0 ? "error" : "success"}>{t("有风险 {n} 条", { n: riskBoard?.atRisk || 0 })}</Tag>}>

                {(riskBoard?.slas || []).length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("暂无 SLA 定义")} />
                ) : (
                  <Space direction="vertical" style={{ width: "100%" }} size={6}>
                    {riskBoard.slas.map((r: any) => (
                      <div key={r.slaId} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 5, background: RISK_COLOR[r.riskLevel] || "#647c8c" }} />
                        <Text style={{ minWidth: 150 }}>{r.name}</Text>
                        <Text type="secondary" style={{ minWidth: 120 }}>{t("承诺")}: {r.target}</Text>
                        <Text type="secondary" style={{ flex: 1 }}>{r.etaAt ? `ETA ${r.etaAt.slice(11, 16)}` : t("未运行")}{r.criticalPathNode ? ` · ${t("卡点")} ${r.criticalPathNode}` : ""}</Text>
                        <Tag color={r.riskLevel === "red" ? "error" : r.riskLevel === "yellow" ? "warning" : "success"}>{t(riskLabel(r.riskLevel))}</Tag>
                      </div>
                    ))}
                  </Space>
                )}
              </Card>
            </Col>
            <Col span={10}>
              <Card size="small" title={<Space size={6}>{t("基线偏离 Top（p90 秒)")}
                {hasLegacyBaseline && (
                  <Tag color="warning" data-testid="ops-baseline-legacy">{t("含落章前学的基线(无区维)")}</Tag>
                )}</Space>}>
                {(riskBoard?.baselineTop || []).length ? (
                  <BarList data={riskBoard.baselineTop.map((b: any, i: number) => ({ label: b.taskName, value: b.p90, color: ["#8b6fe8", "#22d3ee", "#e0a23c", "#2dd4bf"][i % 4] }))} />
                ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("暂无基线,请先学习")} />}
              </Card>
            </Col>
          </Row>

          {/* 最近告警 */}
          <Card size="small" title={<span><BellOutlined /> {t("最近告警")}</span>}>
            {(data.recentAlerts || []).length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("暂无告警")} />
            ) : (
              <Space direction="vertical" style={{ width: "100%" }} size={6}>
                {data.recentAlerts.map((a: any, i: number) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Tag color={SEVERITY_COLOR[a.severity] || "default"}>{a.severity}</Tag>
                    <Text style={{ minWidth: 130 }}>{a.ruleName}</Text>
                    <Text type="secondary" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.msgKey ? t(a.msgKey, a.msgParams || {}) : a.message}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{a.createdAt?.slice(5, 16).replace("T", " ")}</Text>
                  </div>
                ))}
              </Space>
            )}
          </Card>

          <Text type="secondary" style={{ fontSize: 12 }}>{t("生成于")} {data.generatedAt?.slice(0, 19).replace("T", " ")}</Text>
        </Space>
      )}
    </div>
  );
}

function statusLabel(s: string): string {
  return s === "succeeded" ? "成功" : s === "failed" ? "失败" : s === "running" ? "运行中" : s === "stopped" ? "已停止" : s;
}

function riskLabel(r: string): string {
  return r === "red" ? "预测破线" : r === "yellow" ? "接近" : "有余量";
}
