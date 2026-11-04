"use client";

import { fetchExecTargets } from "@/lib/exec-env/exec-targets-client";
// 列类型候选与数据目录建表 / 改表同一份(客户端安全清单)
import { DDL_TYPE_CHOICES } from "@/lib/modeling/ddl-type-choices";
import React, { useState, useEffect } from "react";
import { Card, Button, Space, Modal, Input, InputNumber, Select, Empty, Spin, message, Table, Tag, Tabs, Popconfirm, Tooltip, Radio, Checkbox, Divider, Alert } from "antd";
import { ApartmentOutlined, PlusOutlined, ReloadOutlined, ThunderboltOutlined, CheckCircleOutlined, CodeOutlined, TableOutlined } from "@ant-design/icons";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useT } from "@/lib/i18n/useT";
// 建模逐 target 落地面板 + 与服务端**同一份**判态纯函数。
import LandingPanel from "@/components/modeling/LandingPanel";
import { landedStateOf, type LandedRecord, type LandedState } from "@/lib/modeling/landing-shared";
// 码表物理落点的兜底显示也经唯一作者(不在页面里再拼一遍名字)
import { codeTableLandingFqn } from "@/lib/modeling/landing-fqn";

const HOME_TARGET = "tgt_home";
/** 观测态在列表里的紧凑呈现。🔴 与服务端 `LandedState` 一一对应,前端不新造状态。 */
const LAND_TAG: Record<LandedState, { text: string; color?: string }> = {
  ok: { text: "✓", color: "green" },
  stale: { text: "⚠ 版本不齐", color: "orange" },
  drift: { text: "🔴 drift", color: "red" },
  "credential-gap": { text: "⊘ 待重新落地" }, // 只剩交付前的旧记录
  failed: { text: "✗ 失败", color: "red" },
  "never-landed": { text: "⚠ 未落", color: "orange" },
};

/** 一行的逐 target 观测态标签组(home 在前)。 */
function LandedTags({ row, t }: { row: any; t: (s: string, v?: any) => string }) {
  const by: Record<string, LandedRecord> = row?.landedByTarget || {};
  const bound: string[] = Array.isArray(row?.targets) && row.targets.length ? row.targets : [HOME_TARGET];
  const ids = Array.from(new Set([...bound, ...Object.keys(by)])).sort((a, b) =>
    a === HOME_TARGET ? -1 : b === HOME_TARGET ? 1 : a.localeCompare(b)
  );
  return (
    <Space size={2} wrap>
      {ids.map((id) => {
        const st = landedStateOf(by[id], String(row?.defHash || ""));
        const ui = LAND_TAG[st];
        const rec = by[id];
        return (
          <Tooltip key={id} title={`${id}${rec?.observedAt ? ` · ${t("观测于")} ${rec.observedAt.slice(0, 19).replace("T", " ")}` : ""}${rec?.error ? ` · ${rec.error}` : ""}`}>
            {ui.color ? <Tag color={ui.color}>{id === HOME_TARGET ? t("本地") : id}: {t(ui.text)}</Tag>
              : <Tag>{id === HOME_TARGET ? t("本地") : id}: {t(ui.text)}</Tag>}
          </Tooltip>
        );
      })}
    </Space>
  );
}

import ModelingGuide from "./ModelingGuide";
// 执行范围接入(50 SPEC §2.6;交互 INTERACTION §9)
import { useScope } from "@/components/scope/ScopeProvider";
import OtherScopesHint, { ScopeEmptyHint } from "@/components/scope/OtherScopesHint";
import { landingOfScope, toScopeParam } from "@/lib/scope/scope";

