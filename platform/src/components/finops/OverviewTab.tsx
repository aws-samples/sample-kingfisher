"use client";

// FinOps 成本大盘:MetricCard 三卡 + 底座/引擎 Donut + 14 天趋势 TrendArea + Top 服务 BarList。
// 全部复用 charts.tsx 既有组件(零改动);读 /api/finops/overview(纯读秒回,stale 自动后台采集)。

import React, { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Col, Dropdown, Empty, Row, Space, Spin, Tag, Typography, message } from "antd";
import { ReloadOutlined, CloudDownloadOutlined } from "@ant-design/icons";
import { Donut, TrendArea, BarList, MetricCard } from "@/components/dashboard/charts";
import { useT } from "@/lib/i18n/useT";
import { useScope } from "@/components/scope/ScopeProvider";
import { toScopeParam } from "@/lib/scope/scope";

const CAT_COLORS: Record<string, string> = { base: "#5B8FF9", engine: "#5AD8A6", other: "#F6BD16" };

interface Overview {
  monthToDateUsd: number;
  yesterdayUsd: number;
  prevDayUsd: number;
  byCategory: { base: number; engine: number; other: number };
  topServices: { service: string; category: string; amountUsd: number }[];
  dailyTrend: { date: string; total: number }[];
  watermark: string | null;
  stale: boolean;
  // @kf-batch 50-WP4quater-reads(工单 SC-24)—— 按区视角下服务端补的字段
  scopedRegions?: string[];
  unattributedUsd?: number;
  unattributedNote?: string;
  // @kf-batch 50-WP6-cost-by-region —— 第一层 region 卡片(O3a)
  byRegion?: RegionCard[];
  regionlessMonthToDateUsd?: number;
}

interface RegionCard {
  region: string;
  monthToDateUsd: number;
  prevPeriodUsd: number;
  momPct: number | null;
}

/**
 * @kf-batch 50-WP6-cost-by-region(WP-6 施工序 5,INTERACTION §3.2)—— 大盘第一层:按 **AWS region** 的卡片。
 * 🔴 标题旁必须写明「按 AWS region 分组,非 target 归因」:CE 只给到 region,同区两套执行环境的钱分不开,
 *    不写出来用户会把卡片金额当成某个执行环境的花费。
 * 点卡下钻 = 把顶栏视角切到该区的执行环境(同区多个 ⇒ 列出来让用户选;该区没有执行环境 ⇒ 不可点,如实标注)。
 */
function RegionCards({ cards, regionlessUsd }: { cards: RegionCard[]; regionlessUsd: number }) {
  const t = useT();
  const { targets, setScope } = useScope();
  if (!cards.length && !(regionlessUsd > 0)) return null;
  return (
    <Card
      size="small"
      style={{ marginBottom: 12 }}
      data-testid="finops-region-cards"
      title={
        <Space size={8}>
          <span>{t("按区成本(本月累计)")}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }} data-testid="finops-region-cards-caption">
            {t("按 AWS region 分组,非 target 归因")}
          </Typography.Text>
        </Space>
      }
    >
      <Row gutter={[12, 12]}>
        {cards.map((c) => {
          const inRegion = (targets || []).filter((x) => x.region === c.region);
          const body = (
            <Card
              size="small"
              hoverable={inRegion.length > 0}
              data-testid="finops-region-card"
              data-region={c.region}
              onClick={inRegion.length === 1 ? () => setScope({ kind: "target", targetId: inRegion[0].targetId }) : undefined}
            >
              <MetricCard
                value={`$${c.monthToDateUsd.toFixed(2)}`}
                label={c.region}
                sub={
                  c.momPct === null
                    ? t("上月同期无数据")
                    : `${c.momPct >= 0 ? "▲" : "▼"}${Math.abs(c.momPct).toFixed(0)}% ${t("较上月同期")}`
                }
              />
              {inRegion.length === 0 ? (
                <Tag style={{ marginTop: 4 }} data-testid="finops-region-card-no-target">{t("此区无执行环境")}</Tag>
              ) : inRegion.length > 1 ? (
                <Tag color="blue" style={{ marginTop: 4 }}>{t("{n} 个执行环境,点击选择", { n: inRegion.length })}</Tag>
              ) : null}
            </Card>
          );
          return (
            <Col key={c.region} xs={24} sm={12} md={8} lg={6}>
              {inRegion.length > 1 ? (
                <Dropdown
                  trigger={["click"]}
                  menu={{
                    items: inRegion.map((x) => ({ key: x.targetId, label: `${x.displayName}(${x.targetId})` })),
                    onClick: ({ key }) => setScope({ kind: "target", targetId: String(key) }),
                  }}
                >
                  <div>{body}</div>
                </Dropdown>
              ) : (
                body
              )}
            </Col>
          );
        })}
        {regionlessUsd > 0 && (
          <Col xs={24} sm={12} md={8} lg={6}>
            <Card size="small" data-testid="finops-region-card-regionless">
              <MetricCard value={`$${regionlessUsd.toFixed(2)}`} label={t("无区域归属(全局服务)")} sub={t("Tax / Support / Route 53 等,不属于任何区")} />
            </Card>
          </Col>
        )}
      </Row>
    </Card>
  );
}

