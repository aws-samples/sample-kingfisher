"use client";

// 模块 37 v4 — 分析看板工作台(QuickSight 式:一个画布 N 个视觉对象 + 绑字段·作用域筛选器)。
// 隔离红线:BI 私有组件;复用 FieldConfigurator / WidgetRenderer / DashboardGrid(全不改);
// 取数走 /api/bi/analysis-query(筛选器按字段+作用域注入,根治"没生效");CRUD 走 /api/bi/analyses。
// 旧报表库/仪表盘的 lib/API/表完全保留,本面板可「从报表库导入」复用旧报表。

import React, { useEffect, useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import {
  Card, Table, Button, Tag, Space, Input, Select, Segmented, Typography, message,
  Popconfirm, Spin, Empty, Tooltip, Modal, Checkbox, Divider, Switch,
} from "antd";
import {
  FundProjectionScreenOutlined, ReloadOutlined, PlusOutlined, EditOutlined, DeleteOutlined,
  EyeOutlined, DownloadOutlined, SettingOutlined, FilterOutlined, ImportOutlined, RobotOutlined,
  ApiOutlined, ThunderboltOutlined, BarChartOutlined,
} from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
import WidgetRenderer from "@/components/bi/WidgetRenderer";
import DashboardGrid from "@/components/bi/DashboardGrid";
import FieldConfigurator from "@/components/bi/FieldConfigurator";
import type { BiWidget, AnalysisFilter, WidgetViz } from "@/lib/bi/types";
// @kf-batch 50-WP4ter-coverage —— 执行范围(工单 SC-7):BI 取数落点按区。
// 🔴 落点是 **widget 级**(SPEC §8.3:一张仪表盘可以并排放两个区的图),页面范围只作**新建默认值**。
import { useScope } from "@/components/scope/ScopeProvider";
import { landingOfScope, toScopeParam } from "@/lib/scope/scope";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });
const { Title, Text, Paragraph } = Typography;

// 与后端 analysis.ts 对齐:视觉对象软上限(内嵌一条 DynamoDB item,硬限 400KB)。
const MAX_WIDGETS = 50;

