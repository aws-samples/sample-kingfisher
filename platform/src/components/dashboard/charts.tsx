"use client";

import React from "react";
import { useT } from "@/lib/i18n/useT";

// 首页仪表盘自绘 SVG 图表 (v1.14.0)
//
// 无第三方图表库（避免与 antd v6 的依赖/体积冲突），全部用 SVG 自绘，配色对齐青蓝科技主题。
// 提供：Donut（甜甜圈 + 图例，用于状态/构成分布）、TrendArea（时间序列面积+折线趋势）、
// BarList（横向条形，用于分类计数）。均对空数据优雅降级。
//
// v1.14.0 交互：全部图表加鼠标移入/移出效果（零新增依赖，纯 SVG + React state）：
//   - Donut：hover 分段 → 该段外扩加亮、其余变暗、中心显示该段名称/占比、图例联动高亮；
//   - TrendArea：鼠标移动 → 竖向指示线跟随、最近数据点放大、antd 风格浮层显示日期+数值；
//   - BarList：hover 行 → 整条提亮加描边。
//   浮层 ChartTooltip 用 fixed 定位跟随鼠标，不受 SVG 裁剪；视觉对齐 antd Tooltip（深色卡片/圆角/主色边）。

export interface Slice {
  label: string;
  value: number;
  color: string;
}

// 换肤:读全站 CSS 变量(ThemeProvider 注入),默认值=改造前青蓝,未切换像素级一致。
const TEXT = "var(--bgp-text, #cfe6f0)";
const SUBTEXT = "var(--bgp-text-dim, #8fb0c2)";
const GRID = "var(--bgp-panel-border, #1d4254)";
const PRIMARY = "var(--bgp-primary, #22d3ee)";
const DOT_BG = "var(--bgp-bg, #08131b)"; // 折线数据点的描边间隙(取页面底色)