export default function OverviewTab() {
  const t = useT();
  // @kf-batch 50-WP4quater-reads(工单 SC-24)—— 大盘按执行范围。
  // 🔴 单区视角的「本月累计」是**那个区的**钱,不含无区域归属的部分(存量行 + 全局服务)⇒
  // 上面那条 Alert 必须把这件事说出来,否则用户会拿它去核对 AWS 账单总额然后怀疑平台算错了。
  const { scope } = useScope();
  const scopeParam = toScopeParam(scope);
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [collecting, setCollecting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/finops/overview${scopeParam ? `?scope=${encodeURIComponent(scopeParam)}` : ""}`)
      .then((r) => r.json())
      .then((d) => setData(d?.data || null))
      .finally(() => setLoading(false));
    // 🔴 `scopeParam` 进 deps:切范围不重载页面,靠这里重拉(护栏 4)
  }, [scopeParam]);

  useEffect(() => { load(); }, [load]);

  const collectNow = async () => {
    setCollecting(true);
    try {
      const r = await fetch("/api/finops/collect", { method: "POST" });
      const d = await r.json();
      if (r.ok) {
        message.success(t("采集完成:账单 {rows} 行,归因 {n} 条", { rows: d?.data?.ce?.rows ?? 0, n: d?.data?.sweep?.attributed ?? 0 }));
        load();
      } else {
        message.error(d?.error || t("采集失败"));
      }
    } finally {
      setCollecting(false);
    }
  };

  if (loading && !data) return <div style={{ textAlign: "center", padding: 48 }}><Spin /></div>;

  const delta =
    data && data.prevDayUsd > 0 ? (((data.yesterdayUsd - data.prevDayUsd) / data.prevDayUsd) * 100).toFixed(0) : null;
  const hasData = !!data && (data.monthToDateUsd > 0 || data.dailyTrend.some((p) => p.total > 0));

  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Button icon={<CloudDownloadOutlined />} loading={collecting} onClick={collectNow} type="primary">
          {t("立即采集")}
        </Button>
        <Button icon={<ReloadOutlined />} onClick={load}>{t("刷新")}</Button>
        {data?.watermark ? (
          <Tag>{t("账单水位")}: {new Date(data.watermark).toLocaleString()}</Tag>
        ) : (
          <Tag color="orange">{t("尚未采集,点「立即采集」拉取账单")}</Tag>
        )}
      </Space>

      {!hasData ? (
        <Empty description={t("暂无成本数据")} />
      ) : (
        <>
          {/* @kf-batch 50-WP4quater-reads(工单 SC-24)—— 🔴 把「哪些钱没算进这个合计」说清楚。
              不说的话用户会拿上面的数字去对 AWS 账单总额,对不上,然后怀疑平台算错了。 */}
          {typeof data?.unattributedUsd === "number" && data.unattributedUsd > 0 && (
            <Alert
              type="info" showIcon style={{ marginBottom: 12 }} data-testid="finops-unattributed"
              message={t("本合计只含 {r} 的花费;另有 ${amt} 未计入", { r: (data.scopedRegions || []).join("、"), amt: data.unattributedUsd.toFixed(2) })}
              description={data.unattributedNote}
            />
          )}
          <RegionCards cards={data!.byRegion || []} regionlessUsd={data!.regionlessMonthToDateUsd || 0} />
          <Row gutter={12} style={{ marginBottom: 12 }}>
            <Col span={8}><Card size="small"><MetricCard value={`$${data!.monthToDateUsd.toFixed(2)}`} label={data!.scopedRegions?.length ? t("本月累计({r})", { r: data!.scopedRegions.join("、") }) : t("本月累计")} /></Card></Col>
            <Col span={8}><Card size="small"><MetricCard value={`$${data!.yesterdayUsd.toFixed(2)}`} label={t("昨日花费")} sub={delta !== null ? `${Number(delta) >= 0 ? "+" : ""}${delta}% ${t("环比前日")}` : undefined} /></Card></Col>
            <Col span={8}><Card size="small"><MetricCard value={`$${data!.byCategory.engine.toFixed(2)}`} label={t("本月引擎花费(可归因工作负载)")} /></Card></Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Card size="small" title={t("本月构成(底座/引擎/其他)")}>
                <Donut
                  data={[
                    { label: t("平台底座"), value: data!.byCategory.base, color: CAT_COLORS.base },
                    { label: t("计算引擎"), value: data!.byCategory.engine, color: CAT_COLORS.engine },
                    { label: t("其他"), value: data!.byCategory.other, color: CAT_COLORS.other },
                  ].filter((s) => s.value > 0.005)}
                />
              </Card>
            </Col>
            <Col span={16}>
              <Card size="small" title={t("近 14 天花费趋势(USD)")}>
                <TrendArea points={data!.dailyTrend.map((p) => ({ label: p.date.slice(5), value: Number(p.total.toFixed(2)) }))} />
              </Card>
            </Col>
          </Row>
          <Card size="small" title={t("本月 Top 服务")} style={{ marginTop: 12 }}>
            <BarList
              data={data!.topServices.map((s) => ({
                label: s.service,
                value: Number(s.amountUsd.toFixed(2)),
                color: CAT_COLORS[s.category] || CAT_COLORS.other,
              }))}
            />
          </Card>
        </>
      )}
    </div>
  );
}
