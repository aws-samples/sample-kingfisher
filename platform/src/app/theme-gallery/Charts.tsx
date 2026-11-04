"use client";

// 纯 SVG 图表基元(折线/柱状/环形)—— 颜色全部走 CSS 变量(--s1..--s4/--grid/--text-dim),
// 故同一套图表被任意主题的变量重新着色。图表配直标 + 间隙作二级编码(dataviz CVD floor 规则)。
import React from "react";
import { SYNC_TREND, JOB_BARS, STATUS_DONUT } from "./demo";

const MAX = 100;

// 绘图区 x: 40 → 522(右侧留 38px 给末点直标,避免被面板裁掉)
const PX0 = 40, PX1 = 522, PY0 = 175, PY1 = 12, PH = PY0 - PY1;
function linePath(vals: number[]): string {
  return vals
    .map((v, i) => {
      const x = PX0 + (i * (PX1 - PX0)) / (vals.length - 1);
      const y = PY0 - (v / MAX) * PH;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
function pts(vals: number[]) {
  return vals.map((v, i) => ({
    x: PX0 + (i * (PX1 - PX0)) / (vals.length - 1),
    y: PY0 - (v / MAX) * PH,
    v,
  }));
}

// —— 折线:同步吞吐趋势(两系列,末点直标 + 圆点带描边间隙) ——
export function LineChart() {
  const gid = React.useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 560 210" style={{ width: "100%", height: "auto" }} role="img" aria-label="同步吞吐趋势折线图">
      <defs>
        <linearGradient id={`fill${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--s1)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--s1)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 25, 50, 75, 100].map((g) => {
        const y = PY0 - (g / MAX) * PH;
        return (
          <g key={g}>
            <line x1={PX0} x2={PX1} y1={y} y2={y} stroke="var(--grid)" strokeWidth="1" />
            <text x={PX0 - 6} y={y + 4} fontSize="10" fill="var(--text-dim)" textAnchor="end">{g}</text>
          </g>
        );
      })}
      {SYNC_TREND.labels.map((l, i) => (
        <text key={l} x={PX0 + (i * (PX1 - PX0)) / 6} y="198" fontSize="10" fill="var(--text-dim)" textAnchor="middle">{l}</text>
      ))}
      <path d={`${linePath(SYNC_TREND.glue)} L${PX1},${PY0} L${PX0},${PY0} Z`} fill={`url(#fill${gid})`} />
      <path d={linePath(SYNC_TREND.glue)} fill="none" stroke="var(--s1)" strokeWidth="2" className="tg-line" />
      <path d={linePath(SYNC_TREND.dms)} fill="none" stroke="var(--s2)" strokeWidth="2" className="tg-line" />
      {pts(SYNC_TREND.glue).map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3.4" fill="var(--s1)" stroke="var(--panel-solid)" strokeWidth="2">
          <title>{`Glue ${SYNC_TREND.labels[i]}:${p.v} 万行`}</title>
        </circle>
      ))}
      {pts(SYNC_TREND.dms).map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3.4" fill="var(--s2)" stroke="var(--panel-solid)" strokeWidth="2">
          <title>{`DMS ${SYNC_TREND.labels[i]}:${p.v} 万行`}</title>
        </circle>
      ))}
      <text x={PX1 + 6} y={PY0 - (SYNC_TREND.glue[6] / MAX) * PH + 4} fontSize="11" fill="var(--s1)" fontWeight="700">86</text>
      <text x={PX1 + 6} y={PY0 - (SYNC_TREND.dms[6] / MAX) * PH + 4} fontSize="11" fill="var(--s2)" fontWeight="700">41</text>
    </svg>
  );
}

// —— 柱状:作业运行次数 Top5(横向,值直标) ——
export function BarChart() {
  const gid = React.useId().replace(/:/g, "");
  const maxV = 128;
  return (
    <svg viewBox="0 0 420 210" style={{ width: "100%", height: "auto" }} role="img" aria-label="作业运行次数柱状图">
      <defs>
        <linearGradient id={`bar${gid}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--s1)" />
          <stop offset="100%" stopColor="var(--s3)" />
        </linearGradient>
      </defs>
      {JOB_BARS.map((b, i) => {
        const y = 12 + i * 39;
        const w = (b.v / maxV) * 260;
        return (
          <g key={b.name}>
            <text x="86" y={y + 13} fontSize="11" fill="var(--text-dim)" textAnchor="end">{b.name}</text>
            <rect x="92" y={y} width={w} height="18" rx="4" fill={`url(#bar${gid})`} className="tg-bar">
              <title>{`${b.name}:${b.v} 次`}</title>
            </rect>
            <text x={98 + w} y={y + 13} fontSize="11" fill="var(--text)" fontWeight="600">{b.v}</text>
          </g>
        );
      })}
    </svg>
  );
}

// —— 环形:任务状态分布(4 段,段间 2px 间隙作二级编码 + 中心汇总 + 图例) ——
export function DonutChart() {
  const total = STATUS_DONUT.reduce((s, d) => s + d.v, 0);
  const R = 62, r = 40, cx = 80, cy = 80, C = 2 * Math.PI * ((R + r) / 2), sw = R - r;
  const colorVar: Record<string, string> = { ok: "var(--ok)", running: "var(--running)", stopped: "var(--stopped)", queue: "var(--s3)" };
  let offset = 0;
  const gapFrac = 0.012; // 段间间隙(周长占比)
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
      <svg viewBox="0 0 160 160" width="150" height="150" role="img" aria-label="任务状态分布环形图">
        <circle cx={cx} cy={cy} r={(R + r) / 2} fill="none" stroke="var(--grid)" strokeWidth={sw} opacity="0.4" />
        {STATUS_DONUT.map((d) => {
          const frac = d.v / total;
          const len = Math.max(0, (frac - gapFrac) * C);
          const dash = `${len} ${C - len}`;
          const el = (
            <circle
              key={d.key}
              cx={cx}
              cy={cy}
              r={(R + r) / 2}
              fill="none"
              stroke={colorVar[d.key]}
              strokeWidth={sw}
              strokeDasharray={dash}
              strokeDashoffset={-offset * C}
              strokeLinecap="butt"
              transform={`rotate(-90 ${cx} ${cy})`}
              className="tg-arc"
            >
              <title>{`${d.name}:${d.v}(${(frac * 100).toFixed(0)}%)`}</title>
            </circle>
          );
          offset += frac;
          return el;
        })}
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize="26" fontWeight="700" fill="var(--text)">{total}</text>
        <text x={cx} y={cy + 15} textAnchor="middle" fontSize="10" fill="var(--text-dim)">任务总数</text>
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {STATUS_DONUT.map((d) => (
          <div key={d.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-dim)" }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: colorVar[d.key], display: "inline-block" }} />
            <span style={{ color: "var(--text)", minWidth: 42 }}>{d.name}</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{d.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