function fmt(v: number): string {
  if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(1) + "亿";
  if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(1) + "万";
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

// ── 跟随鼠标的浮层提示(antd Tooltip 风格,fixed 不被 SVG 裁剪)──────────────────
interface TipState {
  x: number; // 视口坐标(clientX/clientY)
  y: number;
  title: string;
  rows: { label: string; value: string; color?: string }[];
}

function ChartTooltip({ tip }: { tip: TipState | null }) {
  if (!tip) return null;
  return (
    <div
      style={{
        position: "fixed",
        left: tip.x + 14,
        top: tip.y + 14,
        zIndex: 1200,
        pointerEvents: "none",
        background: "var(--bgp-panel, rgba(9,22,32,0.96))",
        border: `1px solid var(--bgp-primary, #22d3ee)`,
        borderRadius: 8,
        padding: "7px 11px",
        boxShadow: "0 4px 18px rgba(0,0,0,0.45)",
        fontSize: 12,
        color: TEXT,
        maxWidth: 260,
        backdropFilter: "blur(2px)",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: tip.rows.length ? 4 : 0, color: TEXT }}>{tip.title}</div>
      {tip.rows.map((r, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 7, lineHeight: "18px" }}>
          {r.color && (
            <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color, display: "inline-block", flex: "0 0 auto" }} />
          )}
          <span style={{ color: SUBTEXT, flex: 1 }}>{r.label}</span>
          <span style={{ color: TEXT, fontWeight: 600 }}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/** 甜甜圈图：分段环 + 中心总计 + 右侧图例。hover 分段/图例联动高亮。 */
export function Donut({
  data,
  size = 168,
  thickness = 22,
  centerLabel,
}: {
  data: Slice[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
}) {
  const t = useT();
  const [active, setActive] = React.useState<number | null>(null); // 高亮的 data 索引
  const [tip, setTip] = React.useState<TipState | null>(null);
  const total = data.reduce((s, d) => s + (d.value || 0), 0);
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const C = 2 * Math.PI * r;

  let offset = 0;
  const segs =
    total > 0
      ? data
          .map((d, di) => ({ d, di })) // 保留原始索引,便于图例↔分段联动
          .filter(({ d }) => d.value > 0)
          .map(({ d, di }) => {
            const frac = d.value / total;
            const seg = { ...d, di, dash: frac * C, gap: C - frac * C, off: offset };
            offset += frac * C;
            return seg;
          })
      : [];

  const pct = (v: number) => (total > 0 ? Math.round((v / total) * 100) : 0);
  const activeSlice = active != null ? data[active] : null;

  const showTip = (e: React.MouseEvent, d: Slice) => {
    setTip({
      x: e.clientX,
      y: e.clientY,
      title: d.label,
      rows: [{ label: t("数量"), value: `${fmt(d.value)} (${pct(d.value)}%)`, color: d.color }],
    });
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" onMouseLeave={() => { setActive(null); setTip(null); }}>
        {/* 底环 */}
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(34,211,238,0.08)" strokeWidth={thickness} />
        {/* 分段 */}
        {segs.map((s) => {
          const isActive = active === s.di;
          const dim = active != null && !isActive;
          return (
            <circle
              key={s.di}
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={isActive ? thickness + 6 : thickness}
              strokeDasharray={`${s.dash} ${s.gap}`}
              strokeDashoffset={-s.off}
              strokeLinecap="butt"
              transform={`rotate(-90 ${cx} ${cy})`}
              opacity={dim ? 0.35 : 1}
              style={{ transition: "stroke-width .18s ease, opacity .18s ease", cursor: "pointer" }}
              onMouseEnter={(e) => { setActive(s.di); showTip(e, s); }}
              onMouseMove={(e) => showTip(e, s)}
            />
          );
        })}
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize={activeSlice ? 22 : 26} fontWeight={700} fill={activeSlice ? activeSlice.color : TEXT} style={{ transition: "font-size .18s ease" }}>
          {activeSlice ? `${pct(activeSlice.value)}%` : fmt(total)}
        </text>
        <text x={cx} y={cy + 18} textAnchor="middle" fontSize={12} fill={SUBTEXT}>
          {activeSlice ? activeSlice.label : (centerLabel ?? t("总计"))}
        </text>
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 120 }}>
        {data.map((d, i) => {
          const dim = active != null && active !== i;
          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                cursor: "pointer",
                opacity: dim ? 0.4 : 1,
                transform: active === i ? "translateX(2px)" : "none",
                transition: "opacity .18s ease, transform .18s ease",
              }}
              onMouseEnter={(e) => { setActive(i); showTip(e, d); }}
              onMouseMove={(e) => showTip(e, d)}
              onMouseLeave={() => { setActive(null); setTip(null); }}
            >
              <span style={{ width: 10, height: 10, borderRadius: 3, background: d.color, display: "inline-block", flex: "0 0 auto", boxShadow: active === i ? `0 0 6px ${d.color}` : "none" }} />
              <span style={{ color: SUBTEXT, flex: 1 }}>{d.label}</span>
              <span style={{ color: TEXT, fontWeight: 600 }}>{fmt(d.value)}</span>
              <span style={{ color: SUBTEXT, width: 42, textAlign: "right" }}>{pct(d.value)}%</span>
            </div>
          );
        })}
      </div>
      <ChartTooltip tip={tip} />
    </div>
  );
}