let _seq = 0;
function newId(prefix: string) {
  _seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${_seq}`;
}

// ═══════════════════════════ 顶层:分析看板库 + 路由到画布 ═══════════════════════════
export default function AnalysisWorkbench() {
  const t = useT();
  // @kf-batch 50-WP4quater-reads(工单 SC-28)—— 顶层看板库的当前范围(供**默认关**的过滤开关用)
  const { scope, targets: scopeTargetList } = useScope();
  const scopeParam = toScopeParam(scope);
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<any>(null); // 当前编辑的 analysis(null=不在编辑)
  const [open, setOpen] = useState(false);

  // @kf-batch 50-WP4quater-reads(工单 SC-28)—— 🔴 用户 2026-09-10 定案:「**增加一个过滤能力,
  // 默认不过滤**」。所以这是一个**默认关**的开关:关着时列表原样(顶栏切区不会悄悄藏掉别区的看板,
  // 那才是「丢东西」);开了才按当前范围筛。每行显示它涉及哪些区,用户自己判断。
  const [scopeFilterOn, setScopeFilterOn] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (scopeParam) qs.set("scope", scopeParam);
      if (scopeFilterOn) qs.set("scopeFilter", "1");
      const q = qs.toString();
      const r = await fetch(`/api/bi/analyses${q ? `?${q}` : ""}`).then((x) => x.json());
      setList(r?.success ? r.data : []);
    } finally {
      setLoading(false);
    }
    // 🔴 开关与范围都进 deps:切区 / 切开关都要重拉(护栏 4)
  }, [scopeParam, scopeFilterOn]);
  useEffect(() => { load(); }, [load]);

  const del = async (id: string) => {
    const r = await fetch(`/api/bi/analyses/${id}`, { method: "DELETE" }).then((x) => x.json());
    if (r?.success) { message.success(t("已删除")); load(); }
    else message.error(r?.error?.message || t("删除失败"));
  };

  if (open) {
    return (
      <AnalysisEditor
        editing={editing}
        onClose={() => { setOpen(false); setEditing(null); }}
        onSaved={() => { setOpen(false); setEditing(null); load(); }}
      />
    );
  }

  const columns = [
    { title: t("名称"), dataIndex: "name", key: "name" },
    { title: t("视觉对象"), dataIndex: "widgets", key: "widgets", render: (w: any[]) => (w || []).length },
    {
      // @kf-batch 50-WP4quater-reads(工单 SC-28)—— 这个看板**取了哪些区的数**(从 widget 落点派生)。
      // 🔴 一张看板可以并排放多个区的图(SPEC §8.3)⇒ 这里是**多个**标签,不是一个。
      // 空看板显示「—」而不是「主控区」:它还没取任何区的数,标成主控区是编造。
      title: t("涉及区域"), dataIndex: "regions", key: "regions", width: 190,
      render: (rs: string[]) =>
        Array.isArray(rs) && rs.length ? (
          <Space size={2} wrap>
            {rs.map((tid) => (
              <Tag key={tid} color={tid === "tgt_home" ? "default" : "blue"} data-testid="bi-region-tag">
                {scopeTargetList?.find((x: { targetId: string; region?: string }) => x.targetId === tid)?.region || tid}
              </Tag>
            ))}
          </Space>
        ) : (
          <span style={{ color: "#888" }}>—</span>
        ),
    },
    { title: t("筛选器"), dataIndex: "filters", key: "filters", render: (f: any[]) => (f || []).length },
    { title: t("更新时间"), dataIndex: "updatedAt", key: "updatedAt", render: (v: string) => (v ? new Date(v).toLocaleString() : "-") },
    {
      title: t("操作"), key: "op", width: 200,
      render: (_: any, r: any) => (
        <Space>
          <Button size="small" type="primary" icon={<EditOutlined />} onClick={() => { setEditing(r); setOpen(true); }}>{t("打开")}</Button>
          <Popconfirm title={t("确认删除该分析看板？")} onConfirm={() => del(r.analysisId)} okText={t("删除")} cancelText={t("取消")}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Title level={3} style={{ marginBottom: 0 }}><FundProjectionScreenOutlined /> {t("分析看板")}</Title>
      </div>
      <Paragraph type="secondary">
        {t("QuickSight 式自助 BI:一个画布内自由添加多个视觉对象,顶部筛选器绑定字段并选择作用域(当前 / 多个 / 全部视觉对象)实现联动。取数复用平台查询引擎并自动脱敏。")}
      </Paragraph>
      <Card
        title={t("分析看板库")}
        extra={
          <Space>
            {/* @kf-batch 50-WP4quater-reads(工单 SC-28)—— 🔴 **默认关**的按区过滤(用户 2026-09-10 原话:
                「我觉得可以增加一个过滤能力,默认不过滤」)。关着时列表原样 —— 顶栏切区不会悄悄
                藏掉别区的看板;需要时自己打开。 */}
            <Tooltip title={t("默认不过滤:顶栏切换执行范围不会藏掉别区的看板。打开后只看涉及当前范围的看板。")}>
              <Space size={4}>
                <Switch size="small" checked={scopeFilterOn} onChange={setScopeFilterOn} data-testid="bi-scope-filter" />
                <span style={{ fontSize: 12, color: "#888" }}>{t("只看当前范围")}</span>
              </Space>
            </Tooltip>
            <Button icon={<ReloadOutlined />} onClick={load}>{t("刷新")}</Button>
            <Button type="primary" data-testid="bi-new-analysis-btn" icon={<PlusOutlined />} onClick={() => { setEditing(null); setOpen(true); }}>{t("新建分析看板")}</Button>
          </Space>
        }
      >
        <Table rowKey="analysisId" loading={loading} columns={columns} dataSource={list} pagination={{ pageSize: 10 }} />
      </Card>
    </div>
  );
}

// ═══════════════════════════ 画布编辑器(整页) ═══════════════════════════
function AnalysisEditor({ editing, onClose, onSaved }: { editing: any; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [name, setName] = useState(editing?.name || "");
  const [widgets, setWidgets] = useState<BiWidget[]>(editing?.widgets || []);
  const [filters, setFilters] = useState<AnalysisFilter[]>(editing?.filters || []);
  const [layout, setLayout] = useState<any[]>(editing?.layout || []);
  const [version] = useState<number>(editing?.version ?? 0);
  const [saving, setSaving] = useState(false);

  // 每个视觉对象的取数结果 + 加载态 + 列(列用于筛选器绑字段下拉)。
  // gone=true:服务端返回 code GONE(数据服务已下线,@kf-batch 50-W5-seg2-WP1)⇒ 该卡渲染「已下线」占位而不是红字报错。
  const [cells, setCells] = useState<Record<string, { loading?: boolean; data?: any; error?: string; gone?: boolean; columns?: string[] }>>({});
  const [filterValues, setFilterValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of editing?.filters || []) if (f.default) init[f.key] = f.default;
    return init;
  });

  const [widgetEditorOpen, setWidgetEditorOpen] = useState(false);
  const [editingWidget, setEditingWidget] = useState<BiWidget | null>(null);
  const [filterEditorOpen, setFilterEditorOpen] = useState(false);
  const [editingFilter, setEditingFilter] = useState<AnalysisFilter | null>(null);
  // @kf-batch 50-WP4ter-coverage —— 当前视角(新建视觉对象的默认落点;已保存的 widget 用它自己的)
  const { scope } = useScope();
  const defaultTargetId = scope.kind === "target" ? scope.targetId : undefined;

  // 取一个视觉对象的数(带当前筛选器 + 值)。
  const loadWidget = useCallback(async (w: BiWidget, fv: Record<string, string>) => {
    setCells((prev) => ({ ...prev, [w.widgetId]: { ...prev[w.widgetId], loading: true } }));
    try {
      const r = await fetch("/api/bi/analysis-query", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // 🔴 不传页面范围:已保存的 widget 用**它自己**声明的落点(传了会让跨区仪表盘整张变同一个区)
        body: JSON.stringify({ widget: w, filters, filterValues: fv }),
      }).then((x) => x.json());
      if (r?.success) {
        setCells((prev) => ({ ...prev, [w.widgetId]: { loading: false, data: { columns: r.data.columns, rows: r.data.rows }, columns: r.data.columns } }));
      } else {
        // @kf-batch 50-W5-seg2-WP1 — 按错误信封渲染:GONE = 数据服务已下线(存量 dataapi 视觉对象),不白屏、不当成取数失败。
        setCells((prev) => ({ ...prev, [w.widgetId]: { loading: false, error: r?.error?.message || t("取数失败"), gone: r?.error?.code === "GONE" } }));
      }
    } catch (e: any) {
      setCells((prev) => ({ ...prev, [w.widgetId]: { loading: false, error: e?.message || t("取数失败") } }));
    }
  }, [filters, t]);

  // 首次 + widgets 变化:拉所有视觉对象。
  useEffect(() => {
    for (const w of widgets) loadWidget(w, filterValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgets.length]);

  // 应用筛选器:重拉受影响的视觉对象(简单起见全拉;逐 widget 独立取数,失败只影响该卡)。
  const applyFilters = () => { for (const w of widgets) loadWidget(w, filterValues); };

  // 所有视觉对象结果里出现过的列(供筛选器绑字段下拉)。
  const allColumns = Array.from(new Set(widgets.flatMap((w) => cells[w.widgetId]?.columns || []))).sort();

  // ── 视觉对象增删改 ──
  const upsertWidget = (w: BiWidget) => {
    setWidgets((prev) => {
      const exists = prev.some((x) => x.widgetId === w.widgetId);
      const next = exists ? prev.map((x) => (x.widgetId === w.widgetId ? w : x)) : [...prev, w];
      return next;
    });
    setLayout((prev) => {
      if (prev.some((it) => it.i === w.widgetId)) return prev;
      // 新卡片追加到底部,默认半宽。
      const maxY = prev.reduce((m, it) => Math.max(m, (it.y || 0) + (it.h || 6)), 0);
      return [...prev, { i: w.widgetId, x: 0, y: maxY, w: 12, h: 7 }];
    });
    // 立即取数
    setTimeout(() => loadWidget(w, filterValues), 50);
  };
  const removeWidget = (id: string) => {
    setWidgets((prev) => prev.filter((w) => w.widgetId !== id));
    setLayout((prev) => prev.filter((it) => it.i !== id));
    // 清掉引用该视觉对象的筛选器作用域项(避免悬空)。
    setFilters((prev) => prev.map((f) => f.scope.mode === "widgets"
      ? { ...f, scope: { mode: "widgets", widgetIds: f.scope.widgetIds.filter((w) => w !== id) } }
      : f));
  };

  // ── 筛选器增删改 ──
  const upsertFilter = (f: AnalysisFilter) => {
    setFilters((prev) => {
      const exists = prev.some((x) => x.key === f.key);
      return exists ? prev.map((x) => (x.key === f.key ? f : x)) : [...prev, f];
    });
    if (f.default && filterValues[f.key] === undefined) setFilterValues((prev) => ({ ...prev, [f.key]: f.default as string }));
    setTimeout(applyFilters, 50);
  };
  const removeFilter = (key: string) => {
    setFilters((prev) => prev.filter((f) => f.key !== key));
    setFilterValues((prev) => { const n = { ...prev }; delete n[key]; return n; });
    setTimeout(applyFilters, 50);
  };

  const exportCsv = async (w: BiWidget) => {
    try {
      const res = await fetch("/api/bi/export", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: w.source, filename: w.name }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); message.error(e?.error?.message || t("导出失败")); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${w.name || "widget"}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) { message.error(e?.message || t("导出失败")); }
  };

  const save = async () => {
    if (!name.trim()) { message.warning(t("请填写分析看板名称")); return; }
    if (!widgets.length) { message.warning(t("请至少添加一个视觉对象")); return; }
    setSaving(true);
    try {
      const payload = { name: name.trim(), widgets, filters, layout };
      let r: any;
      if (editing?.analysisId) {
        r = await fetch(`/api/bi/analyses/${editing.analysisId}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, version }),
        }).then((x) => x.json());
      } else {
        r = await fetch("/api/bi/analyses", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }).then((x) => x.json());
      }
      if (r?.success) { message.success(t("已保存")); onSaved(); }
      else message.error(r?.error?.message || t("保存失败"));
    } finally { setSaving(false); }
  };

  const widgetById = (id: string) => widgets.find((w) => w.widgetId === id);

  return (
    <div>
      {/* 顶部操作条 */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <Button onClick={onClose}>← {t("返回列表")}</Button>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("分析看板名称")} style={{ maxWidth: 320 }} />
        <div style={{ flex: 1 }} />
        <Button icon={<PlusOutlined />} onClick={() => {
          if (widgets.length >= MAX_WIDGETS) { message.warning(t("视觉对象已达上限 {n} 个", { n: MAX_WIDGETS })); return; }
          setEditingWidget(null); setWidgetEditorOpen(true);
        }}>{t("添加视觉对象")}</Button>
        <Button type="primary" loading={saving} onClick={save}>{t("保存")}</Button>
      </div>

      {/* 筛选器栏 */}
      <Card size="small" style={{ marginBottom: 12 }} styles={{ body: { padding: "10px 12px" } }}>
        <Space wrap align="center">
          <FilterOutlined style={{ color: "var(--bgp-primary, #22d3ee)" }} />
          <Text strong>{t("筛选器")}</Text>
          {filters.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>{t("添加筛选器,绑定字段并选择作用域实现联动")}</Text>}
          {filters.map((f) => (
            <span key={f.key} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 6px", borderRadius: 6, background: "var(--bgp-primary, #22d3ee)14" }}>
              <Text style={{ fontSize: 12 }}>{f.label}</Text>
              {f.type === "select" ? (
                <Select
                  size="small" style={{ minWidth: 130 }} allowClear placeholder={f.label}
                  value={filterValues[f.key] || undefined}
                  onChange={(v) => setFilterValues((prev) => ({ ...prev, [f.key]: v || "" }))}
                  options={(f.options || []).map((o) => ({ value: o, label: o }))}
                />
              ) : (
                <Input size="small" style={{ width: 130 }} placeholder="YYYY-MM-DD"
                  value={filterValues[f.key] || ""} onChange={(e) => setFilterValues((prev) => ({ ...prev, [f.key]: e.target.value }))} />
              )}
              <Tag style={{ margin: 0, fontSize: 11 }}>{f.scope.mode === "all" ? t("全部") : t("{n} 个", { n: f.scope.widgetIds.length })}</Tag>
              <SettingOutlined style={{ cursor: "pointer", fontSize: 12 }} onClick={() => { setEditingFilter(f); setFilterEditorOpen(true); }} />
              <DeleteOutlined style={{ cursor: "pointer", fontSize: 12 }} onClick={() => removeFilter(f.key)} />
            </span>
          ))}
          <Button size="small" icon={<PlusOutlined />} onClick={() => { setEditingFilter(null); setFilterEditorOpen(true); }}>{t("添加筛选器")}</Button>
          <Button size="small" type="primary" onClick={applyFilters}>{t("应用筛选")}</Button>
        </Space>
      </Card>

      {/* 画布(N 个视觉对象拖拽网格)*/}
      {widgets.length === 0 ? (
        <Empty description={t("画布还没有视觉对象,点「添加视觉对象」开始")} style={{ padding: 60 }} />
      ) : (
        <DashboardGrid
          layout={layout}
          editable
          onLayoutChange={(next) => setLayout(next)}
          renderItem={(it) => {
            const w = widgetById(it.i);
            const cell = w ? cells[w.widgetId] : undefined;
            if (!w) return <Card size="small"><Empty description={t("视觉对象不存在")} image={Empty.PRESENTED_IMAGE_SIMPLE} /></Card>;
            return (
              <Card
                size="small"
                style={{ height: "100%", overflow: "hidden" }}
                styles={{ body: { height: "calc(100% - 40px)", overflow: "auto" } }}
                title={<span className="bi-card-drag" style={{ cursor: "move" }}>{w.name}</span>}
                extra={
                  <Space>
                    <Tooltip title={t("编辑")}><Button size="small" type="text" icon={<EditOutlined />} onClick={() => { setEditingWidget(w); setWidgetEditorOpen(true); }} /></Tooltip>
                    <Tooltip title={t("刷新")}><Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => loadWidget(w, filterValues)} /></Tooltip>
                    <Tooltip title={t("导出 CSV")}><Button size="small" type="text" icon={<DownloadOutlined />} onClick={() => exportCsv(w)} /></Tooltip>
                    <Popconfirm title={t("从画布移除该视觉对象？")} onConfirm={() => removeWidget(w.widgetId)} okText={t("移除")} cancelText={t("取消")}>
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                }
              >
                {cell?.loading ? <div style={{ textAlign: "center", padding: 40 }}><Spin /></div>
                  : cell?.gone ? (
                    // @kf-batch 50-W5-seg2-WP1 — 存量 dataapi 视觉对象:「数据服务已下线」占位(ACCEPTANCE E-135),文案取服务端同一句。
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description={<span><Text strong>{t("数据服务已下线")}</Text><br /><Text type="secondary" style={{ fontSize: 12 }}>{cell.error}</Text></span>}
                    />
                  )
                  : cell?.error ? <Text type="danger" style={{ fontSize: 12 }}>{cell.error}</Text>
                  : cell?.data ? <WidgetRenderer data={cell.data} viz={w.viz} />
                  : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />}
              </Card>
            );
          }}
        />
      )}

      {widgetEditorOpen && (
        <WidgetEditor
          editing={editingWidget}
          onClose={() => { setWidgetEditorOpen(false); setEditingWidget(null); }}
          onSave={(w) => { upsertWidget(w); setWidgetEditorOpen(false); setEditingWidget(null); }}
        />
      )}
      {filterEditorOpen && (
        <FilterEditor
          editing={editingFilter}
          widgets={widgets}
          columns={allColumns}
          existingKeys={filters.map((f) => f.key)}
          onClose={() => { setFilterEditorOpen(false); setEditingFilter(null); }}
          onSave={(f) => { upsertFilter(f); setFilterEditorOpen(false); setEditingFilter(null); }}
        />
      )}
    </div>
  );
}

