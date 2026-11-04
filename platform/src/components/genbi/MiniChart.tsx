"use client";

import React from "react";

// Minimal dependency-free SVG chart (bar / line) for GenBI results. Kept intentionally
// small — no charting library — to avoid extra deps and version conflicts with antd v6.

interface MiniChartProps {
  type: "bar" | "line";
  labels: string[];
  values: number[];
  height?: number;
}

const W = 720;
const PAD_L = 48;
const PAD_R = 16;
const PAD_T = 16;
const PAD_B = 56;
const COLOR = "#1677ff";

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

function fmt(v: number): string {
  if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + "亿";
  if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(2) + "万";
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function trunc(s: string, n = 10): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export default function MiniChart({ type, labels, values, height = 280 }: MiniChartProps) {
  if (!labels.length || !values.length) return null;

  const H = height;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const maxV = niceMax(Math.max(...values, 0));
  const n = values.length;

  const x = (i: number) => PAD_L + (innerW * (i + 0.5)) / n;
  const y = (v: number) => PAD_T + innerH - (innerH * v) / maxV;

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const gv = maxV * f;
    const gy = PAD_T + innerH - innerH * f;
    return { gy, label: fmt(gv) };
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H }} role="img">
      {/* gridlines + y labels */}
      {gridLines.map((g, i) => (
        <g key={i}>
          <line x1={PAD_L} y1={g.gy} x2={W - PAD_R} y2={g.gy} stroke="#1d4254" />
          <text x={PAD_L - 6} y={g.gy + 4} textAnchor="end" fontSize={11} fill="#999">
            {g.label}
          </text>
        </g>
      ))}

      {/* bars */}
      {type === "bar" &&
        values.map((v, i) => {
          const bw = Math.max(6, (innerW / n) * 0.6);
          const bx = x(i) - bw / 2;
          const by = y(Math.max(v, 0));
          const bh = PAD_T + innerH - by;
          return <rect key={i} x={bx} y={by} width={bw} height={Math.max(bh, 0)} fill={COLOR} rx={2} />;
        })}

      {/* line */}
      {type === "line" && (
        <>
          <polyline
            fill="none"
            stroke={COLOR}
            strokeWidth={2}
            points={values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
          />
          {values.map((v, i) => (
            <circle key={i} cx={x(i)} cy={y(v)} r={3} fill={COLOR} />
          ))}
        </>
      )}

      {/* x labels */}
      {labels.map((l, i) => (
        <text
          key={i}
          x={x(i)}
          y={H - PAD_B + 18}
          textAnchor="end"
          fontSize={11}
          fill="#666"
          transform={`rotate(-30 ${x(i)} ${H - PAD_B + 18})`}
        >
          {trunc(String(l))}
        </text>
      ))}
    </svg>
  );
}