/** 面积 + 折线趋势图（时间序列）。鼠标移动显示竖线指示 + 数据点放大 + 浮层。 */
export function TrendArea({
  points,
  height = 220,
  color = PRIMARY,
}: {
  points: { label: string; value: number }[];
  height?: number;
  color?: string;
}) {
  const t = useT();
  const W = 760;
  const PAD_L = 40;
  const PAD_R = 16;
  const PAD_T = 16;
  const PAD_B = 36;
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const [hoverI, setHoverI] = React.useState<number | null>(null);
  const [tip, setTip] = React.useState<TipState | null>(null);

  // hooks 必须无条件调用;空数据时下方再 return null。
  const n = points.length;
  const innerW = W - PAD_L - PAD_R;
  const innerH = height - PAD_T - PAD_B;
  const maxRaw = Math.max(...points.map((p) => p.value), 1);
  const mag = Math.pow(10, Math.floor(Math.log10(maxRaw)));
  const nn = maxRaw / mag;
  const step = nn <= 1 ? 1 : nn <= 2 ? 2 : nn <= 5 ? 5 : 10;
  const maxV = step * mag;

  const x = (i: number) => PAD_L + (n === 1 ? innerW / 2 : (innerW * i) / (n - 1));
  const y = (v: number) => PAD_T + innerH - (innerH * v) / maxV;
  const uid = React.useId();

  if (!n) return null;

  const linePts = points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ");
  const areaPts = `${PAD_L},${PAD_T + innerH} ${linePts} ${x(n - 1)},${PAD_T + innerH}`;
  const grid = [0, 0.5, 1];

  // 鼠标 x(视口)→ SVG 视图 x → 最近数据点索引。
  const onMove = (e: React.MouseEvent) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W; // 映射到 viewBox 坐标
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(x(i) - vx);
      if (d < bestD) { bestD = d; best = i; }
    }
    setHoverI(best);
    setTip({
      x: e.clientX,
      y: e.clientY,
      title: points[best].label,
      rows: [{ label: t("数值"), value: fmt(points[best].value), color }],
    });
  };

  return (
    <>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        style={{ width: "100%", height }}
        role="img"
        onMouseMove={onMove}
        onMouseLeave={() => { setHoverI(null); setTip(null); }}
      >
        <defs>
          <linearGradient id={`area-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.34} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        {grid.map((f, i) => {
          const gy = PAD_T + innerH - innerH * f;
          return (
            <g key={i}>
              <line x1={PAD_L} y1={gy} x2={W - PAD_R} y2={gy} stroke={GRID} strokeDasharray="3 4" />
              <text x={PAD_L - 6} y={gy + 4} textAnchor="end" fontSize={11} fill={SUBTEXT}>
                {fmt(maxV * f)}
              </text>
            </g>
          );
        })}
        <polygon points={areaPts} fill={`url(#area-${uid})`} />
        <polyline points={linePts} fill="none" stroke={color} strokeWidth={2.5} />
        {/* hover 竖向指示线 */}
        {hoverI != null && (
          <line x1={x(hoverI)} y1={PAD_T} x2={x(hoverI)} y2={PAD_T + innerH} stroke={color} strokeWidth={1} strokeDasharray="4 4" opacity={0.6} />
        )}
        {points.map((p, i) => (
          <circle
            key={i}
            cx={x(i)}
            cy={y(p.value)}
            r={hoverI === i ? 6 : 3.5}
            fill={hoverI === i ? color : DOT_BG}
            stroke={color}
            strokeWidth={2}
            style={{ transition: "r .12s ease, fill .12s ease" }}
          />
        ))}
        {points.map((p, i) => (
          <text key={i} x={x(i)} y={height - PAD_B + 18} textAnchor="middle" fontSize={11} fill={hoverI === i ? color : SUBTEXT} style={{ transition: "fill .12s ease" }}>
            {p.label}
          </text>
        ))}
        {/* 透明捕获层:确保整图任意位置都能触发 onMouseMove(线/点之间的空白也响应) */}
        <rect x={PAD_L} y={PAD_T} width={innerW} height={innerH} fill="transparent" />
      </svg>
      <ChartTooltip tip={tip} />
    </>
  );
}

/** 环形仪表（单一比率 0-100，用于成功率/准点率等 KPI）。自绘 SVG，配色随值分档（红/黄/绿）。
 *  运维大屏用；零依赖，与 Donut/TrendArea 同风格、同换肤 CSS 变量。*/
export function Gauge({
  value,
  label,
  size = 150,
  thickness = 14,
  suffix = "%",
}: {
  value: number; // 0-100
  label?: string;
  size?: number;
  thickness?: number;
  suffix?: string;
}) {
  const v = Math.max(0, Math.min(100, value));
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  // 3/4 圆弧（270°），从左下起顺时针。留缺口更像"仪表盘"。
  const START = 135; // 起始角(度)
  const SWEEP = 270; // 总扫过角度
  const C = 2 * Math.PI * r;
  const arcLen = (SWEEP / 360) * C;
  const filled = (v / 100) * arcLen;
  // 分档配色：<60 红，<85 黄，否则绿。绿走换肤 --bgp-ok;红/黄平台无对应 token,用固定值(与全站失败态一致)。
  const color = v < 60 ? "#f5577a" : v < 85 ? "#e0a23c" : "var(--bgp-ok, #2dd4bf)";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
        {/* 底弧 */}
        <circle
          cx={cx} cy={cy} r={r} fill="none" stroke="rgba(34,211,238,0.10)" strokeWidth={thickness}
          strokeDasharray={`${arcLen} ${C - arcLen}`} strokeDashoffset={0} strokeLinecap="round"
          transform={`rotate(${START} ${cx} ${cy})`}
        />
        {/* 值弧 */}
        <circle
          cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={thickness}
          strokeDasharray={`${filled} ${C - filled}`} strokeDashoffset={0} strokeLinecap="round"
          transform={`rotate(${START} ${cx} ${cy})`}
          style={{ transition: "stroke-dasharray .5s ease, stroke .3s ease" }}
        />
        <text x={cx} y={cy - 2} textAnchor="middle" fontSize={30} fontWeight={700} fill={color}>{Math.round(v)}</text>
        <text x={cx} y={cy + 22} textAnchor="middle" fontSize={13} fill={SUBTEXT}>{suffix}</text>
      </svg>
      {label && <div style={{ color: SUBTEXT, fontSize: 13 }}>{label}</div>}
    </div>
  );
}

