"use client";

import React, { useEffect, useState } from "react";
import { Card, Col, Row, Statistic, Tag, Empty, Spin } from "antd";
import {
  DatabaseOutlined,
  SyncOutlined,
  ApartmentOutlined,
  CodeOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  RiseOutlined,
  ClockCircleOutlined,
} from "@ant-design/icons";
import { Donut, TrendArea, BarList, type Slice } from "@/components/dashboard/charts";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useRouter } from "next/navigation";
import { groupsFromToken, isAnalystOnly } from "@/lib/auth/roles";
import { useT } from "@/lib/i18n/useT";
// @kf-batch 53-guide-v1 —— 首页新手引导入口
import GuideHomeCard from "@/components/guide/GuideHomeCard";
// @kf-batch 50-WP4ter-coverage
import { useScope } from "@/components/scope/ScopeProvider";
import OtherScopesHint from "@/components/scope/OtherScopesHint";
import { toScopeParam } from "@/lib/scope/scope";

function arr(d: any): any[] {
  return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : Array.isArray(d?.runs) ? d.runs : [];
}

interface Run {
  status?: string;
  taskType?: string;
  triggeredBy?: string;
  taskName?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

interface Metric {
  name: string;
  lastValue?: number;
  unit?: string;
}

const STATUS_META: Record<string, { label: string; color: string }> = {
  succeeded: { label: "成功", color: "#2dd4bf" },
  failed: { label: "失败", color: "#f5577a" },
  running: { label: "运行中", color: "#22d3ee" },
  other: { label: "其他", color: "#e0a23c" },
};

// t 由调用方传入(STATUS_META.label 为中文 key,渲染时翻译)。
function statusTag(s: string | undefined, t: (zh: string) => string) {
  const m = STATUS_META[s || ""] || STATUS_META.other;
  return <Tag color={m.color === "#2dd4bf" ? "cyan" : m.color === "#f5577a" ? "magenta" : m.color === "#22d3ee" ? "blue" : "orange"}>{t(m.label)}</Tag>;
}

function timeAgo(iso: string | null | undefined, t: (zh: string, p?: Record<string, string | number>) => string): string {
  if (!iso) return "-";
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "-";
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return t("刚刚");
  if (min < 60) return t("{min} 分钟前", { min });
  const h = Math.floor(min / 60);
  if (h < 24) return t("{h} 小时前", { h });
  return t("{d} 天前", { d: Math.floor(h / 24) });
}

const cardHead = { minHeight: 40 } as const;

export default function HomePage() {
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState({ datasources: 0, syncTasks: 0, workflows: 0, etlJobs: 0, emrJobs: 0 });
  const [runs, setRuns] = useState<Run[]>([]);
  const [runStats, setRunStats] = useState<any>({});
  const [dsTypes, setDsTypes] = useState<Record<string, number>>({});
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const router = useRouter();
  const { getToken } = useAuth();
  const t = useT();

  useEffect(() => {
    // 运营分析账号无首页权限，直接跳转「智能问数」（其首页与数据由网关 403 收口）。
    (async () => {
      if (isAnalystOnly(groupsFromToken(await getToken()))) {
        router.replace("/genbi");
      }
    })();
  }, [getToken, router]);

  // @kf-batch 50-WP4ter-coverage —— 当前执行范围(顶栏选的那个;URL 是权威)。
  // `scopeQs` 用于「本来没有 query 的地址」,`scopeAmp` 用于「已经带了 query 的地址」——
  // 两个变量而不是一个字符串拼接:拼错一个 `?`/`&` 的症状是**参数被静默丢掉**(过滤看起来没生效)。
  const { scope } = useScope();
  const scopeParam = toScopeParam(scope);
  const scopeQs = scopeParam ? `?scope=${encodeURIComponent(scopeParam)}` : "";
  const scopeAmp = scopeParam ? `&scope=${encodeURIComponent(scopeParam)}` : "";

  useEffect(() => {
    (async () => {
      // 运营分析账号无首页数据权限（网关 403）：跳过仪表盘数据拉取，避免无谓的 403 与 console 噪声，
      // 由上一个 effect 重定向到「智能问数」。
      if (isAnalystOnly(groupsFromToken(await getToken()))) {
        setLoading(false);
        return;
      }
      try {
        // @kf-batch 50-WP4ter-coverage —— 🔴 六块统计逐个带上当前执行范围(工单 SC-1)。
        // 以前这里一个 scope 都不带 ⇒ 切到某个区,首页数字仍是全平台合计,而各详情页已按区过滤 ——
        // **同一份数据在两页给出两个数**,比「没过滤」更让人不信任界面。
        const [ds, sync, wf, etl, emr, runData, mt] = await Promise.all([
          fetch(`/api/datasources${scopeQs}`).then((r) => r.json()).then(arr),
          fetch(`/api/sync${scopeQs}`).then((r) => r.json()).then(arr),
          fetch(`/api/workflow${scopeQs}`).then((r) => r.json()).then(arr),
          fetch(`/api/etl-jobs${scopeQs}`).then((r) => r.json()).then(arr),
          // 模块 33-A：EMR Serverless 离线作业(独立表 bgp-engine-jobs），首页资源计数须纳入。
          fetch(`/api/engines/emr-serverless${scopeQs}`).then((r) => r.json()).then((d) => arr(d?.success ? d.data : d)),
          fetch(`/api/monitor/runs?limit=500${scopeAmp}`).then((r) => r.json()),
          // 模块39:指标已收敛到「数据建模 → 指标体系」——首页核心业务指标改读该唯一指标源。
          // @kf-batch 50-WP4quater-reads(工单 SC-37)—— 🔴🔴 上一版这里写的是「刻意不带 scope:
          // 指标是平台级定义,本身不分区」。用户 2026-09-10 驳回:「这里为什么不能做成区域维度?
          // 我认为都可以切出来的。」而且这个说法本身站不住 —— 指标**定义**是一份,但它的**计算值**
          // 是从某个区的数仓算出来的:把主控区算出的数字挂在 us-west-2 视角上,就是个错数字。
          // ⇒ 带 scope;单区视角服务端会把 `value` 解析成那个区的,没算过就回 `noValueInScope`。
          fetch(`/api/modeling/model-metrics${scopeQs}`).then((r) => r.json()).then((d) => arr(d?.success ? d.data : d)),
        ]);
        setCounts({ datasources: ds.length, syncTasks: sync.length, workflows: wf.length, etlJobs: etl.length, emrJobs: emr.length });
        const rs = arr(runData);
        setRuns(rs);
        setRunStats(runData?.stats || {});
        const types: Record<string, number> = {};
        for (const d of ds) {
          const t = (d.type || d.dbType || "其他").toString();
          types[t] = (types[t] || 0) + 1;
        }
        setDsTypes(types);
        setMetrics(mt);
      } finally {
        setLoading(false);
      }
    })();
    // @kf-batch 50-WP4ter-coverage —— 切区不重载页面,靠 deps 重拉(护栏 4)
  }, [getToken, scopeQs, scopeAmp]);

  // 运行状态分布
  const statusDist: Slice[] = (() => {
    const c: Record<string, number> = { succeeded: 0, failed: 0, running: 0, other: 0 };
    for (const r of runs) {
      const k = r.status && c[r.status] !== undefined ? r.status : "other";
      c[k]++;
    }
    return (["succeeded", "failed", "running", "other"] as const)
      .map((k) => ({ label: t(STATUS_META[k].label), value: c[k], color: STATUS_META[k].color }))
      .filter((s) => s.value > 0);
  })();

  // 近 7 日运行趋势
  const trend: { label: string; value: number }[] = (() => {
    const days: { key: string; label: string }[] = [];
    // B-138:按 UTC 算日期(key 本来就是 toISOString 的 UTC 日),服务端(UTC)与浏览器(本地时区)首帧才一致;按本地时区算在跨日时段会水合不一致
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
      const key = d.toISOString().slice(0, 10);
      days.push({ key, label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}` });
    }
    const byDay: Record<string, number> = {};
    for (const r of runs) {
      const day = (r.startedAt || r.finishedAt || "").slice(0, 10);
      if (day) byDay[day] = (byDay[day] || 0) + 1;
    }
    return days.map((d) => ({ label: d.label, value: byDay[d.key] || 0 }));
  })();

  // 触发方式分布
  const triggerDist: Slice[] = (() => {
    let sch = 0, man = 0;
    for (const r of runs) (r.triggeredBy === "schedule" ? (sch++) : (man++));
    return [
      { label: t("定时调度"), value: sch, color: "#22d3ee" },
      { label: t("手动触发"), value: man, color: "#37accd" },
    ].filter((s) => s.value > 0);
  })();

  // 资源构成
  const resourceBars: Slice[] = [
    { label: t("数据源"), value: counts.datasources, color: "#22d3ee" },
    { label: t("同步任务"), value: counts.syncTasks, color: "#34d3e0" },
    { label: t("工作流"), value: counts.workflows, color: "#2dd4bf" },
    { label: t("ETL 作业"), value: counts.etlJobs, color: "#56e0f2" },
    { label: t("EMR 作业"), value: counts.emrJobs, color: "#7dd3fc" },
  ];

  // 数据源类型构成
  const dsTypePalette = ["#22d3ee", "#37accd", "#2dd4bf", "#56e0f2", "#2b738c"];
  const dsTypeBars: Slice[] = Object.entries(dsTypes).map(([t, v], i) => ({
    label: t.toUpperCase(),
    value: v,
    color: dsTypePalette[i % dsTypePalette.length],
  }));

  const recentRuns = runs.slice(0, 7);

  if (loading) {
    return (
      <div style={{ textAlign: "center", padding: "120px 0" }}>
        <Spin size="large" tip={t("加载总览数据…")}>
          <div style={{ height: 1 }} />
        </Spin>
      </div>
    );
  }

  return (
    <div>
      <h2 style={{ marginBottom: 4 }}>{t("总览")}</h2>
      <div style={{ color: "#8fb0c2", marginBottom: 16, fontSize: 13 }}>
        {t("平台资源、运行态势与核心指标一览")}
      </div>
      <GuideHomeCard />

      {/* @kf-batch 50-WP4ter-coverage —— 护栏 1:单区视角常驻「其他执行范围还有 N 条」。
          首页是**计数页**,漏掉的东西在这里最难被发现(数字小了没人会察觉),所以这条尤其必要。 */}
      <OtherScopesHint resources={["datasource", "sync", "workflow", "etl-job", "engine-job"]} />

      {/* KPI 卡片 */}
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} lg={3}><Card><Statistic title={t("数据源")} value={counts.datasources} prefix={<DatabaseOutlined style={{ color: "#22d3ee" }} />} /></Card></Col>
        <Col xs={12} sm={8} lg={3}><Card><Statistic title={t("同步任务")} value={counts.syncTasks} prefix={<SyncOutlined style={{ color: "#34d3e0" }} />} /></Card></Col>
        <Col xs={12} sm={8} lg={3}><Card><Statistic title={t("工作流")} value={counts.workflows} prefix={<ApartmentOutlined style={{ color: "#2dd4bf" }} />} /></Card></Col>
        <Col xs={12} sm={8} lg={3}><Card><Statistic title={t("ETL 作业")} value={counts.etlJobs} prefix={<CodeOutlined style={{ color: "#56e0f2" }} />} /></Card></Col>
        <Col xs={12} sm={8} lg={3}><Card><Statistic title={t("EMR 作业")} value={counts.emrJobs} prefix={<CodeOutlined style={{ color: "#7dd3fc" }} />} /></Card></Col>
        <Col xs={12} sm={8} lg={3}><Card><Statistic title={t("今日运行")} value={runStats.todayTotal || 0} prefix={<ThunderboltOutlined style={{ color: "#e0a23c" }} />} /></Card></Col>
        <Col xs={12} sm={8} lg={3}><Card><Statistic title={t("今日成功率")} value={runStats.successRate ?? 0} suffix="%" prefix={<RiseOutlined style={{ color: "#2dd4bf" }} />} valueStyle={{ color: "#2dd4bf" }} /></Card></Col>
      </Row>

      {/* 运行状态分布 + 近 7 日趋势 */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={9}>
          <Card title={t("运行状态分布")} styles={{ header: cardHead }}>
            {statusDist.length ? <Donut data={statusDist} centerLabel={t("运行总数")} /> : <Empty description={t("暂无运行记录")} image={Empty.PRESENTED_IMAGE_SIMPLE} />}
          </Card>
        </Col>
        <Col xs={24} lg={15}>
          <Card title={t("近 7 日运行趋势")} styles={{ header: cardHead }} extra={<span style={{ color: "#8fb0c2", fontSize: 12 }}>{t("运行中")} {runStats.running || 0}</span>}>
            <TrendArea points={trend} />
          </Card>
        </Col>
      </Row>

      {/* 资源构成 + 触发方式/数据源类型 + 核心指标 */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={8}>
          <Card title={t("资源构成")} styles={{ header: cardHead }}>
            <BarList data={resourceBars} />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title={t("运行触发方式")} styles={{ header: cardHead }}>
            {triggerDist.length ? (
              <Donut data={triggerDist} centerLabel={t("触发总数")} />
            ) : (
              <Empty description={t("暂无运行记录")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
            {dsTypeBars.length > 0 && (
              <div style={{ marginTop: 16, borderTop: "1px solid #1d4254", paddingTop: 14 }}>
                <div style={{ color: "#8fb0c2", fontSize: 12, marginBottom: 10 }}>{t("数据源类型")}</div>
                <BarList data={dsTypeBars} />
              </div>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title={t("核心业务指标")} styles={{ header: cardHead }} extra={<a href="/modeling" style={{ fontSize: 12 }}>{t("更多")}</a>}>
            {metrics.length ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {metrics.slice(0, 4).map((m, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: i < Math.min(metrics.length, 4) - 1 ? "1px dashed #1d4254" : "none", paddingBottom: 10 }}>
                    <span style={{ color: "#8fb0c2", fontSize: 13 }}>{m.name}</span>
                    <span><span style={{ color: "#56e0f2", fontWeight: 700, fontSize: 22 }}>{(m.lastValue ?? 0).toLocaleString()}</span><span style={{ color: "#8fb0c2", fontSize: 12, marginLeft: 4 }}>{m.unit || ""}</span></span>
                  </div>
                ))}
              </div>
            ) : (
              <Empty description={t("暂无指标，去 数据建模 → 指标体系 创建")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </Card>
        </Col>
      </Row>

      {/* 最近运行 */}
      <Row style={{ marginTop: 16 }}>
        <Col span={24}>
          <Card title={t("最近运行")} styles={{ header: cardHead }} extra={<a href="/monitor" style={{ fontSize: 12 }}>{t("查看全部")}</a>}>
            {recentRuns.length ? (
              <div>
                {recentRuns.map((r, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "10px 4px",
                      borderBottom: i < recentRuns.length - 1 ? "1px solid #163243" : "none",
                    }}
                  >
                    {statusTag(r.status, t)}
                    <span style={{ color: "#cfe6f0", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.taskName || t("(未命名)")}</span>
                    <Tag bordered={false} style={{ background: "rgba(34,211,238,0.1)", color: "#8fb0c2" }}>{r.taskType || "-"}</Tag>
                    <span style={{ color: "#8fb0c2", fontSize: 12, width: 70, textAlign: "center" }}>{r.triggeredBy === "schedule" ? t("定时") : t("手动")}</span>
                    <span style={{ color: "#8fb0c2", fontSize: 12, width: 88, textAlign: "right" }}><ClockCircleOutlined /> {timeAgo(r.startedAt || r.finishedAt, t)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <Empty description={t("暂无运行记录")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
