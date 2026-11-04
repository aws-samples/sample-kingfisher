"use client";

// 字段配置器(QuickSight 式三栏拖拽工作台,治"不会用")。
// 左栏:数据集字段列表(#数值/📅日期/文本图标,可搜索,HTML5 draggable);
// 中栏:改图表类型 + 字段架(X轴/值(聚合)/分组·颜色/筛选,拖字段进槽,槽内可删/改聚合);
// 右栏:大画布预览(占最大面积,BiChart 出图)。
// 产出:编译成 v1 sql source(kind:"sql")+ builder spec(可再编辑)。下游取数/脱敏零改动。
// 隔离红线:BI 私有组件;图表走 BiChart;schema 走只读 /api/bi/schema;拖拽用 HTML5 原生 DnD 零依赖。

import React, { useEffect, useState, useCallback, useRef } from "react";
import { Select, Button, Space, Spin, Tag, InputNumber, Input, Empty, Typography, message, Tooltip, Segmented, Switch } from "antd";
import {
  DeleteOutlined, EyeOutlined, FieldNumberOutlined, FieldStringOutlined, CalendarOutlined,
  SearchOutlined, DatabaseOutlined, BarChartOutlined, LineChartOutlined, PieChartOutlined,
  TableOutlined, DashboardOutlined, HolderOutlined,
} from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
import WidgetRenderer from "@/components/bi/WidgetRenderer";
import { AGG_FNS, measureAlias, type AggFn, type FilterOp, type BuilderSpec } from "@/lib/bi/query-builder";
import type { BiEngine, BiChartType, WidgetViz } from "@/lib/bi/types";
// 字段配置器的预览也必须打到当前视角那个区
// 否则「预览看到的是主控区、保存后跑在别的区」—— 两个区的同名表数据不同,用户会以为保存坏了。
import { useScope } from "@/components/scope/ScopeProvider";
import { landingOfScope } from "@/lib/scope/scope";

const { Text } = Typography;

interface SchemaCol { name: string; type: string; }
interface SchemaTable { schema: string; table: string; columns: SchemaCol[]; }

// 列类型判定 + 图标(数值列优先做度量,日期列优先做趋势 X 轴)。
function isNumericType(t: string): boolean { return /int|numeric|decimal|double|real|float|bigint|smallint|money/i.test(t || ""); }
function isDateType(t: string): boolean { return /date|time|timestamp/i.test(t || ""); }
function typeIcon(t: string) {
  if (isNumericType(t)) return <FieldNumberOutlined style={{ color: "var(--bgp-s3, #12a07f)" }} />;
  if (isDateType(t)) return <CalendarOutlined style={{ color: "var(--bgp-s4, #8b6fe8)" }} />;
  return <FieldStringOutlined style={{ color: "var(--bgp-s1, #3d8bfd)" }} />;
}

// 字段架槽标识:拖放目标。
type WellId = "x" | "y" | "group" | "filter";

const CHART_ICON: Record<string, React.ReactNode> = {
  bar: <BarChartOutlined />, line: <LineChartOutlined />, pie: <PieChartOutlined />,
  table: <TableOutlined />, metric: <DashboardOutlined />, gauge: <DashboardOutlined />,
};

export interface FieldConfigValue {
  engine: BiEngine;
  spec: BuilderSpec | null;
  sql: string;
  chart: BiChartType;
  xField?: string;
  yField?: string;
  viz: WidgetViz; // v3:完整可视化 spec(含多系列/分组/堆叠/方向),父组件保存时直接用
}

