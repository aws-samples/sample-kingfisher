"use client";

import React, { useState, useEffect } from "react";
import { useScope } from "@/components/scope/ScopeProvider";
import { landingOfScope, toScopeParam } from "@/lib/scope/scope";
import { Card, Button, Space, Modal, Input, Select, Empty, Spin, message, Drawer, Table, Tag, Statistic, Popconfirm } from "antd";
import { BarChartOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useT } from "@/lib/i18n/useT";

const AGG_OPTS = [
  { value: "count", label: "计数 (count)" },
  { value: "count_distinct", label: "去重计数 (count distinct)" },
  { value: "sum", label: "求和 (sum)" },
  { value: "avg", label: "平均 (avg)" },
  { value: "min", label: "最小 (min)" },
  { value: "max", label: "最大 (max)" },
];
const FORMAT_OPTS = [
  { value: "number", label: "数值" },
  { value: "currency", label: "货币" },
  { value: "percent", label: "百分比" },
];

function fmt(v: any, m: any): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const s = n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (m.format === "currency") return `${m.unit || "¥"} ${s}`;
  if (m.format === "percent") return `${s}%`;
  return m.unit ? `${s} ${m.unit}` : s;
}

function Spark({ data }: { data: number[] }) {
  const t = useT();
  if (!data || data.length < 2) return <span style={{ color: "#bbb", fontSize: 11 }}>{t("趋势数据不足")}</span>;
  const w = 160, h = 32;
  const min = Math.min(...data), max = Math.max(...data);
  const rng = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / rng) * (h - 4) - 2}`).join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke="#1677ff" strokeWidth="1.5" />
    </svg>
  );
}

export default function MetricsPage() {
  // @kf-batch 50-WP4quater-reads(工单 SC-13)—— 指标值按区:列表读 `?scope=`,计算落点走 body。
  const { scope } = useScope();
  const scopeParam = toScopeParam(scope);
  const scopeQs = scopeParam ? `?scope=${encodeURIComponent(scopeParam)}` : "";
  // @kf-batch 50-WP31-place-first-class —— 计算落点唯一作者 `landingOfScope`(单区视角 = 该区;「全部 / 对比」= 显式主控区)。
  //   原来非单区视角发 `{}`、由服务端「没给 = 主控区」兜 ⇒ 服务端现在缺落点一律 400。
  const computeTargetId = landingOfScope(scope);
  const { getToken, user, loading: authLoading } = useAuth();
  const t = useT();
  const [isAdmin, setIsAdmin] = useState(false);
  const [metrics, setMetrics] = useState<any[]>([]);
  const [values, setValues] = useState<Record<string, any>>({});
  const [catalog, setCatalog] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<any>({ name: "", description: "", fqn: undefined, agg: "count", measureColumn: "", dimensionColumn: "", timeColumn: "", unit: "", format: "number" });
  const [detail, setDetail] = useState<any>(null);
  const [detailData, setDetailData] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const authedFetch = async (url: string, init?: RequestInit): Promise<Response | null> => {
    const token = await getToken();
    if (!token) return null; // 未登录由全局 layout 守卫处理,此处不硬跳避免清空 MultiTabs 页签
    const res = await fetch(url, { ...init, headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) } });
    if (res.status === 401) return null; // 未登录由全局 layout 守卫处理,此处不硬跳避免清空 MultiTabs 页签
    return res;
  };

  const loadMetrics = async () => {
    setLoading(true);
    try {
      const res = await authedFetch(`/api/metrics${scopeQs}`);
      if (!res) return;
      const d = await res.json();
      setMetrics(d.success ? d.data : []);
    } finally { setLoading(false); }
  };
  const loadCatalog = async () => {
    const res = await authedFetch(`/api/governance/catalog?keyword=${scopeParam ? `&scope=${encodeURIComponent(scopeParam)}` : ""}`);
    if (!res) return;
    const d = await res.json();
    setCatalog(d.success ? d.data : []);
  };

  useEffect(() => {
    if (authLoading) return;
    if (!user) return; // 未登录由全局 layout 守卫处理,此处不硬跳避免清空 MultiTabs 页签
    (async () => {
      const token = await getToken();
      if (token) { try { const p = JSON.parse(atob(token.split(".")[1] || "")); setIsAdmin((p["cognito:groups"] || []).includes("bgp-admin")); } catch {} }
    })();
    loadMetrics();
    loadCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      // 🔴 计算落点走 body(写/执行路由不读 `?scope=`,SPEC §2.6.3)
      const res = await authedFetch("/api/metrics/compute-all", { method: "POST", body: JSON.stringify({ targetId: computeTargetId }) });
      if (!res) return;
      const d = await res.json();
      if (d?.success) { setValues(d.data); message.success(t("已计算全部指标")); loadMetrics(); }
      else message.error(d?.error?.message || t("计算失败"));
    } finally { setRefreshing(false); }
  };

  const doCreate = async () => {
    if (!form.name?.trim()) { message.warning(t("请输入指标名称")); return; }
    if (!form.fqn) { message.warning(t("请选择数据表")); return; }
    const res = await authedFetch("/api/metrics", { method: "POST", body: JSON.stringify(form) });
    if (!res) return;
    const d = await res.json();
    if (d?.success) { message.success(t("指标已创建")); setCreateOpen(false); setForm({ name: "", description: "", fqn: undefined, agg: "count", measureColumn: "", dimensionColumn: "", timeColumn: "", unit: "", format: "number" }); loadMetrics(); }
    else message.error(d?.error?.message || t("创建失败"));
  };

  const openDetail = async (m: any) => {
    setDetail(m); setDetailData(null); setDetailLoading(true);
    try {
      const res = await authedFetch(`/api/metrics/${m.metricId}/compute`, { method: "POST", body: JSON.stringify({ targetId: computeTargetId }) });
      if (!res) return;
      const d = await res.json();
      if (d?.success) { setDetailData(d.data); loadMetrics(); } else message.error(d?.error?.message || t("计算失败"));
    } finally { setDetailLoading(false); }
  };

  const delMetric = async (metricId: string) => {
    const res = await authedFetch(`/api/metrics/${metricId}`, { method: "DELETE" });
    if (!res) return;
    const d = await res.json();
    if (d?.success) { message.success(t("已删除")); loadMetrics(); } else message.error(d?.error?.message || t("删除失败"));
  };

  const curValue = (m: any) => (values[m.metricId]?.value ?? m.lastValue);
  const curSnaps = (m: any): number[] => (values[m.metricId]?.snapshots || []).map((s: any) => s.value);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}><BarChartOutlined /> {t("指标中台")}</h2>
        <Space>
          {isAdmin && <Button icon={<ReloadOutlined />} loading={refreshing} onClick={refresh}>{t("计算全部")}</Button>}
          {isAdmin && <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>{t("新建指标")}</Button>}
        </Space>
      </div>
      <p style={{ color: "#888", marginTop: -8 }}>{t("统一定义业务指标（口径一处定义、处处复用），对 Redshift 计算当前值与趋势。")}{!isAdmin && t("（建/算指标需平台管理员）")}</p>

      {loading ? <Spin size="large" style={{ display: "block", margin: "60px auto" }} /> :
        metrics.length === 0 ? <Card><Empty description={isAdmin ? t("暂无指标，点「新建指标」") : t("暂无指标")} /></Card> : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
            {metrics.map((m) => (
              <Card key={m.metricId} size="small" hoverable onClick={() => openDetail(m)}
                title={<span>{m.name}</span>}
                extra={isAdmin && <Popconfirm title={t("删除该指标？")} onConfirm={(e) => { (e as any)?.stopPropagation?.(); delMetric(m.metricId); }} onCancel={(e) => (e as any)?.stopPropagation?.()}><a style={{ color: "red" }} onClick={(e) => e.stopPropagation()}>{t("删除")}</a></Popconfirm>}>
                <div style={{ fontSize: 30, fontWeight: 600, color: "#1677ff" }}>{fmt(curValue(m), m)}</div>
                <div style={{ margin: "8px 0" }}><Spark data={curSnaps(m)} /></div>
                <div style={{ fontSize: 12, color: "#888" }}>
                  <div>{t(AGG_OPTS.find((a) => a.value === m.agg)?.label || "")}{m.measureColumn ? ` · ${m.measureColumn}` : ""}</div>
                  <div title={m.fqn}>{m.fqn?.split(".").slice(-2).join(".")}</div>
                  <div>{m.lastComputedAt ? t("计算于 {time}", { time: new Date(m.lastComputedAt).toLocaleString() }) : t("尚未计算")}</div>
                </div>
              </Card>
            ))}
          </div>
        )}

      <Modal title={t("新建指标")} open={createOpen} onOk={doCreate} onCancel={() => setCreateOpen(false)} okText={t("创建")} width={560}>
        <Space direction="vertical" style={{ width: "100%" }}>
          <Input addonBefore={t("名称")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("如 客户总数")} />
          <Input addonBefore={t("说明")} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <Select showSearch style={{ width: "100%" }} placeholder={t("选择数据表")} value={form.fqn}
            onChange={(v) => setForm({ ...form, fqn: v })}
            options={catalog.map((c) => ({ label: c.fqn, value: c.fqn }))} />
          <Space wrap>
            <Select style={{ width: 200 }} value={form.agg} onChange={(v) => setForm({ ...form, agg: v })} options={AGG_OPTS.map((o) => ({ ...o, label: t(o.label) }))} />
            {form.agg !== "count" && <Input addonBefore={t("度量列")} style={{ width: 220 }} value={form.measureColumn} onChange={(e) => setForm({ ...form, measureColumn: e.target.value })} placeholder={t("如 amount")} />}
          </Space>
          <Space wrap>
            <Input addonBefore={t("维度列(可选)")} value={form.dimensionColumn} onChange={(e) => setForm({ ...form, dimensionColumn: e.target.value })} placeholder={t("如 region")} />
            <Input addonBefore={t("时间列(可选)")} value={form.timeColumn} onChange={(e) => setForm({ ...form, timeColumn: e.target.value })} placeholder={t("如 signup_date")} />
          </Space>
          <Space wrap>
            <Input addonBefore={t("单位")} style={{ width: 200 }} value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder={t("如 个 / 元 / %")} />
            <Select style={{ width: 160 }} value={form.format} onChange={(v) => setForm({ ...form, format: v })} options={FORMAT_OPTS.map((o) => ({ ...o, label: t(o.label) }))} />
          </Space>
        </Space>
      </Modal>

      <Drawer title={detail?.name} open={!!detail} onClose={() => setDetail(null)} width={560}>
        {detail && (
          <Space direction="vertical" style={{ width: "100%" }} size="large">
            <div>
              <Statistic title={t("当前值")} value={fmt(detailData?.value ?? detail.lastValue, detail)} valueStyle={{ color: "#1677ff" }} />
              <div style={{ color: "#888", fontSize: 12, marginTop: 4 }}>
                {detail.description || "—"}<br />
                {t("表")} {detail.fqn}<br />
                {t(AGG_OPTS.find((a) => a.value === detail.agg)?.label || "")}{detail.measureColumn ? ` · ${detail.measureColumn}` : ""}
              </div>
            </div>
            {detailLoading && <Spin />}
            {detailData?.dimension?.length > 0 && (
              <Card size="small" title={t("按 {dim} 分布", { dim: detail.dimensionColumn })}>
                <Table size="small" rowKey="k" pagination={false} dataSource={detailData.dimension}
                  columns={[{ title: detail.dimensionColumn, dataIndex: "k" }, { title: t("值"), dataIndex: "value", render: (v: number) => v.toLocaleString() }]} />
              </Card>
            )}
            {detailData?.series?.length > 0 && (
              <Card size="small" title={t("按 {time} 趋势", { time: detail.timeColumn })}>
                <Spark data={detailData.series.map((s: any) => s.value)} />
                <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>{t("{n} 个时间点", { n: detailData.series.length })}</div>
              </Card>
            )}
            <Card size="small" title={t("计算快照历史")}>
              <Spark data={(detailData?.snapshots || []).map((s: any) => s.value)} />
              <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>{t("{n} 次计算", { n: (detailData?.snapshots || []).length })}</div>
            </Card>
          </Space>
        )}
      </Drawer>
    </div>
  );
}
