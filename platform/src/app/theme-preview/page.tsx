"use client";

// 皮肤预览页(独立路由,不影响现有主题)——「赛博霓虹」双色调方案候选。
// 现皮肤=青蓝单色阶梯;本方案=深紫黑底 + 青/品红双霓虹 + 渐变描边 + 辉光动效。
// 图表系列色 #00A3C4/#D13BA0/#8B6FE8/#B8871A 经 dataviz 六检验证(暗底全过,CVD ΔE 16.1)。
// 用户过目满意后,再把 token 落进 lib/theme.ts 全站生效;不满意可直接删本目录。
import React, { useState } from "react";

const S = {
  bg: "#05040f",
  panel: "rgba(13, 12, 32, 0.72)",
  panelSolid: "#0d0c20",
  cyan: "#00e5ff",
  magenta: "#ff4dd2",
  violet: "#a78bfa",
  text: "#e8f1ff",
  textDim: "#93a7c4",
  grid: "rgba(147, 167, 196, 0.12)",
  // 图表系列色(已验证:亮度带/色度/CVD/对比度全过)
  s1: "#00A3C4", s2: "#D13BA0", s3: "#8B6FE8", s4: "#B8871A",
} as const;

// —— 演示数据(静态,取平台真实业务口径) ——
const syncTrend = {
  labels: ["06-26", "06-27", "06-28", "06-29", "06-30", "07-01", "07-02"],
  glue: [42, 48, 45, 61, 58, 72, 86],
  dms: [18, 22, 30, 28, 35, 33, 41],
};
const jobBars = [
  { name: "订单入湖", v: 128 }, { name: "汇率同步", v: 96 }, { name: "SKU 维表", v: 74 },
  { name: "GMV 汇总", v: 62 }, { name: "质量稽核", v: 45 },
];
const tableRows = [
  { name: "ecom-lake-base-0702", type: "Glue 批同步", status: "succeeded", rows: "299,778", dur: "6.2 min" },
  { name: "parity-sync-dms-0702", type: "DMS 实时", status: "stopped", rows: "100,000", dur: "—" },
  { name: "parity-flink-0702", type: "Flink CDC", status: "ready", rows: "实时流", dur: "—" },
  { name: "parity-wf-0702", type: "workflow", status: "succeeded", rows: "3 节点", dur: "9.8 min" },
];