export default function FieldConfigurator({
  engine,
  initialSpec,
  onChange,
}: {
  engine: BiEngine;
  initialSpec?: BuilderSpec | null;
  onChange: (v: FieldConfigValue) => void;
}) {
  const t = useT();
  // 预览落点 = 当前视角(「全部」= 主控区)
  const { scope: fcScope } = useScope();
  // 恒有(全部 = 主控区,显式;后端缺 ⇒ 400)
  const fcTarget = landingOfScope(fcScope);
  const [tables, setTables] = useState<SchemaTable[]>([]);
  const [loadingSchema, setLoadingSchema] = useState(false);
  const [tableKey, setTableKey] = useState<string>(initialSpec ? `${initialSpec.schema}.${initialSpec.table}` : "");
  const [fieldSearch, setFieldSearch] = useState("");

  // 字段架状态。dimensions[0] = X 轴维度;dimensions[1](若有)= 分组/颜色维度(pivot)。
  // 兼容:老 spec 的 dimensions 可能有多个,取第一个为 X、第二个为分组。
  const initDims = initialSpec?.dimensions || [];
  const [dimensions, setDimensions] = useState<string[]>(initDims.slice(0, 1)); // X 轴(单值)
  const [groupField, setGroupField] = useState<string>(initDims[1] || ""); // 分组/颜色维度(单值,可空)
  const [measures, setMeasures] = useState<{ col: string; agg: AggFn }[]>((initialSpec?.measures as any) || []); // 值(可多个)
  const [filters, setFilters] = useState<{ col: string; op: FilterOp; value: string }[]>((initialSpec?.filters as any) || []);
  const [orderDesc, setOrderDesc] = useState<boolean>(initialSpec?.orderBy?.desc ?? true);
  const [limit, setLimit] = useState<number | null>(initialSpec?.limit ?? 200);
  const [chart, setChart] = useState<BiChartType>("bar");
  const [stack, setStack] = useState<boolean>(false); // 堆叠(仅柱状)
  const [horizontal, setHorizontal] = useState<boolean>(false); // 横向 barh(仅柱状)

  const [preview, setPreview] = useState<{ columns: string[]; rows: unknown[][] } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const dragCol = useRef<string | null>(null); // 当前拖拽的字段名

  // 拉 schema
  const loadSchema = useCallback(async () => {
    setLoadingSchema(true);
    try {
      const r = await fetch(`/api/bi/schema?engine=${engine}&targetId=${encodeURIComponent(fcTarget)}`).then((x) => x.json());
      setTables(r?.success ? (r.data?.tables || []) : []);
    } finally {
      setLoadingSchema(false);
    }
  }, [engine]);
  useEffect(() => { loadSchema(); }, [loadSchema]);

  const curTable = tables.find((tb) => `${tb.schema}.${tb.table}` === tableKey);
  const cols = curTable?.columns || [];
  const colType = (name: string) => cols.find((c) => c.name === name)?.type || "";
  const shownCols = cols.filter((c) => !fieldSearch || c.name.toLowerCase().includes(fieldSearch.toLowerCase()));

  // GROUP BY 维度 = X 轴维度 +(可选)分组维度。两者都进 SELECT/GROUP BY(buildSql 零改动)。
  const allDims = useCallback((): string[] => {
    const x = dimensions[0];
    const g = groupField && groupField !== x ? groupField : "";
    return [...(x ? [x] : []), ...(g ? [g] : [])];
  }, [dimensions, groupField]);

  // 组装 builder spec
  const buildSpec = useCallback((): BuilderSpec | null => {
    if (!curTable) return null;
    const validMeasures = measures.filter((m) => m.col);
    const dims = allDims();
    const orderRef = validMeasures.length
      ? measureAlias({ col: validMeasures[0].col, agg: validMeasures[0].agg }, 0)
      : (dims[0] || "");
    return {
      engine, schema: curTable.schema, table: curTable.table,
      dimensions: dims, measures: validMeasures,
      filters: filters.filter((f) => f.col && f.value !== ""),
      orderBy: orderRef ? { ref: orderRef, desc: orderDesc } : undefined,
      limit: limit ?? undefined,
    };
  }, [curTable, engine, allDims, measures, filters, orderDesc, limit]);

  // 组装完整 viz(v3):把字段架状态翻译成渲染契约。yFields = 度量别名(与 buildSql 生成列名一致口径);
  // seriesField = 分组维度;bar 才有 stack/orient。父组件保存时直接用这个 viz。
  const buildViz = useCallback((): WidgetViz => {
    const validMeasures = measures.filter((m) => m.col);
    const yFields = validMeasures.map((m, i) => measureAlias({ col: m.col, agg: m.agg }, i));
    const x = dimensions[0];
    const g = groupField && groupField !== x ? groupField : "";
    const viz: WidgetViz = { chart, auto: false };
    if (x) viz.xField = x;
    // 单度量时 yField 兜底(向后兼容单系列渲染);多度量交给 yFields。
    if (yFields.length === 1) viz.yField = yFields[0];
    if (yFields.length > 1) viz.yFields = yFields;
    if (g) viz.seriesField = g;
    if (chart === "bar") {
      if (stack) viz.stack = true;
      if (horizontal) viz.orient = "h";
    }
    return viz;
  }, [measures, dimensions, groupField, chart, stack, horizontal]);

  const doPreview = useCallback(async () => {
    const spec = buildSpec();
    if (!spec) { message.warning(t("请先选择数据表")); return; }
    if (!spec.dimensions.length && !spec.measures.length) { message.warning(t("请拖字段到 X轴 或 值")); return; }
    setPreviewing(true);
    setPreview(null);
    try {
      const r = await fetch("/api/bi/query", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: { kind: "builder", ...spec }, targetId: fcTarget }),
      }).then((x) => x.json());
      if (r?.success) {
        setPreview({ columns: r.data.columns, rows: r.data.rows });
        const viz = buildViz();
        onChange({ engine, spec, sql: r.data.sql || "", chart, xField: viz.xField, yField: viz.yField, viz });
      } else {
        message.error(r?.error?.message || t("预览失败"));
      }
    } finally {
      setPreviewing(false);
    }
  }, [buildSpec, buildViz, engine, chart, onChange, t]);

  // 每次配置变化回传父组件(便于保存)。
  useEffect(() => {
    const spec = buildSpec();
    if (spec) {
      const viz = buildViz();
      onChange({ engine, spec, sql: "", chart, xField: viz.xField, yField: viz.yField, viz });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableKey, dimensions, groupField, measures, filters, orderDesc, limit, chart, stack, horizontal]);

  // ── 拖放:把字段放进某个槽 ────────────────────────────────────────────────
  // X 轴 = 单值维度(替换);分组/颜色 = 单值维度(替换,pivot 用);值 = 可多个(多系列);筛选 = 可多个。
  const onDropField = (well: WellId) => {
    const col = dragCol.current;
    dragCol.current = null;
    if (!col) return;
    if (well === "x") { setDimensions([col]); }
    else if (well === "group") { setGroupField(col); }
    else if (well === "y") {
      const agg: AggFn = isNumericType(colType(col)) ? "sum" : "count";
      if (!measures.some((m) => m.col === col)) setMeasures((p) => [...p, { col, agg }]);
    } else if (well === "filter") {
      if (!filters.some((f) => f.col === col)) setFilters((p) => [...p, { col, op: "=", value: "" }]);
    }
  };

  // 双击字段:数值→值(可累加多系列),其它→X轴(替换)。不拖也能用,降低门槛。
  const quickAdd = (col: string) => {
    if (isNumericType(colType(col))) { if (!measures.some((m) => m.col === col)) setMeasures((p) => [...p, { col, agg: "sum" }]); }
    else { setDimensions([col]); }
  };

  // 字段架槽 UI(拖放目标 + 已放字段的 chip)。
  const Well = ({ well, title, hint, children }: { well: WellId; title: string; hint: string; children: React.ReactNode }) => {
    const [over, setOver] = useState(false);
    return (
      <div style={{ marginBottom: 12 }}>
        <Text strong style={{ fontSize: 13 }}>{title}</Text>
        <div
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); onDropField(well); }}
          style={{
            marginTop: 4, minHeight: 40, borderRadius: 6, padding: 6,
            border: `1px dashed ${over ? "var(--bgp-primary, #22d3ee)" : "var(--bgp-panel-border, #1d4254)"}`,
            background: over ? "var(--bgp-primary, #22d3ee)18" : "var(--bgp-bg, transparent)",
            transition: "all .15s ease",
          }}
        >
          {children || <Text type="secondary" style={{ fontSize: 12 }}>{hint}</Text>}
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", gap: 12, alignItems: "stretch", minHeight: 560 }}>
      {/* ── 左栏:数据集 + 字段列表 ────────────────────────────── */}
      <div style={{ flex: "0 0 240px", border: "1px solid var(--bgp-panel-border, #1d4254)", borderRadius: 8, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--bgp-panel-border, #1d4254)", display: "flex", alignItems: "center", gap: 6 }}>
          <DatabaseOutlined style={{ color: "var(--bgp-primary, #22d3ee)" }} />
          <Text strong>{t("数据")}</Text>
        </div>
        <div style={{ padding: 10 }}>
          <Select
            showSearch loading={loadingSchema} style={{ width: "100%" }} size="small"
            value={tableKey || undefined}
            onChange={(v) => { setTableKey(v); setDimensions([]); setGroupField(""); setMeasures([]); setFilters([]); setPreview(null); }}
            placeholder={t("选择数据表(无需写 SQL)")}
            options={tables.map((tb) => ({ value: `${tb.schema}.${tb.table}`, label: `${tb.schema}.${tb.table}` }))}
            filterOption={(input, opt) => String(opt?.label || "").toLowerCase().includes(input.toLowerCase())}
          />
          {curTable && (
            <Input size="small" prefix={<SearchOutlined />} placeholder={t("搜索字段")} value={fieldSearch} onChange={(e) => setFieldSearch(e.target.value)} style={{ marginTop: 8 }} allowClear />
          )}
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "0 8px 8px" }}>
          {!curTable ? (
            <Text type="secondary" style={{ fontSize: 12, padding: 8, display: "block" }}>{t("先选数据表")}</Text>
          ) : shownCols.map((c) => (
            <div
              key={c.name}
              draggable
              onDragStart={() => { dragCol.current = c.name; }}
              onDoubleClick={() => quickAdd(c.name)}
              title={t("拖到右侧字段架,或双击快速添加")}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 6px", borderRadius: 4, cursor: "grab", fontSize: 13 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bgp-primary, #22d3ee)14")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <HolderOutlined style={{ color: "var(--bgp-text-dim, #8fb0c2)", fontSize: 11 }} />
              {typeIcon(c.type)}
              <Text style={{ flex: 1 }} ellipsis>{c.name}</Text>
            </div>
          ))}
        </div>
      </div>

      {/* ── 中栏:图表类型 + 字段架 ────────────────────────────── */}
      <div style={{ flex: "0 0 300px", border: "1px solid var(--bgp-panel-border, #1d4254)", borderRadius: 8, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--bgp-panel-border, #1d4254)", display: "flex", alignItems: "center", gap: 6 }}>
          <BarChartOutlined style={{ color: "var(--bgp-primary, #22d3ee)" }} />
          <Text strong>{t("视觉对象")}</Text>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
          {/* 图表类型 */}
          <Text strong style={{ fontSize: 13 }}>{t("图表类型")}</Text>
          <div style={{ marginTop: 6, marginBottom: 14 }}>
            <Select
              value={chart} onChange={setChart} style={{ width: "100%" }} size="small"
              options={[
                { value: "bar", label: <span>{CHART_ICON.bar} {t("柱状图")}</span> },
                { value: "line", label: <span>{CHART_ICON.line} {t("折线图")}</span> },
                { value: "pie", label: <span>{CHART_ICON.pie} {t("饼图")}</span> },
                { value: "table", label: <span>{CHART_ICON.table} {t("表格")}</span> },
                { value: "metric", label: <span>{CHART_ICON.metric} {t("指标卡")}</span> },
                { value: "gauge", label: <span>{CHART_ICON.gauge} {t("仪表")}</span> },
              ]}
            />
          </div>

          {/* X 轴(维度,单值)*/}
          <Well well="x" title={t("X 轴 / 维度")} hint={t("拖字段到此处")}>
            {dimensions[0] && (
              <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 6px", marginBottom: 4, borderRadius: 4, background: "var(--bgp-s1, #3d8bfd)22" }}>
                {typeIcon(colType(dimensions[0]))}
                <Text style={{ flex: 1, fontSize: 12 }} ellipsis>{dimensions[0]}</Text>
                <DeleteOutlined style={{ cursor: "pointer", fontSize: 11 }} onClick={() => setDimensions([])} />
              </div>
            )}
          </Well>

          {/* 分组 / 颜色(第二维度,pivot 成多系列)。仅柱状/折线有意义;单值,替换。*/}
          {(chart === "bar" || chart === "line") && (
            <Well well="group" title={t("分组 / 颜色")} hint={t("拖分类字段:每个取值一条系列")}>
              {groupField && (
                <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 6px", marginBottom: 4, borderRadius: 4, background: "var(--bgp-s4, #8b6fe8)22" }}>
                  {typeIcon(colType(groupField))}
                  <Text style={{ flex: 1, fontSize: 12 }} ellipsis>{groupField}</Text>
                  <DeleteOutlined style={{ cursor: "pointer", fontSize: 11 }} onClick={() => setGroupField("")} />
                </div>
              )}
            </Well>
          )}

          {/* 值(度量 + 聚合,可多个 = 多系列)*/}
          <Well well="y" title={t("值 / 度量")} hint={t("拖数值字段(可多个=多系列)")}>
            {measures.length > 0 && measures.map((m, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 6px", marginBottom: 4, borderRadius: 4, background: "var(--bgp-s3, #12a07f)22" }}>
                <Select
                  size="small" variant="borderless" value={m.agg} style={{ width: 78 }}
                  onChange={(v) => setMeasures((p) => p.map((x, k) => k === i ? { ...x, agg: v } : x))}
                  options={AGG_FNS.map((a) => ({ value: a, label: a }))}
                />
                <Text style={{ flex: 1, fontSize: 12 }} ellipsis>{m.col === "*" ? "*" : m.col}</Text>
                <DeleteOutlined style={{ cursor: "pointer", fontSize: 11 }} onClick={() => setMeasures((p) => p.filter((_, k) => k !== i))} />
              </div>
            ))}
          </Well>

          {/* 筛选 */}
          <Well well="filter" title={t("筛选")} hint={t("拖字段到此处筛选")}>
            {filters.length > 0 && filters.map((f, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 4 }}>
                <Text style={{ width: 54, fontSize: 11 }} ellipsis>{f.col}</Text>
                <Select size="small" value={f.op} style={{ width: 56 }} onChange={(v) => setFilters((p) => p.map((x, k) => k === i ? { ...x, op: v } : x))}
                  options={(["=", "!=", ">", "<", ">=", "<="] as FilterOp[]).map((o) => ({ value: o, label: o }))} />
                <Input size="small" style={{ flex: 1 }} placeholder={t("值")} value={f.value} onChange={(e) => setFilters((p) => p.map((x, k) => k === i ? { ...x, value: e.target.value } : x))} />
                <DeleteOutlined style={{ cursor: "pointer", fontSize: 11 }} onClick={() => setFilters((p) => p.filter((_, k) => k !== i))} />
              </div>
            ))}
          </Well>

          {/* 柱状图专属:堆叠 / 横向。仅在多系列(多度量或有分组维度)时"堆叠"才有视觉意义,但始终可切。*/}
          {chart === "bar" && (
            <div style={{ marginTop: 10, display: "flex", gap: 16, alignItems: "center" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t("堆叠")}</Text>
                <Switch size="small" checked={stack} onChange={setStack} />
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t("横向")}</Text>
                <Switch size="small" checked={horizontal} onChange={setHorizontal} />
              </span>
            </div>
          )}

          {/* 排序 + 限制 */}
          <Space style={{ marginTop: 10 }} wrap>
            <span><Text type="secondary" style={{ fontSize: 12 }}>{t("排序")}</Text>
              <Button size="small" style={{ marginLeft: 4 }} onClick={() => setOrderDesc((d) => !d)}>{orderDesc ? `${t("降序")} ↓` : `${t("升序")} ↑`}</Button>
            </span>
            <span><Text type="secondary" style={{ fontSize: 12 }}>{t("限制")}</Text>
              <InputNumber size="small" style={{ width: 80, marginLeft: 4 }} min={1} max={10000} value={limit} onChange={(v) => setLimit(v)} />
            </span>
          </Space>
        </div>
      </div>

      {/* ── 右栏:大画布预览 ────────────────────────────── */}
      <div style={{ flex: "1 1 auto", minWidth: 320, border: "1px solid var(--bgp-panel-border, #1d4254)", borderRadius: 8, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--bgp-panel-border, #1d4254)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Text strong>{t("预览")}</Text>
          <Button type="primary" size="small" icon={<EyeOutlined />} loading={previewing} onClick={doPreview}>{t("预览")}</Button>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {previewing ? <Spin />
            : preview ? <div style={{ width: "100%" }}><WidgetRenderer data={preview} viz={buildViz()} /></div>
            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("拖字段到 X轴/值 → 点预览")} />}
        </div>
      </div>
    </div>
  );
}