// 数据建模:数仓分层 / 数据域(主题域)/ 数据标准 / 码表。
export default function ModelingPage() {
  const { getToken, user, loading: authLoading } = useAuth();
  const t = useT();
  const [isAdmin, setIsAdmin] = useState(false);
  const [tab, setTab] = useState("layers");
  const [loading, setLoading] = useState(false);
  // UX ⑥(用户 2026-10-21 拍板):整页 Spin 只在**首载**;之后建 / 改 / 删 / 落地 / 刷新只重拉本页签那一张清单,
  //   表格留在 DOM(Spin 盖在页签内),滚动位置与展开态不丢;量具 p43j 曾因整页卸载假红。
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [tabLoading, setTabLoading] = useState<Record<string, boolean>>({});

  const [layers, setLayers] = useState<any[]>([]);
  const [domains, setDomains] = useState<any[]>([]);
  const [standards, setStandards] = useState<any[]>([]);
  const [codetables, setCodetables] = useState<any[]>([]);
  const [dimensions, setDimensions] = useState<any[]>([]); // D3 维度/事实表
  const [metrics, setMetrics] = useState<any[]>([]); // D4 指标体系

  // 通用 Modal 状态:{ kind, editing, form }
  const [modal, setModal] = useState<{ kind: string; editing?: any } | null>(null);
  const [form, setForm] = useState<any>({});
  const [saving, setSaving] = useState(false);
  // 原来的 `landingId`/`applyingId`/`landCodeTable`/`applyDDL` 已删
  // 落地/应用统一走 `LandingPanel`(它自己打端点)。留着就是死代码,而死代码会被下一个人当成"还有别的路径"。
  const [ddlModal, setDdlModal] = useState<{ name: string; ddl: string } | null>(null); // DDL 预览
  const [computingId, setComputingId] = useState<string>(""); // D4 计算中
  // 当前执行范围(顶栏选的那个;URL 是权威)。
  // 🔴 只有**码表**与**维度建模**两类有区域维(定义行上的 `targets[]` = 绑定/已落地的区);
  //    分层 / 数据域 / 数据标准 / 指标是平台级定义,**不分区** —— 这一点必须在页面上说出来,
  //    否则用户切了区发现「分层一点没变」,只能怀疑是不是切换没生效。
  const { scope, targets: scopeTargets } = useScope();
  const scopeParam = toScopeParam(scope);
  const scopeQs = scopeParam ? `?scope=${encodeURIComponent(scopeParam)}` : "";
  const scopeRegionLabel =
    scope.kind === "target" ? scopeTargets?.find((x) => x.targetId === scope.targetId)?.region || scope.targetId : "";

  const authedFetch = async (url: string, init?: RequestInit): Promise<Response | null> => {
    const token = await getToken();
    if (!token) return null; // 未登录由全局 layout 守卫处理,此处不硬跳避免清空 MultiTabs 页签
    const res = await fetch(url, { ...init, headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) } });
    if (res.status === 401) return null; // 未登录由全局 layout 守卫处理,此处不硬跳避免清空 MultiTabs 页签
    return res;
  };

  // 🔴 六类**全部**带执行范围。
  // 上一版只带两条,理由写的是「其余四类无区域维」;用户 2026-09-10 驳回了那个说法。
  // 语义分两种,服务端各自处理:
  //   · 分层 / 数据域 / 数据标准 = **治理约定** ⇒ 行上可声明「适用区」,未声明 = 全平台通用
  //     (所以带上 scope 也不会让存量定义消失);
  //   · 指标 = 有**计算值** ⇒ 单区视角给那个区的值,没算过如实回「这个区还没算过」。
  const kindEndpoint: Record<string, string> = { layers: "layers", domains: "domains", standards: "standards", codetables: "codetables", dimensions: "dimensions", metrics: "model-metrics" };
  const kindSetter: Record<string, (rows: any[]) => void> = { layers: setLayers, domains: setDomains, standards: setStandards, codetables: setCodetables, dimensions: setDimensions, metrics: setMetrics };
  /** UX ⑥:只重拉一个页签的清单(页签内 Spin,表格不卸载)。 */
  const loadKind = async (kind: string) => {
    setTabLoading((prev) => ({ ...prev, [kind]: true }));
    try {
      const res = await authedFetch(`/api/modeling/${kindEndpoint[kind]}${scopeQs}`);
      if (res) { const j = await res.json(); kindSetter[kind](j.success ? j.data : []); }
    } finally { setTabLoading((prev) => ({ ...prev, [kind]: false })); }
  };
  /** 六类一起拉:首载整页 Spin;之后(刷新 / 切范围)只在各页签内转圈。 */
  const loadAll = async () => {
    const firstLoad = !initialLoaded;
    if (firstLoad) setLoading(true);
    try {
      await Promise.all(Object.keys(kindEndpoint).map((kind) => loadKind(kind)));
    } finally {
      if (firstLoad) { setLoading(false); setInitialLoaded(true); }
    }
  };

  useEffect(() => {
    if (authLoading) return;
    if (!user) return; // 未登录由全局 layout 守卫处理,此处不硬跳避免清空 MultiTabs 页签
    (async () => {
      const token = await getToken();
      if (token) { try { const p = JSON.parse(atob(token.split(".")[1] || "")); setIsAdmin((p["cognito:groups"] || []).includes("bgp-admin")); } catch {} }
    })();
    loadAll();
    // 🔴 `scopeQs` 进 deps:切范围**不重载页面**,靠这里重拉(护栏 4)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user, scopeQs]);

  // ─── 通用增删改 ───
  const openCreate = (kind: string) => {
    setModal({ kind });
    if (kind === "codetables") setForm({ values: [] });
    else if (kind === "dimensions") setForm({ tableType: "dimension", schema: "dwd", columns: [{ name: "", dataType: "VARCHAR", length: 256, nullable: true, isPrimaryKey: false }] });
    else if (kind === "metrics") setForm({ metricType: "atomic", agg: "count", modifiers: [] });
    else setForm({});
  };
  const openEdit = (kind: string, row: any) => { setModal({ kind, editing: row }); setForm({ ...row }); };

  const idField: Record<string, string> = { layers: "layerId", domains: "domainId", standards: "standardId", codetables: "codeTableId", dimensions: "modelTableId", metrics: "modelMetricId" };
  // kind → API 路径段(metrics 的后端路由是 model-metrics,其余同名)。
  const apiSeg: Record<string, string> = { metrics: "model-metrics" };
  const seg = (kind: string) => apiSeg[kind] || kind;

  const doSave = async () => {
    if (!modal) return;
    const { kind, editing } = modal;
    const id = editing?.[idField[kind]];
    setSaving(true);
    try {
      const res = await authedFetch(`/api/modeling/${seg(kind)}${id ? `/${id}` : ""}`, { method: id ? "PUT" : "POST", body: JSON.stringify(form) });
      if (!res) return;
      const d = await res.json();
      if (d?.success) { message.success(id ? t("已保存") : t("已创建")); setModal(null); loadKind(kind); }
      else message.error(d?.error?.message || t("操作失败"));
    } finally { setSaving(false); }
  };

  // 删定义**受控**(50 SPEC v3.20 §3.8):仍有落地产物 ⇒ 服务端 409 DECISION_REQUIRED,
  //   这里弹窗列出各区物理表,只给两条出口:去落地面板逐区清理 / 输入确认串显式保留物理表只删定义。
  const [deleteDecision, setDeleteDecision] = useState<any>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const doDelete = async (kind: string, id: string, row?: any, keep?: { confirm: string }) => {
    const qs = keep ? `?keepTables=1&confirm=${encodeURIComponent(keep.confirm)}` : "";
    const res = await authedFetch(`/api/modeling/${seg(kind)}/${id}${qs}`, { method: "DELETE" });
    if (!res) return;
    const d = await res.json();
    if (d?.success) {
      const kept = Array.isArray(d.data?.keptTables) ? d.data.keptTables.length : 0;
      message.success(kept ? t("已删除定义;{n} 张物理表按你的选择保留(已审计)", { n: kept }) : t("已删除"));
      setDeleteDecision(null);
      loadKind(kind);
      return;
    }
    if (res.status === 409 && d?.error?.code === "DECISION_REQUIRED") {
      setDeleteDecision({ kind, id, row, artifacts: d.error.detail?.artifacts || [], message: d.error.message });
      setDeleteConfirm("");
      return;
    }
    message.error(d?.error?.message || t("删除失败"));
  };

  const seedLayers = async () => {
    const res = await authedFetch("/api/modeling/layers/seed", { method: "POST", body: "{}" });
    if (!res) return;
    const d = await res.json();
    if (d?.success) { message.success(t("已预置 {count} 个标准分层", { count: d.data.count })); loadKind("layers"); } else message.error(d?.error?.message || t("预置失败"));
  };

  // 落地面板状态 + 可下推目标清单(来自服务端,前端不拼)
  const [landPanel, setLandPanel] = useState<any>(null);
  const [execTargets, setExecTargets] = useState<Array<{ targetId: string; region: string; isHome: boolean }>>([]);
  useEffect(() => {
    fetchExecTargets("redshift").then(setExecTargets).catch(() => {});
  }, []);

  // D3: 预览 DDL(只读弹窗)
  const previewDDL = async (row: any) => {
    const res = await authedFetch(`/api/modeling/dimensions/${row.modelTableId}/ddl`);
    if (!res) return;
    const d = await res.json();
    if (d?.success) setDdlModal({ name: row.name, ddl: d.data.ddl }); else message.error(d?.error?.message || t("生成 DDL 失败"));
  };

  // D3: 应用 DDL 到 Redshift
  // D4: 计算指标
  const computeMetric = async (id: string) => {
    setComputingId(id);
    try {
      // 🔴 原来 body 恒为 `{}` ⇒ 在 us-west-2 视角点「计算」也在**主控区**算,
      //   而「最近值」列读 `lastValue`(最近一次,不分区)⇒ 把主控区的数字当成当前区的显示出来。
      //   落点 = 单区视角那个区;分组 / 全部 = 主控区(显式写明,后端缺 targetId ⇒ 400)。
      const res = await authedFetch(`/api/modeling/model-metrics/${id}/compute`, {
        method: "POST",
        body: JSON.stringify({ targetId: landingOfScope(scope) }),
      });
      if (!res) return;
      const d = await res.json();
      if (d?.success) { message.success(t("计算完成:{value}", { value: d.data.value })); loadKind("metrics"); } else message.error(d?.error?.message || t("计算失败"));
    } finally { setComputingId(""); }
  };

  // ─── 各 Tab 表格列 ───
  const adminCol = (kind: string) => ({
    title: t("操作"), key: "op", width: 160,
    render: (_: any, r: any) => isAdmin ? (
      <Space>
        <a onClick={() => openEdit(kind, r)}>{t("编辑")}</a>
        <Popconfirm title={t("确认删除？")} onConfirm={() => doDelete(kind, r[idField[kind]])}><a style={{ color: "red" }}>{t("删除")}</a></Popconfirm>
      </Space>
    ) : <span style={{ color: "#bbb" }}>—</span>,
  });

  const layerCols = [
    { title: t("层"), dataIndex: "code", render: (v: string, r: any) => <Tag color="blue">{v}</Tag> },
    { title: t("名称"), dataIndex: "name" },
    { title: "Redshift schema", dataIndex: "schema", render: (v: string) => <code>{v}</code> },
    { title: t("顺序"), dataIndex: "seq", width: 70 },
    { title: t("说明"), dataIndex: "description", render: (v: string) => <span style={{ color: "#888" }}>{v || "—"}</span> },
    adminCol("layers"),
  ];

  // 数据域两级树:数据域(level1)为父,主题域(level2)缩进显示。
  const domainRows = (() => {
    const tops = domains.filter((d) => d.level === 1);
    const out: any[] = [];
    for (const t of tops) {
      out.push({ ...t, _indent: 0 });
      domains.filter((c) => c.parentId === t.domainId).forEach((c) => out.push({ ...c, _indent: 1 }));
    }
    // 无父的 level2(异常数据)也展示,避免丢失
    domains.filter((d) => d.level === 2 && !domains.some((p) => p.domainId === d.parentId)).forEach((c) => out.push({ ...c, _indent: 1 }));
    return out;
  })();
  const domainCols = [
    { title: t("域名称"), dataIndex: "name", render: (v: string, r: any) => <span style={{ paddingLeft: r._indent * 24 }}>{r._indent ? "└ " : ""}<b>{v}</b> {r.level === 1 ? <Tag color="purple">{t("数据域")}</Tag> : <Tag>{t("主题域")}</Tag>}</span> },
    { title: t("编码"), dataIndex: "code", render: (v: string) => <code>{v}</code> },
    { title: t("负责人"), dataIndex: "owner", render: (v: string) => v || "—" },
    { title: t("说明"), dataIndex: "description", render: (v: string) => <span style={{ color: "#888" }}>{v || "—"}</span> },
    adminCol("domains"),
  ];

  const standardCols = [
    { title: t("标准名"), dataIndex: "name" },
    { title: t("编码"), dataIndex: "code", render: (v: string) => <code>{v}</code> },
    { title: t("数据类型"), dataIndex: "dataType", render: (v: string) => <Tag color="geekblue">{v}</Tag> },
    { title: t("单位"), dataIndex: "unit", render: (v: string) => v || "—" },
    { title: t("约束"), dataIndex: "constraint", render: (v: string) => <span style={{ color: "#888" }}>{v || "—"}</span> },
    adminCol("standards"),
  ];

  const codetableCols = [
    { title: t("码表名"), dataIndex: "name" },
    { title: t("编码"), dataIndex: "code", render: (v: string) => <code>{v}</code> },
    { title: t("枚举项"), dataIndex: "values", render: (v: any[]) => <span>{t("{n} 项", { n: (v || []).length })} {(v || []).slice(0, 4).map((x) => <Tag key={x.value}>{x.value}={x.label}</Tag>)}{(v || []).length > 4 ? "…" : ""}</span> },
    // 🔴 逐 target 观测态(原来是一个 bool「已落地/未落地」,
    // 多区之后那个 bool 会把 drift / 只落了一个区 都显示成"已落地" = 假绿)。
    { title: t("落地(逐区观测态)"), key: "landed", width: 300, render: (_: any, r: any) => <LandedTags row={r} t={t} /> },
    {
      title: t("操作"), key: "op", width: 220,
      render: (_: any, r: any) => isAdmin ? (
        <Space>
          <a onClick={() => openEdit("codetables", r)}>{t("编辑")}</a>
          {/* 落地改成开**面板**(逐区观测态 + 检测 + drift 差异 + 强制重建),
              而不是一个"点了就落 home"的按钮:多区之后那个按钮说不清"落到哪、现在是什么状态"。 */}
          <Button size="small" type="link" icon={<ThunderboltOutlined />}
            onClick={() => setLandPanel({ kind: "code-table", id: r.codeTableId, name: r.name,
              table: r.physicalTable || codeTableLandingFqn(r).fqn, defHash: r.defHash || "",
              landedByTarget: r.landedByTarget, targets: r.targets })}>{t("落地")}</Button>
          <Popconfirm title={t("确认删除？(若仍有已落地的物理表,会先让你选择清理或保留)")} onConfirm={() => doDelete("codetables", r.codeTableId, r)}><a style={{ color: "red" }}>{t("删除")}</a></Popconfirm>
        </Space>
      ) : <span style={{ color: "#bbb" }}>—</span>,
    },
  ];

  // D3 维度/事实表:归属层/域名称查找
  const layerName = (id?: string) => layers.find((l) => l.layerId === id)?.code || "—";
  const domainName = (id?: string) => domains.find((d) => d.domainId === id)?.name || "—";
  const dimensionCols = [
    { title: t("逻辑名"), dataIndex: "name" },
    { title: t("类型"), dataIndex: "tableType", width: 90, render: (v: string) => v === "fact" ? <Tag color="volcano">{t("事实表")}</Tag> : <Tag color="cyan">{t("维度表")}</Tag> },
    { title: t("归属"), key: "binding", render: (_: any, r: any) => <span><Tag color="blue">{layerName(r.layerId)}</Tag>{domainName(r.domainId) !== "—" && <Tag color="purple">{domainName(r.domainId)}</Tag>}</span> },
    { title: t("物理表"), key: "phys", render: (_: any, r: any) => <code>{r.schema}.{r.physicalTable}</code> },
    { title: t("列数"), dataIndex: "columns", width: 70, render: (v: any[]) => (v || []).length },
    // 同码表:逐 target 观测态取代那个 bool。
    { title: t("应用(逐区观测态)"), key: "applied", width: 300, render: (_: any, r: any) => <LandedTags row={r} t={t} /> },
    {
      title: t("操作"), key: "op", width: 260,
      render: (_: any, r: any) => (
        <Space size="small">
          <a onClick={() => previewDDL(r)}><CodeOutlined /> DDL</a>
          {isAdmin && <a onClick={() => openEdit("dimensions", r)}>{t("编辑")}</a>}
          {isAdmin && <Button size="small" type="link" icon={<ThunderboltOutlined />}
            onClick={() => setLandPanel({ kind: "model-table", id: r.modelTableId, name: r.name || r.physicalTable,
              table: r.physicalTable2 || `${r.schema}.${r.physicalTable}`, defHash: r.defHash || "",
              landedByTarget: r.landedByTarget, targets: r.targets })}>{t("应用")}</Button>}
          {isAdmin && <Popconfirm title={t("确认删除？(若仍有已落地的物理表,会先让你选择清理或保留)")} onConfirm={() => doDelete("dimensions", r.modelTableId, r)}><a style={{ color: "red" }}>{t("删除")}</a></Popconfirm>}
        </Space>
      ),
    },
  ];

  // D4 指标体系
  const metricName = (id?: string) => metrics.find((m) => m.modelMetricId === id)?.name || "—";
  const metricCols = [
    { title: t("指标名"), dataIndex: "name" },
    { title: t("类型"), dataIndex: "metricType", width: 90, render: (v: string) => v === "derived" ? <Tag color="gold">{t("派生")}</Tag> : <Tag color="green">{t("原子")}</Tag> },
    { title: t("归属域"), key: "domain", render: (_: any, r: any) => domainName(r.domainId) },
    {
      title: t("技术口径(聚合@表)"), key: "def", render: (_: any, r: any) => r.metricType === "atomic"
        ? <code style={{ fontSize: 12 }}>{r.agg}{r.measureColumn ? `(${r.measureColumn})` : "(*)"} @ {r.fqn}</code>
        : <span style={{ fontSize: 12 }}>{t("原子")}「{metricName(r.atomicId)}」{r.timeWindow && r.timeWindow !== "all" ? <Tag>{r.timeWindow}</Tag> : null}{(r.modifiers || []).length ? <Tag color="blue">{t("{n}个修饰词", { n: r.modifiers.length })}</Tag> : null}</span>,
    },
    { title: t("业务口径"), key: "caliber", ellipsis: true, render: (_: any, r: any) => r.caliber ? <span style={{ fontSize: 12 }}>{r.caliber}</span> : <span style={{ color: "#bbb" }}>{t("未填")}</span> },
    { title: t("单位"), dataIndex: "unit", width: 70, render: (v: string) => v || <span style={{ color: "#bbb" }}>—</span> },
    // 单区视角读服务端按区解析好的 `value`(该区没算过 ⇒ —,不拿别区的数字顶上);
    //   全局 / 分组视角仍是「最近一次」并标出它是哪个区算的。
    { title: t("最近值"), key: "val", width: 140, render: (_: any, r: any) => {
      const single = scope.kind === "target";
      const v = single ? r.value : r.lastValue;
      const at = single ? r.computedAt : r.lastComputedAt;
      if (v == null) return <span style={{ color: "#bbb" }} data-testid="metric-value">—</span>;
      return <Tooltip title={`${String(at || "").slice(0, 19)}${!single && r.lastTargetId ? ` · ${r.lastTargetId}` : ""}`}><b data-testid="metric-value">{v}</b></Tooltip>;
    } },
    {
      title: t("操作"), key: "op", width: 220,
      render: (_: any, r: any) => (
        <Space size="small">
          {/* 🔴 计算指标改平台 admin 专用(端点会跑 Redshift 聚合、fqn 任意 ⇒ 可借道读别的项目)。
              与同一行的编辑/删除保持一致的门控写法;真授权在服务端(403)。 */}
          {isAdmin && (
            <Button size="small" type="link" icon={<ThunderboltOutlined />} loading={computingId === r.modelMetricId} onClick={() => computeMetric(r.modelMetricId)}>{t("计算")}</Button>
          )}
          {isAdmin && <a onClick={() => openEdit("metrics", r)}>{t("编辑")}</a>}
          {isAdmin && <Popconfirm title={t("确认删除？")} onConfirm={() => doDelete("metrics", r.modelMetricId)}><a style={{ color: "red" }}>{t("删除")}</a></Popconfirm>}
        </Space>
      ),
    },
  ];

  const addBtn = (kind: string, label: string) => isAdmin && <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => openCreate(kind)}>{label}</Button>;

  const tabItems = [
    {
      key: "layers", label: t("数仓分层"),
      children: (
        <Spin spinning={!!tabLoading.layers}><div data-testid="modeling-tab-layers">
          <Space style={{ marginBottom: 12 }}>
            {isAdmin && <Button size="small" onClick={seedLayers}>{t("一键预置 ODS/DWD/DWS/ADS")}</Button>}
            {addBtn("layers", t("新建分层"))}
          </Space>
          {layers.length === 0 ? <Empty description={isAdmin ? t("暂无分层,点「一键预置」快速生成标准四层") : t("暂无分层")} /> :
            <Table rowKey="layerId" size="small" pagination={false} dataSource={layers} columns={layerCols} />}
        </div></Spin>
      ),
    },
    {
      key: "domains", label: t("数据域"),
      children: (
        <Spin spinning={!!tabLoading.domains}><div data-testid="modeling-tab-domains">
          <Space style={{ marginBottom: 12 }}>{addBtn("domains", t("新建域"))}</Space>
          {domainRows.length === 0 ? <Empty description={t("暂无数据域")} /> :
            <Table rowKey="domainId" size="small" pagination={false} dataSource={domainRows} columns={domainCols} />}
        </div></Spin>
      ),
    },
    {
      key: "standards", label: t("数据标准"),
      children: (
        <Spin spinning={!!tabLoading.standards}><div data-testid="modeling-tab-standards">
          <Space style={{ marginBottom: 12 }}>{addBtn("standards", t("新建标准"))}</Space>
          {standards.length === 0 ? <Empty description={t("暂无数据标准")} /> :
            <Table rowKey="standardId" size="small" pagination={false} dataSource={standards} columns={standardCols} />}
        </div></Spin>
      ),
    },
    {
      key: "codetables", label: t("码表"),
      children: (
        <Spin spinning={!!tabLoading.codetables}><div data-testid="modeling-tab-codetables">
          <Space style={{ marginBottom: 12 }}>{addBtn("codetables", t("新建码表"))}</Space>
          {/* 护栏 1:target 视角常驻「其他执行范围还有 N 条」 */}
          <OtherScopesHint resources={["code-table"]} />
          {/* 无头验收按容器数行(空态时容器仍在,行数 0) */}
          <div data-testid="codetable-table">
            {codetables.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<ScopeEmptyHint resources={["code-table"]} noun={t("码表")} />} /> :
              <Table rowKey="codeTableId" size="small" pagination={false} dataSource={codetables} columns={codetableCols} style={{ marginTop: 12 }} />}
          </div>
        </div></Spin>
      ),
    },
    {
      key: "dimensions", label: t("维度建模"),
      children: (
        <Spin spinning={!!tabLoading.dimensions}><div data-testid="modeling-tab-dimensions">
          <Space style={{ marginBottom: 12 }}>{addBtn("dimensions", t("新建维度/事实表"))}</Space>
          {/* 护栏 1 同码表 */}
          <OtherScopesHint resources={["model-table"]} />
          <div data-testid="dimension-table">
            {dimensions.length === 0 ? (
              scope.kind === "target"
                ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<ScopeEmptyHint resources={["model-table"]} noun={t("维度/事实表")} />} />
                : <Empty description={isAdmin ? t("暂无维度/事实表,点「新建」登记并一键生成 Redshift DDL") : t("暂无维度/事实表")} />
            ) : <Table rowKey="modelTableId" size="small" pagination={false} dataSource={dimensions} columns={dimensionCols} style={{ marginTop: 12 }} />}
          </div>
        </div></Spin>
      ),
    },
    {
      key: "metrics", label: t("指标体系"),
      children: (
        <Spin spinning={!!tabLoading.metrics}><div data-testid="modeling-tab-metrics">
          <Space style={{ marginBottom: 12 }}>{addBtn("metrics", t("新建指标"))}</Space>
          {metrics.length === 0 ? <Empty description={isAdmin ? t("暂无指标,点「新建」定义原子/派生指标") : t("暂无指标")} /> :
            <Table rowKey="modelMetricId" size="small" pagination={false} dataSource={metrics} columns={metricCols} />}
        </div></Spin>
      ),
    },
  ];

  // ─── 各 kind 的编辑表单 ───
  const renderForm = () => {
    if (!modal) return null;
    const k = modal.kind;
    if (k === "layers") return (
      <Space direction="vertical" style={{ width: "100%" }}>
        <Input addonBefore={t("层编码")} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder={t("如 ODS / DWD")} />
        <Input addonBefore={t("名称")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("如 操作数据层")} />
        <Input addonBefore="schema" value={form.schema} onChange={(e) => setForm({ ...form, schema: e.target.value })} placeholder={t("Redshift schema 名,如 ods")} />
        <Space><span>{t("顺序")}</span><InputNumber value={form.seq} onChange={(v) => setForm({ ...form, seq: v })} min={1} /></Space>
        <Input.TextArea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={t("说明")} />
      </Space>
    );
    if (k === "domains") return (
      <Space direction="vertical" style={{ width: "100%" }}>
        <Input addonBefore={t("名称")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("如 交易域 / 订单主题")} />
        <Input addonBefore={t("编码")} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder={t("如 trade / order")} />
        <Select style={{ width: "100%" }} allowClear placeholder={t("父数据域(留空=新建顶级数据域;选中=主题域)")} value={form.parentId}
          onChange={(v) => setForm({ ...form, parentId: v })}
          options={domains.filter((d) => d.level === 1 && d.domainId !== modal.editing?.domainId).map((d) => ({ label: d.name, value: d.domainId }))} />
        <Input addonBefore={t("负责人")} value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} />
        <Input.TextArea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={t("说明")} />
      </Space>
    );
    if (k === "standards") return (
      <Space direction="vertical" style={{ width: "100%" }}>
        <Input addonBefore={t("标准名")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("如 金额")} />
        <Input addonBefore={t("编码")} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder={t("如 amount")} />
        <Input addonBefore={t("数据类型")} value={form.dataType} onChange={(e) => setForm({ ...form, dataType: e.target.value })} placeholder={t("如 DECIMAL(18,2)")} />
        <Space><Input addonBefore={t("单位")} value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder={t("如 元")} />
          <Input addonBefore={t("命名规范")} value={form.namingRule} onChange={(e) => setForm({ ...form, namingRule: e.target.value })} placeholder={t("如 下划线小写")} /></Space>
        <Select style={{ width: "100%" }} allowClear placeholder={t("关联码表(可选)")} value={form.refCodeTableId}
          onChange={(v) => setForm({ ...form, refCodeTableId: v })} options={codetables.map((c) => ({ label: `${c.name} (${c.code})`, value: c.codeTableId }))} />
        <Input addonBefore={t("约束")} value={form.constraint} onChange={(e) => setForm({ ...form, constraint: e.target.value })} placeholder={t("如 非空、>=0")} />
        <Input.TextArea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={t("说明")} />
      </Space>
    );
    if (k === "codetables") {
      const values: any[] = form.values || [];
      const setVal = (i: number, key: string, v: any) => { const nv = [...values]; nv[i] = { ...nv[i], [key]: v }; setForm({ ...form, values: nv }); };
      return (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Input addonBefore={t("码表名")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("如 订单状态")} />
          <Input addonBefore={t("编码")} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder={t("如 order_status(落地表名取自此)")} />
          <Input.TextArea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={t("说明")} />
          <div style={{ fontWeight: 500 }}>{t("枚举项")}</div>
          {values.map((v, i) => (
            <Space key={i}>
              <Input placeholder={t("码值")} style={{ width: 100 }} value={v.value} onChange={(e) => setVal(i, "value", e.target.value)} />
              <Input placeholder={t("含义")} style={{ width: 180 }} value={v.label} onChange={(e) => setVal(i, "label", e.target.value)} />
              <a style={{ color: "red" }} onClick={() => setForm({ ...form, values: values.filter((_, j) => j !== i) })}>{t("删除")}</a>
            </Space>
          ))}
          <Button size="small" icon={<PlusOutlined />} onClick={() => setForm({ ...form, values: [...values, { value: "", label: "", seq: values.length }] })}>{t("添加枚举项")}</Button>
        </Space>
      );
    }
    if (k === "dimensions") {
      const cols: any[] = form.columns || [];
      const setCol = (i: number, key: string, v: any) => { const nc = [...cols]; nc[i] = { ...nc[i], [key]: v }; setForm({ ...form, columns: nc }); };
      const isFact = form.tableType === "fact";
      return (
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Radio.Group value={form.tableType || "dimension"} onChange={(e) => setForm({ ...form, tableType: e.target.value })}>
            <Radio.Button value="dimension">{t("维度表")}</Radio.Button>
            <Radio.Button value="fact">{t("事实表")}</Radio.Button>
          </Radio.Group>
          <Input addonBefore={t("逻辑名")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("如 用户维度 / 订单事实")} />
          <Space.Compact style={{ width: "100%" }}>
            <Input addonBefore="schema" style={{ width: "50%" }} value={form.schema} onChange={(e) => setForm({ ...form, schema: e.target.value })} placeholder={t("如 dwd")} />
            <Input addonBefore={t("物理表名")} style={{ width: "50%" }} value={form.physicalTable} onChange={(e) => setForm({ ...form, physicalTable: e.target.value })} placeholder={isFact ? t("如 fact_order") : t("如 dim_user")} />
          </Space.Compact>
          <Space.Compact style={{ width: "100%" }}>
            <Select style={{ width: "50%" }} allowClear placeholder={t("归属分层")} value={form.layerId} onChange={(v) => setForm({ ...form, layerId: v })}
              options={layers.map((l) => ({ label: `${l.code} ${l.name}`, value: l.layerId }))} />
            <Select style={{ width: "50%" }} allowClear placeholder={t("归属数据域/主题域")} value={form.domainId} onChange={(v) => setForm({ ...form, domainId: v })}
              options={domains.map((d) => ({ label: `${d.level === 2 ? "  └ " : ""}${d.name}`, value: d.domainId }))} />
          </Space.Compact>
          {isFact ? (
            <Input addonBefore={t("粒度")} value={form.grain} onChange={(e) => setForm({ ...form, grain: e.target.value })} placeholder={t("如 一行=一笔订单明细")} />
          ) : (
            <Space.Compact style={{ width: "100%" }}>
              <Select style={{ width: "50%" }} allowClear placeholder={t("SCD 类型")} value={form.scdType} onChange={(v) => setForm({ ...form, scdType: v })}
                options={[{ label: t("SCD1(覆盖)"), value: "SCD1" }, { label: t("SCD2(拉链)"), value: "SCD2" }]} />
              <Input addonBefore={t("业务主键")} style={{ width: "50%" }} value={form.businessKey} onChange={(e) => setForm({ ...form, businessKey: e.target.value })} placeholder={t("如 user_id")} />
            </Space.Compact>
          )}
          <Divider style={{ margin: "4px 0" }}>{t("列定义")}</Divider>
          {cols.map((c, i) => (
            <Space key={i} align="start" wrap>
              <Input placeholder={t("列名")} style={{ width: 130 }} value={c.name} onChange={(e) => setCol(i, "name", e.target.value)} />
              <Select style={{ width: 130 }} value={c.dataType} onChange={(v) => setCol(i, "dataType", v)}
                options={DDL_TYPE_CHOICES.map((dt) => ({ label: dt, value: dt }))} />
              {(c.dataType === "VARCHAR" || c.dataType === "CHAR") && <InputNumber placeholder={t("长度")} style={{ width: 80 }} value={c.length} onChange={(v) => setCol(i, "length", v)} min={1} />}
              {c.dataType === "DECIMAL" && <><InputNumber placeholder={t("精度")} style={{ width: 70 }} value={c.precision} onChange={(v) => setCol(i, "precision", v)} min={1} max={38} /><InputNumber placeholder={t("标度")} style={{ width: 70 }} value={c.scale} onChange={(v) => setCol(i, "scale", v)} min={0} /></>}
              <Tooltip title={t("主键")}><Checkbox checked={c.isPrimaryKey} onChange={(e) => setCol(i, "isPrimaryKey", e.target.checked)}>PK</Checkbox></Tooltip>
              <Tooltip title={t("可空")}><Checkbox checked={c.nullable !== false} onChange={(e) => setCol(i, "nullable", e.target.checked)}>NULL</Checkbox></Tooltip>
              <Input placeholder={t("注释")} style={{ width: 120 }} value={c.comment} onChange={(e) => setCol(i, "comment", e.target.value)} />
              <a style={{ color: "red" }} onClick={() => setForm({ ...form, columns: cols.filter((_, j) => j !== i) })}>{t("删")}</a>
            </Space>
          ))}
          <Button size="small" icon={<PlusOutlined />} onClick={() => setForm({ ...form, columns: [...cols, { name: "", dataType: "VARCHAR", length: 256, nullable: true, isPrimaryKey: false }] })}>{t("添加列")}</Button>
        </Space>
      );
    }
    if (k === "metrics") {
      const isDerived = form.metricType === "derived";
      const mods: any[] = form.modifiers || [];
      const setMod = (i: number, key: string, v: any) => { const nm = [...mods]; nm[i] = { ...nm[i], [key]: v }; setForm({ ...form, modifiers: nm }); };
      const atomics = metrics.filter((m) => m.metricType === "atomic" && m.modelMetricId !== modal.editing?.modelMetricId);
      return (
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Alert type="info" showIcon style={{ fontSize: 12 }}
            message={t("必填:指标名 + 技术口径(表/聚合/度量列)。归属域、单位、业务口径为选填——留空只表示未补充,不影响指标计算与取数。")} />
          <Radio.Group value={form.metricType || "atomic"} onChange={(e) => setForm({ ...form, metricType: e.target.value })}>
            <Radio.Button value="atomic">{t("原子指标")}</Radio.Button>
            <Radio.Button value="derived">{t("派生指标")}</Radio.Button>
          </Radio.Group>
          <Input addonBefore={t("指标名")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={isDerived ? t("如 近7日支付GMV") : t("如 GMV / 订单数")} />
          <Space.Compact style={{ width: "100%" }}>
            <Select style={{ width: "60%" }} allowClear placeholder={t("归属数据域/主题域")} value={form.domainId} onChange={(v) => setForm({ ...form, domainId: v })}
              options={domains.map((d) => ({ label: `${d.level === 2 ? "  └ " : ""}${d.name}`, value: d.domainId }))} />
            <Input addonBefore={t("单位")} style={{ width: "40%" }} value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder={t("如 元")} />
          </Space.Compact>
          <div>
            <div style={{ fontSize: 12, color: "var(--bgp-text-dim, #8fb0c2)", marginBottom: 4 }}>{t("业务口径 / 定义(选填,给业务方看的人话说明)")}</div>
            <Input.TextArea rows={2} value={form.caliber} onChange={(e) => setForm({ ...form, caliber: e.target.value })} placeholder={t("如:统计广告点击后 7 日内的付费金额,含税")} />
          </div>
          {!isDerived ? (
            <>
              <Input addonBefore={t("数据表")} value={form.fqn} onChange={(e) => setForm({ ...form, fqn: e.target.value })} placeholder={t("schema.table,如 public.orders")} />
              <Space.Compact style={{ width: "100%" }}>
                <Select style={{ width: "40%" }} value={form.agg} onChange={(v) => setForm({ ...form, agg: v })}
                  options={["count", "count_distinct", "sum", "avg", "min", "max"].map((a) => ({ label: a, value: a }))} />
                <Input addonBefore={t("度量列")} style={{ width: "60%" }} value={form.measureColumn} onChange={(e) => setForm({ ...form, measureColumn: e.target.value })} placeholder={form.agg === "count" ? t("count(*) 无需度量列") : t("如 amount")} disabled={form.agg === "count"} />
              </Space.Compact>
              <Input addonBefore={t("时间列")} value={form.timeColumn} onChange={(e) => setForm({ ...form, timeColumn: e.target.value })} placeholder={t("可选,供派生指标做时间窗,如 created_at")} />
            </>
          ) : (
            <>
              <Select style={{ width: "100%" }} placeholder={t("引用的原子指标")} value={form.atomicId} onChange={(v) => setForm({ ...form, atomicId: v })}
                options={atomics.map((m) => ({ label: `${m.name} (${m.agg}@${m.fqn})`, value: m.modelMetricId }))} />
              <Space>
                <span>{t("时间周期")}</span>
                <Select style={{ width: 160 }} value={form.timeWindow || "all"} onChange={(v) => setForm({ ...form, timeWindow: v })}
                  options={[{ label: t("全部(不限)"), value: "all" }, { label: t("今日"), value: "today" }, { label: t("近7日"), value: "7d" }, { label: t("近30日"), value: "30d" }, { label: t("近90日"), value: "90d" }, { label: t("本月至今"), value: "mtd" }, { label: t("今年至今"), value: "ytd" }]} />
                <Input addonBefore={t("时间列")} value={form.timeColumn} onChange={(e) => setForm({ ...form, timeColumn: e.target.value })} placeholder={t("如 created_at(时间窗需要)")} style={{ width: 260 }} />
              </Space>
              <Divider style={{ margin: "4px 0" }}>{t("修饰词(过滤条件)")}</Divider>
              {mods.map((m, i) => (
                <Space key={i}>
                  <Input placeholder={t("列名")} style={{ width: 120 }} value={m.column} onChange={(e) => setMod(i, "column", e.target.value)} />
                  <Select style={{ width: 80 }} value={m.op || "="} onChange={(v) => setMod(i, "op", v)}
                    options={["=", "!=", ">", ">=", "<", "<=", "in"].map((o) => ({ label: o, value: o }))} />
                  <Input placeholder={m.op === "in" ? t("逗号分隔多值") : t("值")} style={{ width: 160 }} value={Array.isArray(m.value) ? m.value.join(",") : m.value} onChange={(e) => setMod(i, "value", m.op === "in" ? e.target.value.split(",").map((s) => s.trim()).filter(Boolean) : e.target.value)} />
                  <a style={{ color: "red" }} onClick={() => setForm({ ...form, modifiers: mods.filter((_, j) => j !== i) })}>{t("删")}</a>
                </Space>
              ))}
              <Button size="small" icon={<PlusOutlined />} onClick={() => setForm({ ...form, modifiers: [...mods, { column: "", op: "=", value: "" }] })}>{t("添加修饰词")}</Button>
            </>
          )}
        </Space>
      );
    }
    return null;
  };

  const modalTitle: Record<string, string> = { layers: t("分层"), domains: t("数据域"), standards: t("数据标准"), codetables: t("码表"), dimensions: t("维度/事实表"), metrics: t("指标") };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}><ApartmentOutlined /> {t("数据建模")}</h2>
        <Button icon={<ReloadOutlined />} onClick={loadAll}>{t("刷新")}</Button>
      </div>
      <p style={{ color: "#888", marginTop: 0 }}>{t("数仓规划:分层(ODS/DWD/DWS/ADS)+ 主题域/数据域 + 数据标准 + 码表(可落地 Redshift)。")}{!isAdmin && t("（管理需平台管理员)")}</p>
      <ModelingGuide />
      {/* 🔴 逐类如实说明「哪几个 Tab 会跟着切、哪几个不会」。
          不说清的代价:用户切到别的区,看见分层/数据域一字未变,只能怀疑切换根本没生效。 */}
      {scope.kind !== "global" && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="modeling-scope-note"
          message={
            scope.kind === "target"
              ? t("当前只看 {region}:码表与维度建模按「绑定/已落地到该区」过滤;分层、数据域、数据标准、指标是平台级定义,不分区。新建的定义默认只绑主控区 —— 要在本区生效,请在行内用「落地」把它物化到该区。", { region: scopeRegionLabel })
              : t("对比视角:码表与维度建模按所选各区的绑定过滤;分层、数据域、数据标准、指标是平台级定义,不分区。")
          }
        />
      )}
      {loading ? <Spin size="large" style={{ display: "block", margin: "60px auto" }} /> :
        <Card data-testid="modeling-tabs"><Tabs activeKey={tab} onChange={setTab} items={tabItems} /></Card>}

      <Modal title={`${modal?.editing ? t("编辑") : t("新建")}${modalTitle[modal?.kind || ""] || ""}`} open={!!modal} onOk={doSave} confirmLoading={saving} onCancel={() => setModal(null)} okText={t("保存")} width={modal?.kind === "dimensions" ? 820 : modal?.kind === "metrics" ? 640 : 560} destroyOnClose>
        {renderForm()}
      </Modal>

      <Modal title={t("DDL 预览 — {name}", { name: ddlModal?.name || "" })} open={!!ddlModal} onCancel={() => setDdlModal(null)} footer={<Button onClick={() => setDdlModal(null)}>{t("关闭")}</Button>} width={720}>
        <pre style={{ background: "var(--bgp-bg, #0b1a24)", color: "var(--bgp-text, #cfe6f0)", border: "1px solid var(--bgp-panel-border, #1d4254)", padding: 12, borderRadius: 4, overflow: "auto", fontSize: 12, lineHeight: 1.5 }}>{ddlModal?.ddl}</pre>
        <p style={{ color: "#888", marginBottom: 0 }}>{t("该 DDL 由列定义安全生成(类型白名单 + 标识符校验)。点列表「应用」按钮即在 Redshift 执行建表。")}</p>
      </Modal>

      {/* 落地面板(逐 target 观测态 / 重新检测 / drift 字段级差异 / 强制重建) */}
      {landPanel ? (
        <LandingPanel
          open
          kind={landPanel.kind}
          id={landPanel.id}
          name={landPanel.name}
          table={landPanel.table}
          defHash={landPanel.defHash}
          landedByTarget={landPanel.landedByTarget}
          targets={landPanel.targets}
          execTargets={execTargets}
          onClose={() => setLandPanel(null)}
          onDone={() => { loadKind(landPanel.kind === "code-table" ? "codetables" : "dimensions"); setLandPanel(null); }}
        />
      ) : null}

      {/* 删定义受控:仍有落地产物 ⇒ 两条出口(逐区清理 / 显式保留),平台不代劳 */}
      <Modal title={t("该定义仍有已落地的物理表")} open={!!deleteDecision} onCancel={() => setDeleteDecision(null)} footer={null} width={680} destroyOnClose>
        {deleteDecision ? (() => {
          const r = deleteDecision.row || {};
          const isCt = deleteDecision.kind === "codetables";
          const expected = isCt ? String(r.code || "") : String(r.physicalTable || "");
          const openPanel = () => {
            setDeleteDecision(null);
            setLandPanel(isCt
              ? { kind: "code-table", id: r.codeTableId, name: r.name, table: r.physicalTable || codeTableLandingFqn(r).fqn, defHash: r.defHash || "", landedByTarget: r.landedByTarget, targets: r.targets }
              : { kind: "model-table", id: r.modelTableId, name: r.name || r.physicalTable, table: r.physicalTable2 || `${r.schema}.${r.physicalTable}`, defHash: r.defHash || "", landedByTarget: r.landedByTarget, targets: r.targets });
          };
          return (
            <Space direction="vertical" style={{ width: "100%" }}>
              <Alert type="warning" showIcon message={t("平台不会替你决定这些表的去留。")} description={deleteDecision.message} />
              <Table size="small" pagination={false} dataSource={deleteDecision.artifacts} rowKey="targetId"
                columns={[
                  { title: t("执行区域"), dataIndex: "targetId", width: 180 },
                  { title: t("物理表"), dataIndex: "table", render: (v: string) => <code>{v}</code> },
                  { title: t("观测态"), dataIndex: "status", width: 120 },
                ]} />
              <Button type="primary" onClick={openPanel}>{t("去落地面板逐区〔解绑并清理〕")}</Button>
              <Divider style={{ margin: "8px 0" }} />
              <span>{t("或:保留物理表,只删定义(审计将逐表登记「刻意保留」)。逐字输入 {v} 确认:", { v: expected })}</span>
              <Input value={deleteConfirm} onChange={(e) => setDeleteConfirm(e.target.value)} placeholder={expected} />
              <Button danger disabled={deleteConfirm !== expected}
                onClick={() => doDelete(deleteDecision.kind, deleteDecision.id, r, { confirm: deleteConfirm })}>
                {t("保留物理表,只删定义")}
              </Button>
            </Space>
          );
        })() : null}
      </Modal>
    </div>
  );
}