// 折线图坐标计算(SVG viewBox 0 0 560 220,绘图区 40,10 → 545,185)
function linePath(vals: number[], max: number): string {
  const x0 = 40, x1 = 545, y0 = 185, y1 = 10;
  return vals.map((v, i) => {
    const x = x0 + (i * (x1 - x0)) / (vals.length - 1);
    const y = y0 - (v / max) * (y0 - y1);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function Kpi({ label, value, delta, color }: { label: string; value: string; delta: string; color: string }) {
  return (
    <div className="tp-kpi" style={{ ["--glow" as any]: color }}>
      <div style={{ fontSize: 12, color: S.textDim, letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 700, color: S.text, margin: "6px 0 2px", fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: 12, color }}>{delta}</div>
    </div>
  );
}

const statusColor: Record<string, string> = { succeeded: "#2dd4a7", stopped: S.textDim, ready: S.cyan };

export default function ThemePreviewPage() {
  const [tab, setTab] = useState<"overview" | "table">("overview");
  const max = 100;
  const pts = (vals: number[]) => vals.map((v, i) => ({
    x: 40 + (i * 505) / (vals.length - 1), y: 185 - (v / max) * 175, v,
  }));

  return (
    <div className="tp-root">
      <style>{`
        .tp-root {
          margin: -24px; padding: 24px; min-height: calc(100vh - 64px);
          background:
            radial-gradient(900px 420px at 85% -10%, rgba(255, 77, 210, 0.14), transparent 60%),
            radial-gradient(800px 400px at -5% 20%, rgba(0, 229, 255, 0.12), transparent 55%),
            radial-gradient(700px 500px at 50% 115%, rgba(139, 111, 232, 0.10), transparent 60%),
            ${S.bg};
          color: ${S.text};
          font-variant-numeric: tabular-nums;
          position: relative; overflow: hidden;
        }
        /* 背景网格(HUD 感) */
        .tp-root::before {
          content: ""; position: absolute; inset: 0; pointer-events: none;
          background-image:
            linear-gradient(rgba(0,229,255,0.045) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0,229,255,0.045) 1px, transparent 1px);
          background-size: 44px 44px;
          mask-image: radial-gradient(1200px 700px at 50% 0%, #000 30%, transparent 85%);
        }
        /* 扫描光带 */
        .tp-root::after {
          content: ""; position: absolute; left: 0; right: 0; height: 120px; top: -120px;
          background: linear-gradient(180deg, transparent, rgba(0,229,255,0.05), transparent);
          animation: tp-scan 7s linear infinite; pointer-events: none;
        }
        @keyframes tp-scan { to { transform: translateY(calc(100vh + 240px)); } }

        /* 渐变描边面板:双层背景实现 1px 青→品红渐变边框 + 玻璃拟态 */
        .tp-panel {
          position: relative; border-radius: 14px; padding: 18px;
          background:
            linear-gradient(${S.panel}, ${S.panel}) padding-box,
            linear-gradient(135deg, rgba(0,229,255,0.55), rgba(139,111,232,0.25) 45%, rgba(255,77,210,0.55)) border-box;
          border: 1px solid transparent;
          backdrop-filter: blur(10px);
          box-shadow: 0 0 32px rgba(0, 229, 255, 0.06), 0 0 60px rgba(255, 77, 210, 0.05), inset 0 1px 0 rgba(255,255,255,0.04);
        }
        .tp-kpi {
          flex: 1; min-width: 180px; border-radius: 12px; padding: 14px 16px; position: relative; overflow: hidden;
          background: linear-gradient(rgba(13,12,32,0.8), rgba(13,12,32,0.8)) padding-box,
            linear-gradient(135deg, var(--glow), transparent 55%) border-box;
          border: 1px solid transparent;
          transition: transform .2s, box-shadow .2s;
        }
        .tp-kpi::after {
          content: ""; position: absolute; left: 0; right: 0; top: 0; height: 2px;
          background: linear-gradient(90deg, transparent, var(--glow), transparent);
          animation: tp-pulse 2.6s ease-in-out infinite;
        }
        .tp-kpi:hover { transform: translateY(-2px); box-shadow: 0 6px 24px rgba(0,229,255,0.15); }
        @keyframes tp-pulse { 0%,100% { opacity: .35; } 50% { opacity: 1; } }

        .tp-title {
          font-size: 20px; font-weight: 700; letter-spacing: 2px;
          background: linear-gradient(90deg, ${S.cyan}, ${S.violet} 55%, ${S.magenta});
          -webkit-background-clip: text; background-clip: text; color: transparent;
          text-shadow: 0 0 24px rgba(0,229,255,0.25);
        }
        .tp-chip {
          display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: ${S.textDim};
          border: 1px solid rgba(0,229,255,0.35); border-radius: 999px; padding: 3px 10px;
          background: rgba(0,229,255,0.07);
        }
        .tp-dot { width: 6px; height: 6px; border-radius: 50%; background: #2dd4a7; box-shadow: 0 0 8px #2dd4a7; }

        .tp-btn {
          cursor: pointer; font-size: 13px; color: ${S.text}; border-radius: 8px; padding: 6px 16px;
          border: 1px solid rgba(0,229,255,0.4); background: rgba(0,229,255,0.08); transition: all .2s;
        }
        .tp-btn:hover { background: rgba(0,229,255,0.18); box-shadow: 0 0 16px rgba(0,229,255,0.35); }
        .tp-btn.primary {
          border: none; color: #041018; font-weight: 600;
          background: linear-gradient(90deg, ${S.cyan}, #7ae7ff);
          box-shadow: 0 0 18px rgba(0,229,255,0.45);
        }
        .tp-btn.primary:hover { box-shadow: 0 0 28px rgba(0,229,255,0.7); }
        .tp-btn.magenta { border-color: rgba(255,77,210,0.45); background: rgba(255,77,210,0.1); }
        .tp-btn.magenta:hover { background: rgba(255,77,210,0.2); box-shadow: 0 0 16px rgba(255,77,210,0.4); }

        .tp-tab { cursor: pointer; padding: 6px 18px; font-size: 13px; color: ${S.textDim}; border-radius: 8px 8px 0 0; border: 1px solid transparent; border-bottom: none; }
        .tp-tab.on {
          color: ${S.cyan}; background: rgba(0,229,255,0.08);
          border-image: linear-gradient(90deg, rgba(0,229,255,.6), rgba(255,77,210,.6)) 1;
          text-shadow: 0 0 12px rgba(0,229,255,0.5);
        }

        .tp-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .tp-table th { text-align: left; color: ${S.textDim}; font-weight: 500; padding: 8px 12px; border-bottom: 1px solid rgba(0,229,255,0.25); background: rgba(0,229,255,0.05); }
        .tp-table td { padding: 9px 12px; border-bottom: 1px solid ${S.grid}; color: ${S.text}; }
        .tp-table tbody tr { transition: background .15s, box-shadow .15s; }
        .tp-table tbody tr:hover { background: linear-gradient(90deg, rgba(0,229,255,0.08), rgba(255,77,210,0.06)); box-shadow: inset 2px 0 0 ${S.cyan}; }

        .tp-bar-rect { transition: filter .15s; }
        .tp-bar-rect:hover { filter: brightness(1.35) drop-shadow(0 0 6px rgba(0,229,255,0.6)); }
      `}</style>

      {/* 顶栏 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18, position: "relative" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div className="tp-title">◢ BGP · NEON 皮肤预览</div>
          <span className="tp-chip"><span className="tp-dot" />全链路正常</span>
          <span className="tp-chip" style={{ borderColor: "rgba(255,77,210,0.4)", background: "rgba(255,77,210,0.07)" }}>账号 0284****7255</span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="tp-btn">刷新</button>
          <button className="tp-btn magenta">AI 诊断</button>
          <button className="tp-btn primary">新建任务</button>
        </div>
      </div>

      {/* KPI 瓷贴 */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 16, position: "relative" }}>
        <Kpi label="今日同步行数" value="399,778" delta="▲ 12.4% vs 昨日" color={S.cyan} />
        <Kpi label="运行中任务" value="7" delta="Glue 4 · DMS 2 · Flink 1" color={S.violet} />
        <Kpi label="数据质量分" value="96.8" delta="▲ 0.6 本周" color={S.magenta} />
        <Kpi label="MWAA 调度成功率" value="99.2%" delta="近 7 天 128 次" color="#2dd4a7" />
      </div>

      {/* 页签 */}
      <div style={{ display: "flex", gap: 4, marginBottom: 0, position: "relative" }}>
        <div className={`tp-tab ${tab === "overview" ? "on" : ""}`} onClick={() => setTab("overview")}>运行总览</div>
        <div className={`tp-tab ${tab === "table" ? "on" : ""}`} onClick={() => setTab("table")}>任务明细</div>
      </div>

      {tab === "overview" ? (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", position: "relative" }}>
          {/* 折线:同步吞吐趋势 */}
          <div className="tp-panel" style={{ flex: "1 1 520px", minWidth: 480 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ fontSize: 14, color: S.text }}>同步吞吐趋势(万行/日)</div>
              <div style={{ display: "flex", gap: 14, fontSize: 12, color: S.textDim }}>
                <span><span style={{ display: "inline-block", width: 10, height: 3, background: S.s1, borderRadius: 2, marginRight: 5, verticalAlign: "middle" }} />Glue 批同步</span>
                <span><span style={{ display: "inline-block", width: 10, height: 3, background: S.s2, borderRadius: 2, marginRight: 5, verticalAlign: "middle" }} />DMS 实时</span>
              </div>
            </div>
            <svg viewBox="0 0 560 220" style={{ width: "100%", height: "auto" }}>
              <defs>
                <linearGradient id="tpFillG" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={S.s1} stopOpacity="0.28" /><stop offset="100%" stopColor={S.s1} stopOpacity="0" />
                </linearGradient>
              </defs>
              {[0, 25, 50, 75, 100].map((g) => {
                const y = 185 - (g / max) * 175;
                return (
                  <g key={g}>
                    <line x1="40" x2="545" y1={y} y2={y} stroke={S.grid} strokeWidth="1" />
                    <text x="34" y={y + 4} fontSize="10" fill={S.textDim} textAnchor="end">{g}</text>
                  </g>
                );
              })}
              {syncTrend.labels.map((l, i) => (
                <text key={l} x={40 + (i * 505) / 6} y="205" fontSize="10" fill={S.textDim} textAnchor="middle">{l}</text>
              ))}
              <path d={`${linePath(syncTrend.glue, max)} L545,185 L40,185 Z`} fill="url(#tpFillG)" />
              <path d={linePath(syncTrend.glue, max)} fill="none" stroke={S.s1} strokeWidth="2" style={{ filter: `drop-shadow(0 0 4px ${S.s1})` }} />
              <path d={linePath(syncTrend.dms, max)} fill="none" stroke={S.s2} strokeWidth="2" style={{ filter: `drop-shadow(0 0 4px ${S.s2})` }} />
              {pts(syncTrend.glue).map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r="3.5" fill={S.s1} stroke={S.bg} strokeWidth="2"><title>{`Glue ${syncTrend.labels[i]}:${p.v} 万行`}</title></circle>
              ))}
              {pts(syncTrend.dms).map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r="3.5" fill={S.s2} stroke={S.bg} strokeWidth="2"><title>{`DMS ${syncTrend.labels[i]}:${p.v} 万行`}</title></circle>
              ))}
              {/* 末点直标 */}
              <text x="548" y={185 - (syncTrend.glue[6] / max) * 175 + 4} fontSize="11" fill={S.s1} fontWeight="600">86</text>
              <text x="548" y={185 - (syncTrend.dms[6] / max) * 175 + 4} fontSize="11" fill={S.s2} fontWeight="600">41</text>
            </svg>
          </div>

          {/* 柱状:作业运行次数 Top5 */}
          <div className="tp-panel" style={{ flex: "1 1 380px", minWidth: 360 }}>
            <div style={{ fontSize: 14, marginBottom: 8 }}>作业运行次数 Top 5(近 7 天)</div>
            <svg viewBox="0 0 420 220" style={{ width: "100%", height: "auto" }}>
              <defs>
                <linearGradient id="tpBar" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor={S.s1} /><stop offset="100%" stopColor={S.s3} />
                </linearGradient>
              </defs>
              {jobBars.map((b, i) => {
                const y = 14 + i * 40;
                const w = (b.v / 128) * 280;
                return (
                  <g key={b.name}>
                    <text x="86" y={y + 13} fontSize="11" fill={S.textDim} textAnchor="end">{b.name}</text>
                    <rect className="tp-bar-rect" x="92" y={y} width={w} height="18" rx="4" fill="url(#tpBar)">
                      <title>{`${b.name}:${b.v} 次`}</title>
                    </rect>
                    <text x={96 + w} y={y + 13} fontSize="11" fill={S.text} fontWeight="600">{b.v}</text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
      ) : (
        <div className="tp-panel" style={{ position: "relative" }}>
          <table className="tp-table">
            <thead><tr><th>任务名</th><th>通道</th><th>状态</th><th>数据量</th><th>耗时</th></tr></thead>
            <tbody>
              {tableRows.map((r) => (
                <tr key={r.name}>
                  <td style={{ color: S.cyan }}>{r.name}</td>
                  <td>{r.type}</td>
                  <td><span style={{ color: statusColor[r.status] || S.text }}>● {r.status}</span></td>
                  <td>{r.rows}</td>
                  <td>{r.dur}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 16, fontSize: 12, color: S.textDim, position: "relative" }}>
        ◢ 预览说明:本页为「赛博霓虹」皮肤候选(深紫黑底 + 青/品红双霓虹 + 渐变描边 + 网格/扫描线/辉光动效)。
        图表系列色已过可访问性六项检验(色觉障碍 ΔE 16.1)。满意后可将 token 应用到全站主题。
      </div>
    </div>
  );
}