// ═══════════════════════════ 视觉对象编辑器(Modal) ═══════════════════════════
// 复用 FieldConfigurator(可视化配置,不写 SQL)+ 自由 SQL + 从报表库导入。产出 BiWidget。
function WidgetEditor({ editing, onClose, onSave }: { editing: BiWidget | null; onClose: () => void; onSave: (w: BiWidget) => void }) {
  // @kf-batch 50-WP4ter-coverage —— 预览与编译在**当前视角那个区**执行;保存时把落点写进 widget
  // (widget 级落点 = SPEC §8.3;不写进去的话切一次区这张图就换了数据源而没人知道)。
  // 🔴 编辑既有 widget 时优先沿用它自己的落点,别被当前视角悄悄改掉。
  const t = useT();
  const isEdit = !!editing;
  const { scope: wScope } = useScope();
  /** 这个视觉对象的落点:已保存的用它自己的;新建的用当前视角(「全部」= 主控区,不写字段)。 */
  const widgetTarget: string | undefined =
    (editing?.source as { targetId?: string } | undefined)?.targetId ||
    (wScope.kind === "target" ? wScope.targetId : undefined);
  // 新建视觉对象默认「可视化配置」(推荐的不写 SQL 路径);编辑时按已存来源回填模式。
  const initialMode = !editing ? "builder"
    : editing.source?.kind === "sql" && (editing.source as any).builder ? "builder"
    : editing.source?.kind === "sql" ? "sql" : "import";
  const [mode, setMode] = useState<"builder" | "sql" | "import">(initialMode as any);
  const [wname, setWname] = useState(editing?.name || "");

  // builder
  const [engine, setEngine] = useState<"redshift" | "athena">((editing?.source as any)?.engine || "redshift");
  const [builderValue, setBuilderValue] = useState<any>(null);

  // free SQL
  const [sql, setSql] = useState((editing?.source as any)?.sql || "SELECT region, count(*) AS cnt FROM ecommerce.orders GROUP BY region ORDER BY cnt DESC");
  const [chart, setChart] = useState<WidgetViz["chart"]>(editing?.viz?.chart || "bar");
  const [preview, setPreview] = useState<{ columns: string[]; rows: unknown[][] } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // import from report library
  const [reports, setReports] = useState<any[]>([]);
  const [reportId, setReportId] = useState("");
  useEffect(() => {
    // @kf-batch 50-W5-seg2-WP1 — 报表库里 dataapi 来源的旧报表不再提供导入(数据服务已下线;导入即选了一个只会 410 的取数源)。
    // @kf-batch 50-WP4quater-reads(工单 SC-28)—— 🔴 导入候选**刻意不按范围筛**:
    // 把别区的报表导进当前看板是合法用法(一张仪表盘可以并排放不同区的图,SPEC §8.3)。
    // 每个候选后面标出它取哪个区的数,选的时候看得见。
    if (mode === "import") fetch("/api/bi/reports").then((x) => x.json()).then((d) => setReports(d?.success ? (d.data || []).filter((r: any) => r?.source?.kind !== "dataapi") : [])).catch(() => {});
  }, [mode]);

  const doPreviewSql = async () => {
    setPreviewing(true); setPreview(null);
    try {
      const r = await fetch("/api/bi/query", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // @kf-batch 50-WP31-place-first-class —— 预览取数恒带落点(未保存的视觉对象:自带的 > 视角;保存进定义的仍是条件写法)
        body: JSON.stringify({ source: { kind: "sql", engine, sql }, targetId: widgetTarget || landingOfScope(wScope) }),
      }).then((x) => x.json());
      if (r?.success) setPreview({ columns: r.data.columns, rows: r.data.rows });
      else message.error(r?.error?.message || t("预览失败"));
    } finally { setPreviewing(false); }
  };

  const submit = async () => {
    const nm = wname.trim();
    const widgetId = editing?.widgetId || newId("w");
    if (mode === "builder") {
      if (!builderValue?.spec) { message.warning(t("请先选表勾字段并预览")); return; }
      let compiledSql = builderValue.sql;
      if (!compiledSql) {
        const r = await fetch("/api/bi/query", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: { kind: "builder", ...builderValue.spec }, targetId: widgetTarget || landingOfScope(wScope) }),
        }).then((x) => x.json());
        if (!r?.success || !r.data?.sql) { message.error(r?.error?.message || t("请先预览成功后再保存")); return; }
        compiledSql = r.data.sql;
      }
      const source = { kind: "sql" as const, engine: builderValue.spec.engine, sql: compiledSql, builder: builderValue.spec, ...(widgetTarget ? { targetId: widgetTarget } : {}) };
      onSave({ widgetId, name: nm || t("视觉对象"), source, viz: builderValue.viz || { chart: builderValue.chart || "bar" } });
      return;
    }
    if (mode === "sql") {
      if (!/^(select|with)\b/i.test(sql.trim())) { message.warning(t("SQL 必须是 SELECT / WITH 只读查询")); return; }
      // @kf-batch 50-WP4ter-coverage —— 自由 SQL 模式同样把落点写进 widget
      onSave({ widgetId, name: nm || t("视觉对象"), source: { kind: "sql", engine, sql: sql.trim(), ...(widgetTarget ? { targetId: widgetTarget } : {}) }, viz: { chart, auto: false } });
      return;
    }
    // import
    const rep = reports.find((r) => r.reportId === reportId);
    if (!rep) { message.warning(t("请选择要导入的报表")); return; }
    onSave({ widgetId, name: nm || rep.name, source: rep.source, viz: rep.viz });
  };

  return (
    <Modal
      title={isEdit ? t("编辑视觉对象") : t("添加视觉对象")}
      open width={1180} onCancel={onClose} onOk={submit}
      okText={t("确定")} cancelText={t("取消")}
      styles={{ body: { maxHeight: "72vh", overflow: "auto" } }}
    >
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <div>
          <Text strong>{t("视觉对象名称")}</Text>
          <Input value={wname} onChange={(e) => setWname(e.target.value)} placeholder={t("例如:各地区销售额")} style={{ marginTop: 6, maxWidth: 400 }} />
        </div>
        <Segmented
          value={mode} onChange={(v) => setMode(v as any)}
          options={[
            { value: "builder", label: t("可视化配置") },
            { value: "sql", label: t("自由 SQL") },
            { value: "import", label: t("从报表库导入") },
          ]}
        />

        {mode === "builder" && (
          <>
            <Segmented
              value={engine} onChange={(v) => setEngine(v as any)}
              options={[{ value: "redshift", label: t("数据仓库 Redshift") }, { value: "athena", label: t("数据湖 Athena") }]}
            />
            <FieldConfigurator
              engine={engine}
              initialSpec={(editing?.source as any)?.builder || null}
              onChange={(v) => setBuilderValue(v)}
            />
          </>
        )}

        {mode === "sql" && (
          <>
            <Segmented
              value={engine} onChange={(v) => setEngine(v as any)}
              options={[{ value: "redshift", label: t("数据仓库 Redshift") }, { value: "athena", label: t("数据湖 Athena") }]}
            />
            <div style={{ border: "1px solid var(--bgp-panel-border, #1d4254)", borderRadius: 6, overflow: "hidden" }}>
              <MonacoEditor height="160px" language="sql" theme="vs-dark" value={sql} onChange={(v) => setSql(v || "")} options={{ minimap: { enabled: false }, fontSize: 13 }} />
            </div>
            <Space>
              <Button icon={<EyeOutlined />} loading={previewing} onClick={doPreviewSql}>{t("预览数据")}</Button>
              <Text type="secondary">{t("图表类型")}</Text>
              <Select value={chart} onChange={(v) => setChart(v)} style={{ width: 140 }}
                options={[
                  { value: "table", label: t("表格") }, { value: "bar", label: t("柱状图") },
                  { value: "barh", label: t("横向条形") }, { value: "line", label: t("折线图") },
                  { value: "pie", label: t("饼图") }, { value: "metric", label: t("指标卡") },
                ]} />
            </Space>
            {preview && (
              <Card size="small" title={t("预览")} style={{ background: "var(--bgp-panel, transparent)" }}>
                <WidgetRenderer data={preview} viz={{ chart, auto: false }} />
              </Card>
            )}
          </>
        )}

        {mode === "import" && (
          <div>
            <Text strong>{t("选择报表库中的报表(复用其取数与图表)")}</Text>
            <Select
              style={{ width: "100%", marginTop: 6 }} showSearch value={reportId || undefined} onChange={setReportId}
              placeholder={t("选择一个报表")}
              filterOption={(i, o) => String(o?.label || "").toLowerCase().includes(i.toLowerCase())}
              options={reports.map((r) => ({ value: r.reportId, label: r.name }))}
              notFoundContent={t("报表库暂无报表")}
            />
            <Text type="secondary" style={{ display: "block", fontSize: 12, marginTop: 6 }}>
              {t("导入后成为画布内独立视觉对象(拷贝取数配置,与原报表解耦)。")}
            </Text>
          </div>
        )}
      </Space>
    </Modal>
  );
}