export interface GanttRow {
  taskName: string;
  taskType?: string;
  status?: string; // succeeded / failed / running / stopped
  startedAt: string; // ISO
  finishedAt?: string; // ISO；空=进行中(用 now)
  duration?: number; // 秒
}

/** 甘特/时间线（最近运行的起止条）。自绘 SVG，横轴=时间，每行一个 run。hover 显示明细浮层。
 *  运维大屏用；零依赖，颜色按状态。*/
export function GanttTimeline({ rows, rowH = 22 }: { rows: GanttRow[]; rowH?: number }) {
  const t = useT();
  const [tip, setTip] = React.useState<TipState | null>(null);
  if (!rows.length) return null;

  const W = 760;
  const PAD_L = 150; // 左侧任务名列
  const PAD_R = 16;
  const PAD_T = 8;
  const PAD_B = 22;
  const innerW = W - PAD_L - PAD_R;
  const height = PAD_T + rows.length * rowH + PAD_B;

  // 时间范围：所有 run 的最早开始 → 最晚结束(进行中用 now)。
  const nowMs = Date.now();
  const toMs = (s?: string) => (s ? new Date(s).getTime() : nowMs);
  const starts = rows.map((r) => toMs(r.startedAt));
  const ends = rows.map((r) => (r.finishedAt ? toMs(r.finishedAt) : nowMs));
  const minT = Math.min(...starts);
  const maxT = Math.max(...ends, minT + 60000); // 至少 1 分钟跨度,避免除零
  const span = maxT - minT;

  const x = (ms: number) => PAD_L + (innerW * (ms - minT)) / span;
  const statusColor = (s?: string) =>
    s === "succeeded" ? "var(--bgp-ok, #2dd4bf)"
      : s === "failed" ? "#f5577a"
      : s === "running" ? "var(--bgp-running, #22d3ee)"
      : "var(--bgp-stopped, #8fb0c2)";

  const fmtTime = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const fmtDur = (sec?: number) => {
    const s = Number(sec) || 0;
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${(s / 3600).toFixed(1)}h`;
  };

  // 3 条时间刻度
  const ticks = [0, 0.5, 1].map((f) => minT + span * f);

  return (
    <>
      <svg viewBox={`0 0 ${W} ${height}`} style={{ width: "100%", height }} role="img" onMouseLeave={() => setTip(null)}>
        {ticks.map((tk, i) => (
          <g key={i}>
            <line x1={x(tk)} y1={PAD_T} x2={x(tk)} y2={PAD_T + rows.length * rowH} stroke={GRID} strokeDasharray="3 4" />
            <text x={x(tk)} y={height - 6} textAnchor="middle" fontSize={10} fill={SUBTEXT}>{fmtTime(tk)}</text>
          </g>
        ))}
        {rows.map((r, i) => {
          const y = PAD_T + i * rowH + 3;
          const bx = x(toMs(r.startedAt));
          const ex = x(r.finishedAt ? toMs(r.finishedAt) : nowMs);
          const bw = Math.max(ex - bx, 3); // 至少 3px 可见
          const color = statusColor(r.status);
          const showTip = (e: React.MouseEvent) =>
            setTip({
              x: e.clientX, y: e.clientY, title: r.taskName,
              rows: [
                { label: t("状态"), value: r.status || "-", color },
                { label: t("开始"), value: fmtTime(toMs(r.startedAt)) },
                { label: t("时长"), value: fmtDur(r.duration) },
              ],
            });
          return (
            <g key={i} style={{ cursor: "pointer" }} onMouseEnter={showTip} onMouseMove={showTip}>
              <text x={PAD_L - 8} y={y + rowH / 2} textAnchor="end" fontSize={11} fill={SUBTEXT} dominantBaseline="middle">
                {r.taskName.length > 20 ? r.taskName.slice(0, 19) + "…" : r.taskName}
              </text>
              <rect x={bx} y={y} width={bw} height={rowH - 8} rx={3} fill={color} opacity={0.85} />
              {r.status === "running" && <rect x={bx} y={y} width={bw} height={rowH - 8} rx={3} fill="none" stroke={color} strokeWidth={1}>
                <animate attributeName="opacity" values="0.4;1;0.4" dur="1.5s" repeatCount="indefinite" />
              </rect>}
            </g>
          );
        })}
      </svg>
      <ChartTooltip tip={tip} />
    </>
  );
}

/** 横向条形列表（分类计数）。hover 行提亮加描边。 */
export function BarList({ data }: { data: Slice[] }) {
  const t = useT();
  const [active, setActive] = React.useState<number | null>(null);
  const [tip, setTip] = React.useState<TipState | null>(null);
  const max = Math.max(...data.map((d) => d.value), 1);
  const total = data.reduce((s, d) => s + (d.value || 0), 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {data.map((d, i) => {
        const isActive = active === i;
        return (
          <div
            key={i}
            style={{ cursor: "pointer", opacity: active != null && !isActive ? 0.55 : 1, transition: "opacity .18s ease" }}
            onMouseEnter={(e) => {
              setActive(i);
              setTip({
                x: e.clientX,
                y: e.clientY,
                title: d.label,
                rows: [{ label: t("数量"), value: `${fmt(d.value)}${total > 0 ? ` (${Math.round((d.value / total) * 100)}%)` : ""}`, color: d.color }],
              });
            }}
            onMouseMove={(e) => setTip((prev) => (prev ? { ...prev, x: e.clientX, y: e.clientY } : prev))}
            onMouseLeave={() => { setActive(null); setTip(null); }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 5 }}>
              <span style={{ color: isActive ? TEXT : SUBTEXT, transition: "color .18s ease" }}>{d.label}</span>
              <span style={{ color: TEXT, fontWeight: 600 }}>{fmt(d.value)}</span>
            </div>
            <div style={{ height: 9, borderRadius: 6, background: "rgba(34,211,238,0.08)", overflow: "hidden", outline: isActive ? `1px solid ${d.color}` : "none", outlineOffset: 1, transition: "outline-color .18s ease" }}>
              <div
                style={{
                  width: `${(d.value / max) * 100}%`,
                  height: "100%",
                  borderRadius: 6,
                  background: `linear-gradient(90deg, ${d.color}, ${d.color}cc)`,
                  boxShadow: isActive ? `0 0 14px ${d.color}` : `0 0 8px ${d.color}66`,
                  transition: "width .4s ease, box-shadow .18s ease",
                }}
              />
            </div>
          </div>
        );
      })}
      <ChartTooltip tip={tip} />
    </div>
  );
}

// ── — BI 报表搭建器新增图表(换肤纵向柱状图 + 数字指标卡)──────────────
// 沿用本文件范式:零依赖 SVG + var(--bgp-*) 换肤 + ChartTooltip hover。取代旧的 MiniChart
// (硬编码 #1677ff 不换肤),分类色走已过校验的 --bgp-s1..s4。

/** 纵向柱状图(单序列)。y 轴刻度网格 + hover 柱高亮+浮层。换肤自动跟随。 */
export function BarChart({
  labels,
  values,
  height = 260,
  valueLabel,
}: {
  labels: string[];
  values: number[];
  height?: number;
  valueLabel?: string; // 浮层里度量名(默认"数值")
}) {
  const t = useT();
  const [active, setActive] = React.useState<number | null>(null);
  const [tip, setTip] = React.useState<TipState | null>(null);
  if (!labels.length || !values.length) return null;

  const W = 720;
  const PAD_L = 52;
  const PAD_R = 16;
  const PAD_T = 16;
  const PAD_B = 60;
  const H = height;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const rawMax = Math.max(...values, 0);
  const maxV = niceCeil(rawMax);
  const n = values.length;

  const x = (i: number) => PAD_L + (innerW * (i + 0.5)) / n;
  const y = (v: number) => PAD_T + innerH - (innerH * v) / maxV;
  const bw = Math.max(6, (innerW / n) * 0.6);
  const grid = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: H }}
        role="img"
        onMouseLeave={() => { setActive(null); setTip(null); }}
      >
        {/* 网格 + y 轴刻度 */}
        {grid.map((f, i) => {
          const gy = PAD_T + innerH - innerH * f;
          return (
            <g key={i}>
              <line x1={PAD_L} y1={gy} x2={W - PAD_R} y2={gy} stroke={GRID} />
              <text x={PAD_L - 8} y={gy + 4} textAnchor="end" fontSize={11} fill={SUBTEXT}>
                {fmt(maxV * f)}
              </text>
            </g>
          );
        })}
        {/* 柱 */}
        {values.map((v, i) => {
          const isActive = active === i;
          const by = y(Math.max(v, 0));
          const bh = Math.max(PAD_T + innerH - by, 0);
          const showTip = (e: React.MouseEvent) =>
            setTip({ x: e.clientX, y: e.clientY, title: String(labels[i]), rows: [{ label: valueLabel || t("数值"), value: fmt(v), color: PRIMARY }] });
          return (
            <rect
              key={i}
              x={x(i) - bw / 2}
              y={by}
              width={bw}
              height={bh}
              rx={2}
              fill="var(--bgp-s1, #3d8bfd)"
              opacity={active != null && !isActive ? 0.4 : 1}
              style={{ transition: "opacity .18s ease", cursor: "pointer" }}
              onMouseEnter={(e) => { setActive(i); showTip(e); }}
              onMouseMove={showTip}
            />
          );
        })}
        {/* x 轴标签(旋转防重叠) */}
        {labels.map((l, i) => (
          <text
            key={i}
            x={x(i)}
            y={H - PAD_B + 18}
            textAnchor="end"
            fontSize={11}
            fill={SUBTEXT}
            transform={`rotate(-30 ${x(i)} ${H - PAD_B + 18})`}
          >
            {trunc(String(l))}
          </text>
        ))}
      </svg>
      <ChartTooltip tip={tip} />
    </div>
  );
}

/** 数字指标卡(KPI)。大数字 + 标题 + 可选副标题。换肤走 --bgp-*。 */
export function MetricCard({
  value,
  label,
  sub,
}: {
  value: string | number;
  label?: string;
  sub?: string;
}) {
  const display = typeof value === "number" ? fmt(value) : value;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        minHeight: 120,
        padding: "18px 12px",
      }}
    >
      <div style={{ fontSize: 40, fontWeight: 700, color: PRIMARY, lineHeight: 1.1, wordBreak: "break-all", textAlign: "center" }}>
        {display}
      </div>
      {label && <div style={{ fontSize: 14, color: SUBTEXT, textAlign: "center" }}>{label}</div>}
      {sub && <div style={{ fontSize: 12, color: SUBTEXT, opacity: 0.8, textAlign: "center" }}>{sub}</div>}
    </div>
  );
}

// 柱状图 x 标签截断(避免过长)。
function trunc(s: string, n = 10): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// 把最大值向上取整到"漂亮"刻度(1/2/5×10^k),让 y 轴刻度好看。
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const nn = v / mag;
  const step = nn <= 1 ? 1 : nn <= 2 ? 2 : nn <= 5 ? 5 : 10;
  return step * mag;
}