// ═══════════════════════════ 筛选器编辑器(绑字段 + 类型 + 作用域) ═══════════════════════════
function FilterEditor({
  editing, widgets, columns, existingKeys, onClose, onSave,
}: {
  editing: AnalysisFilter | null;
  widgets: BiWidget[];
  columns: string[];
  existingKeys: string[];
  onClose: () => void;
  onSave: (f: AnalysisFilter) => void;
}) {
  const t = useT();
  const isEdit = !!editing;
  const [label, setLabel] = useState(editing?.label || "");
  const [field, setField] = useState(editing?.field || "");
  const [type, setType] = useState<"select" | "date">(editing?.type || "select");
  const [optionsText, setOptionsText] = useState((editing?.options || []).join(", "));
  const [defVal, setDefVal] = useState(editing?.default || "");
  // 作用域:all 或 指定 widgetIds(默认 all)。
  const [scopeAll, setScopeAll] = useState<boolean>(editing ? editing.scope.mode === "all" : true);
  const [scopeIds, setScopeIds] = useState<string[]>(editing && editing.scope.mode === "widgets" ? editing.scope.widgetIds : widgets.map((w) => w.widgetId));

  const submit = () => {
    const fld = field.trim();
    if (!fld) { message.warning(t("请绑定字段")); return; }
    const lbl = label.trim() || fld;
    const key = editing?.key || `f_${fld.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
    if (!editing && existingKeys.includes(key)) { message.warning(t("已存在绑定同字段的筛选器,请改用编辑")); return; }
    const options = type === "select" ? optionsText.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    if (type === "select" && (!options || !options.length)) { message.warning(t("下拉筛选器需要至少一个选项")); return; }
    const scope: AnalysisFilter["scope"] = scopeAll ? { mode: "all" } : { mode: "widgets", widgetIds: scopeIds };
    onSave({
      key, label: lbl, field: fld, type,
      ...(options ? { options } : {}),
      ...(defVal ? { default: defVal } : {}),
      scope,
    });
  };

  return (
    <Modal title={isEdit ? t("编辑筛选器") : t("添加筛选器")} open width={560} onCancel={onClose} onOk={submit} okText={t("确定")} cancelText={t("取消")}>
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <div>
          <Text strong>{t("绑定字段")}</Text>
          <Select
            style={{ width: "100%", marginTop: 6 }} showSearch value={field || undefined}
            onChange={setField} placeholder={t("选择要筛选的字段(如 region)")}
            options={columns.map((c) => ({ value: c, label: c }))}
            notFoundContent={t("先添加视觉对象并取数,字段会自动出现;也可直接输入")}
            // 允许直接输入未在列表中的字段名(不同表可能字段不同)。
            mode={undefined}
            onSearch={(v) => setField(v)}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>{t("筛选器把该字段的取值注入命中作用域的视觉对象(不写 SQL 也生效)。")}</Text>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <Text strong>{t("显示名")}</Text>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={field || t("显示名")} style={{ marginTop: 6 }} />
          </div>
          <div style={{ width: 160 }}>
            <Text strong>{t("类型")}</Text>
            <Select value={type} onChange={(v) => setType(v)} style={{ width: "100%", marginTop: 6 }}
              options={[{ value: "select", label: t("下拉") }, { value: "date", label: t("日期") }]} />
          </div>
        </div>
        {type === "select" && (
          <div>
            <Text strong>{t("选项(逗号分隔,白名单)")}</Text>
            <Input value={optionsText} onChange={(e) => setOptionsText(e.target.value)} placeholder="East, West, North, South, Central" style={{ marginTop: 6 }} />
          </div>
        )}
        <div>
          <Text strong>{t("默认值")}</Text>
          <Input value={defVal} onChange={(e) => setDefVal(e.target.value)} placeholder={t("可空")} style={{ marginTop: 6, maxWidth: 240 }} />
        </div>
        <Divider style={{ margin: "4px 0" }} />
        <div>
          <Text strong>{t("作用域(联动哪些视觉对象)")}</Text>
          <div style={{ marginTop: 6 }}>
            <Segmented
              value={scopeAll ? "all" : "some"}
              onChange={(v) => setScopeAll(v === "all")}
              options={[{ value: "all", label: t("全部视觉对象") }, { value: "some", label: t("指定视觉对象") }]}
            />
          </div>
          {!scopeAll && (
            <div style={{ marginTop: 8, border: "1px solid var(--bgp-panel-border, #1d4254)", borderRadius: 6, padding: 8, maxHeight: 160, overflow: "auto" }}>
              <Checkbox.Group
                value={scopeIds}
                onChange={(v) => setScopeIds(v as string[])}
                options={widgets.map((w) => ({ label: w.name, value: w.widgetId }))}
                style={{ display: "flex", flexDirection: "column", gap: 6 }}
              />
              {widgets.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>{t("先添加视觉对象")}</Text>}
            </div>
          )}
        </div>
      </Space>
    </Modal>
  );
}
