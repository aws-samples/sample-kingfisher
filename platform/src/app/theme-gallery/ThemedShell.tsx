"use client";

// ThemedShell —— 吃一份 Theme token,渲染「整站换成该皮肤后的样子」:
// 左侧导航 + 顶栏 + 仪表盘(KPI 瓷贴 / 折线 / 环形 / 柱状 / 任务表 / GenBI 执行链路)。
//
// 关键手法:所有主题差异都注入到根节点的 CSS 自定义属性(--bg/--panel/--primary/--s1…),
// 组件与样式全部按「角色变量」书写 —— 这正是将来「点击切换主题、全站生效」的落地方式
// (把选中主题的 token 挂到 <html> 变量上即可)。本模块为纯静态预览,零耦合共享代码。

import React from "react";
import type { Theme } from "./themes";
import { LineChart, BarChart, DonutChart } from "./Charts";
import { TASK_ROWS, GENBI_TRACE } from "./demo";

// 主题 token → CSS 变量表
function themeVars(t: Theme): React.CSSProperties {
  const panelSolid = t.panel.startsWith("rgba") ? t.bg : t.panel;
  return {
    ["--bg" as any]: t.bg,
    ["--bg-layers" as any]: t.bgLayers,
    ["--panel" as any]: t.panel,
    ["--panel-solid" as any]: panelSolid,
    ["--panel-border" as any]: t.panelBorder,
    ["--panel-shadow" as any]: t.panelShadow,
    ["--radius" as any]: `${t.radius}px`,
    ["--text" as any]: t.text,
    ["--text-dim" as any]: t.textDim,
    ["--primary" as any]: t.primary,
    ["--primary-bright" as any]: t.primaryBright,
    ["--accent" as any]: t.accent,
    ["--gradient" as any]: t.gradient,
    ["--glow" as any]: t.glow,
    ["--sider-bg" as any]: t.siderBg,
    ["--sider-active-bg" as any]: t.siderActiveBg,
    ["--sider-active-text" as any]: t.siderActiveText,
    ["--s1" as any]: t.series.s1,
    ["--s2" as any]: t.series.s2,
    ["--s3" as any]: t.series.s3,
    ["--s4" as any]: t.series.s4,
    ["--grid" as any]: t.grid,
    ["--ok" as any]: t.ok,
    ["--running" as any]: t.running,
    ["--stopped" as any]: t.stopped,
    ["--font" as any]: t.mono
      ? "'JetBrains Mono','Fira Code',ui-monospace,SFMono-Regular,Menlo,monospace"
      : "system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif",
  } as React.CSSProperties;
}

const NAV = [
  { g: "数据集成", items: ["数据源管理", "数据同步"] },
  { g: "数据开发", items: ["作业开发", "ETL 编排", "实时计算", "数据服务"] },
  { g: "智能分析", items: ["智能问数", "指标中台"] },
  { g: "数据治理", items: ["数据治理", "数据建模", "治理中心"] },
  { g: "调度运维", items: ["调度管理", "任务监控", "可观测看板"] },
];

const STATUS_VAR: Record<string, string> = { 成功: "var(--ok)", 运行中: "var(--running)", 已停止: "var(--stopped)" };

const KPIS = [
  { label: "今日同步行数", value: "399,778", delta: "▲ 12.4% vs 昨日", tone: "s1" },
  { label: "运行中任务", value: "34", delta: "Glue 4 · DMS 2 · Flink 1", tone: "s3" },
  { label: "数据质量分", value: "96.8", delta: "▲ 0.6 本周", tone: "s2" },
  { label: "调度成功率", value: "99.2%", delta: "近 7 天 128 次", tone: "ok" },
];

interface Props {
  theme: Theme;
  /** 沉浸模式:铺满(全屏预览页用);否则等比缩放贴进卡片(目录页缩略图用) */
  variant?: "full" | "thumb";
}

export default function ThemedShell({ theme, variant = "full" }: Props) {
  const active = "数据同步";
  const cls = `tg-shell motif-${theme.motif} panel-${theme.panelStyle} ${theme.mode === "light" ? "is-light" : "is-dark"} ${variant === "thumb" ? "is-thumb" : ""}`;

  return (
    <div className={cls} style={themeVars(theme)}>
      <ShellStyles />
      <div className="tg-bg-motif" aria-hidden />

      {/* —— 侧栏 —— */}
      <aside className="tg-sider">
        <div className="tg-logo">
          <span className="tg-logo-mark">◢</span>
          <span className="tg-logo-text">Kingfisher</span>
        </div>
        <nav className="tg-nav">
          <div className="tg-nav-home">⌂ 首页</div>
          {NAV.map((grp) => (
            <div key={grp.g} className="tg-nav-grp">
              <div className="tg-nav-gtitle">{grp.g}</div>
              {grp.items.map((it) => (
                <div key={it} className={`tg-nav-item ${it === active ? "on" : ""}`}>
                  <span className="tg-nav-dot" />
                  {it}
                </div>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      {/* —— 主区 —— */}
      <div className="tg-main">
        <header className="tg-header">
          <div className="tg-crumb">数据集成 / <b>数据同步</b></div>
          <div className="tg-header-right">
            <div className="tg-search">⌕ 搜索表 / 任务 / 指标</div>
            <button className="tg-btn ghost">刷新</button>
            <button className="tg-btn accent">AI 诊断</button>
            <button className="tg-btn primary">+ 新建任务</button>
            <div className="tg-avatar">AD</div>
          </div>
        </header>

        <div className="tg-tabs">
          <span className="tg-tab on">运行总览</span>
          <span className="tg-tab">任务明细</span>
          <span className="tg-tab">执行链路</span>
        </div>

        <div className="tg-content">
          {/* KPI 瓷贴 */}
          <div className="tg-kpis">
            {KPIS.map((k) => (
              <div className="tg-kpi" key={k.label} style={{ ["--kglow" as any]: `var(--${k.tone})` }}>
                <div className="tg-kpi-label">{k.label}</div>
                <div className="tg-kpi-value">{k.value}</div>
                <div className="tg-kpi-delta" style={{ color: `var(--${k.tone})` }}>{k.delta}</div>
              </div>
            ))}
          </div>

          {/* 图表行:折线 + 环形 */}
          <div className="tg-row">
            <div className="tg-panel" style={{ flex: "1 1 460px", minWidth: 360 }}>
              <div className="tg-panel-head">
                <span className="tg-panel-title">同步吞吐趋势(万行/日)</span>
                <span className="tg-legend">
                  <i style={{ background: "var(--s1)" }} />Glue 批同步
                  <i style={{ background: "var(--s2)", marginLeft: 12 }} />DMS 实时
                </span>
              </div>
              <LineChart />
            </div>
            <div className="tg-panel" style={{ flex: "1 1 300px", minWidth: 280 }}>
              <div className="tg-panel-head"><span className="tg-panel-title">任务状态分布</span></div>
              <DonutChart />
            </div>
          </div>

          {/* 图表行:柱状 + GenBI 执行链路 */}
          <div className="tg-row">
            <div className="tg-panel" style={{ flex: "1 1 340px", minWidth: 300 }}>
              <div className="tg-panel-head"><span className="tg-panel-title">作业运行次数 Top 5(近 7 天)</span></div>
              <BarChart />
            </div>
            <div className="tg-panel" style={{ flex: "1 1 420px", minWidth: 320 }}>
              <div className="tg-panel-head">
                <span className="tg-panel-title">GenBI 执行链路</span>
                <span className="tg-chip"><span className="tg-dot" />问数「近30日各渠道 GMV」</span>
              </div>
              <div className="tg-trace">
                {GENBI_TRACE.map((s) => (
                  <div className="tg-trace-step" key={s.i}>
                    <div className="tg-trace-idx">{s.i}</div>
                    <div className="tg-trace-body">
                      <div className="tg-trace-top">
                        <span className="tg-tool">{s.tool}</span>
                        <span className={`tg-phase ${s.phase === "准备" ? "prep" : "infer"}`}>{s.phase}</span>
                        <span className="tg-ms">{s.ms}ms</span>
                        <span className="tg-ok">✓</span>
                      </div>
                      <div className="tg-trace-note">{s.note}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* 任务明细表 */}
          <div className="tg-panel">
            <div className="tg-panel-head"><span className="tg-panel-title">近期任务</span></div>
            <table className="tg-table">
              <thead>
                <tr><th>任务名</th><th>通道</th><th>状态</th><th>数据量</th><th>耗时</th></tr>
              </thead>
              <tbody>
                {TASK_ROWS.map((r) => (
                  <tr key={r.name}>
                    <td className="tg-td-name">{r.name}</td>
                    <td>{r.type}</td>
                    <td><span className="tg-status" style={{ color: STATUS_VAR[r.status] || "var(--text)" }}>● {r.status}</span></td>
                    <td>{r.rows}</td>
                    <td>{r.dur}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

// 全部按角色变量书写的样式;各 motif/panelStyle 用类选择器分流。
function ShellStyles() {
  // 用 dangerouslySetInnerHTML 注入,避开 React 对 <style> 文本内容的转义(字体名内单引号会致水合不一致)。
  return (
    <style dangerouslySetInnerHTML={{ __html: `
      .tg-shell {
        --sider-w: 216px;
        position: relative; display: flex; width: 100%; height: 100%;
        background: var(--bg); color: var(--text);
        font-family: var(--font); font-variant-numeric: tabular-nums;
        overflow: hidden;
      }
      .tg-shell * { box-sizing: border-box; }
      .tg-bg-motif { position: absolute; inset: 0; pointer-events: none; z-index: 0;
        background: var(--bg-layers); }

      /* ============ 背景母题 ============ */
      .motif-scanline .tg-bg-motif::before, .motif-grid .tg-bg-motif::before,
      .motif-matrix .tg-bg-motif::before, .motif-hexgrid .tg-bg-motif::before,
      .motif-holo-hud .tg-bg-motif::before, .motif-circuit .tg-bg-motif::before {
        content:""; position:absolute; inset:0;
        background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
        background-size: 44px 44px; opacity:.5;
        mask-image: radial-gradient(1200px 760px at 50% 0%, #000 30%, transparent 88%);
      }
      .motif-hexgrid .tg-bg-motif::before { background-size: 60px 60px; transform: perspective(600px) rotateX(56deg); transform-origin: bottom; top: 55%; opacity:.4; }
      .motif-scanline .tg-bg-motif::after, .motif-matrix .tg-bg-motif::after, .motif-holo-hud .tg-bg-motif::after {
        content:""; position:absolute; left:0; right:0; height:140px; top:-140px;
        background: linear-gradient(180deg, transparent, var(--glow), transparent); opacity:.14;
        animation: tg-scan 8s linear infinite;
      }
      @keyframes tg-scan { to { transform: translateY(2000px); } }
      .motif-matrix .tg-bg-motif { background-image: repeating-linear-gradient(0deg, rgba(0,255,208,0.05) 0 1px, transparent 1px 3px); }
      .motif-aurora .tg-bg-motif::before, .motif-waves .tg-bg-motif::before {
        content:""; position:absolute; inset:-20%;
        background: conic-gradient(from 120deg at 50% 50%, transparent, var(--glow), transparent 40%);
        filter: blur(60px); opacity:.5; animation: tg-rotate 24s linear infinite;
      }
      @keyframes tg-rotate { to { transform: rotate(360deg); } }
      .motif-mesh .tg-bg-motif::before {
        content:""; position:absolute; inset:0;
        background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
        background-size: 30px 30px; opacity:.35; transform: perspective(700px) rotateX(28deg) scale(1.3); transform-origin: top;
      }
      .motif-dots .tg-bg-motif::before {
        content:""; position:absolute; inset:0;
        background-image: radial-gradient(var(--grid) 1.4px, transparent 1.4px); background-size: 22px 22px; opacity:.7;
      }
      .motif-starfield .tg-bg-motif::before, .motif-starfield .tg-bg-motif::after {
        content:""; position:absolute; inset:0;
        background-image: radial-gradient(1px 1px at 20% 30%, #fff, transparent), radial-gradient(1px 1px at 70% 60%, #fff, transparent),
          radial-gradient(1.5px 1.5px at 40% 80%, #fff, transparent), radial-gradient(1px 1px at 85% 20%, #fff, transparent),
          radial-gradient(1px 1px at 55% 45%, #fff, transparent), radial-gradient(1.5px 1.5px at 10% 70%, #fff, transparent);
        opacity:.5; }
      .motif-starfield .tg-bg-motif::after { animation: tg-twinkle 4s ease-in-out infinite alternate; opacity:.3; }
      @keyframes tg-twinkle { to { opacity:.7; } }
      .motif-circuit .tg-bg-motif::after {
        content:""; position:absolute; inset:0; opacity:.16;
        background-image: linear-gradient(90deg, var(--primary) 1px, transparent 1px), linear-gradient(var(--primary) 1px, transparent 1px);
        background-size: 88px 26px, 26px 88px;
        mask-image: radial-gradient(900px 500px at 80% 10%, #000, transparent 70%);
      }

      /* ============ 侧栏 ============ */
      .tg-sider { position: relative; z-index: 2; width: var(--sider-w); flex-shrink: 0;
        background: var(--sider-bg); backdrop-filter: blur(10px);
        border-right: 1px solid var(--panel-border); display: flex; flex-direction: column; }
      .tg-logo { display:flex; align-items:center; gap:8px; padding: 18px 16px; font-weight:700; }
      .tg-logo-mark { color: var(--primary); text-shadow: 0 0 12px var(--glow); }
      .tg-logo-text { font-size: 15px; background: var(--gradient); -webkit-background-clip: text; background-clip: text; color: transparent; letter-spacing:.5px; }
      .tg-nav { padding: 4px 10px 16px; overflow-y: auto; flex: 1; }
      .tg-nav-home { padding: 8px 12px; border-radius: 8px; color: var(--text); font-size: 13px; margin-bottom: 6px; }
      .tg-nav-grp { margin-bottom: 6px; }
      .tg-nav-gtitle { font-size: 11px; letter-spacing:1px; color: var(--text-dim); padding: 8px 12px 4px; opacity:.8; }
      .tg-nav-item { display:flex; align-items:center; gap:8px; padding: 7px 12px; border-radius: 8px; font-size: 13px; color: var(--text-dim); cursor: default; transition: all .16s; }
      .tg-nav-item:hover { color: var(--text); background: rgba(127,127,127,0.08); }
      .tg-nav-dot { width:5px; height:5px; border-radius:50%; background: currentColor; opacity:.5; }
      .tg-nav-item.on { color: var(--sider-active-text); background: var(--sider-active-bg); box-shadow: inset 2px 0 0 var(--primary); }
      .tg-nav-item.on .tg-nav-dot { background: var(--primary); opacity:1; box-shadow: 0 0 8px var(--glow); }

      /* ============ 主区 ============ */
      .tg-main { position: relative; z-index: 1; flex: 1; display: flex; flex-direction: column; min-width: 0; }
      .tg-header { display:flex; align-items:center; justify-content:space-between; padding: 12px 22px;
        border-bottom: 1px solid var(--panel-border); backdrop-filter: blur(6px); }
      .tg-crumb { font-size: 13px; color: var(--text-dim); }
      .tg-crumb b { color: var(--text); }
      .tg-header-right { display:flex; align-items:center; gap: 10px; }
      .tg-search { font-size: 12px; color: var(--text-dim); padding: 6px 14px; border-radius: 999px;
        border: 1px solid var(--panel-border); background: rgba(127,127,127,0.06); }
      .tg-btn { cursor: default; font-size: 12.5px; border-radius: 8px; padding: 6px 14px; border: 1px solid var(--panel-border);
        background: rgba(127,127,127,0.06); color: var(--text); transition: all .16s; }
      .tg-btn.ghost:hover { border-color: var(--primary); }
      .tg-btn.accent { border-color: color-mix(in srgb, var(--accent) 55%, transparent); background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); }
      .tg-btn.primary { border: none; color: #04121a; font-weight: 700; background: var(--gradient); box-shadow: 0 0 16px var(--glow); }
      .is-light .tg-btn.primary { color: #fff; }
      .tg-avatar { width: 30px; height: 30px; border-radius: 50%; display:flex; align-items:center; justify-content:center;
        font-size: 12px; font-weight:700; color:#04121a; background: var(--gradient); box-shadow: 0 0 12px var(--glow); }

      .tg-tabs { display:flex; gap: 4px; padding: 12px 22px 0; }
      .tg-tab { font-size: 13px; color: var(--text-dim); padding: 7px 16px; border-radius: 8px 8px 0 0; border: 1px solid transparent; border-bottom: none; }
      .tg-tab.on { color: var(--primary-bright); background: color-mix(in srgb, var(--primary) 10%, transparent);
        border-color: var(--panel-border); text-shadow: 0 0 12px var(--glow); }

      .tg-content { padding: 18px 22px 26px; overflow-y: auto; flex: 1; }

      /* KPI */
      .tg-kpis { display:flex; gap: 14px; flex-wrap: wrap; margin-bottom: 16px; }
      .tg-kpi { flex: 1 1 180px; min-width: 170px; border-radius: var(--radius); padding: 15px 16px; position: relative; overflow: hidden;
        background: var(--panel); border: 1px solid var(--panel-border); box-shadow: var(--panel-shadow); }
      .tg-kpi::after { content:""; position:absolute; left:0; right:0; top:0; height:2px;
        background: linear-gradient(90deg, transparent, var(--kglow), transparent); animation: tg-pulse 2.8s ease-in-out infinite; }
      @keyframes tg-pulse { 0%,100%{opacity:.35;} 50%{opacity:1;} }
      .tg-kpi-label { font-size: 12px; color: var(--text-dim); letter-spacing:.5px; }
      .tg-kpi-value { font-size: 28px; font-weight: 800; color: var(--text); margin: 6px 0 3px; }
      .tg-kpi-delta { font-size: 12px; }

      /* 面板 */
      .tg-row { display:flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
      .tg-panel { border-radius: var(--radius); padding: 16px 18px; background: var(--panel); border: 1px solid var(--panel-border);
        box-shadow: var(--panel-shadow); position: relative; }
      .tg-panel-head { display:flex; align-items:center; justify-content:space-between; margin-bottom: 12px; gap: 10px; flex-wrap: wrap; }
      .tg-panel-title { font-size: 14px; font-weight: 600; color: var(--text); }
      .tg-legend { font-size: 11.5px; color: var(--text-dim); display:flex; align-items:center; }
      .tg-legend i { display:inline-block; width: 12px; height: 3px; border-radius: 2px; margin-right: 5px; }
      .tg-chip { display:inline-flex; align-items:center; gap:6px; font-size: 11.5px; color: var(--text-dim);
        border: 1px solid var(--panel-border); border-radius: 999px; padding: 3px 10px; background: color-mix(in srgb, var(--primary) 7%, transparent); }
      .tg-dot { width:6px; height:6px; border-radius:50%; background: var(--ok); box-shadow: 0 0 8px var(--ok); }

      .tg-line { filter: drop-shadow(0 0 3px var(--glow)); }
      .tg-bar { transition: filter .15s; }
      .tg-bar:hover { filter: brightness(1.3) drop-shadow(0 0 5px var(--glow)); }
      .tg-arc { transition: opacity .15s; }
      .tg-arc:hover { opacity: .82; }

      /* GenBI 执行链路 */
      .tg-trace { display:flex; flex-direction: column; gap: 8px; }
      .tg-trace-step { display:flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border-radius: 10px;
        background: color-mix(in srgb, var(--primary) 5%, transparent); border: 1px solid var(--panel-border); }
      .tg-trace-idx { width: 20px; height: 20px; flex-shrink:0; border-radius: 6px; display:flex; align-items:center; justify-content:center;
        font-size: 11px; font-weight: 700; color: #04121a; background: var(--gradient); }
      .tg-trace-body { flex: 1; min-width: 0; }
      .tg-trace-top { display:flex; align-items:center; gap: 8px; flex-wrap: wrap; }
      .tg-tool { font-size: 12.5px; font-weight: 700; color: var(--primary-bright); font-family: ui-monospace, monospace; }
      .tg-phase { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; }
      .tg-phase.prep { color: var(--s3); background: color-mix(in srgb, var(--s3) 14%, transparent); }
      .tg-phase.infer { color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
      .tg-ms { font-size: 11px; color: var(--text-dim); }
      .tg-ok { font-size: 12px; color: var(--ok); margin-left: auto; }
      .tg-trace-note { font-size: 11.5px; color: var(--text-dim); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

      /* 表格 */
      .tg-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
      .tg-table th { text-align:left; color: var(--text-dim); font-weight: 500; padding: 8px 12px;
        border-bottom: 1px solid var(--panel-border); background: color-mix(in srgb, var(--primary) 5%, transparent); }
      .tg-table td { padding: 9px 12px; border-bottom: 1px solid var(--grid); color: var(--text); }
      .tg-table tbody tr { transition: background .14s; }
      .tg-table tbody tr:hover { background: color-mix(in srgb, var(--primary) 8%, transparent); box-shadow: inset 2px 0 0 var(--primary); }
      .tg-td-name { color: var(--primary-bright); }
      .tg-status { font-weight: 500; }

      /* ============ 面板质感变体 ============ */
      .panel-gradientBorder .tg-panel, .panel-gradientBorder .tg-kpi {
        border: 1px solid transparent;
        background:
          linear-gradient(var(--panel-solid), var(--panel-solid)) padding-box,
          linear-gradient(135deg, var(--primary), var(--accent)) border-box;
      }
      .panel-glass .tg-panel, .panel-glass .tg-kpi { backdrop-filter: blur(12px); }
      .panel-outline .tg-panel, .panel-outline .tg-kpi { background: var(--panel); backdrop-filter: blur(4px); }
      .panel-neumorph .tg-panel, .panel-neumorph .tg-kpi { border: 1px solid var(--panel-border); box-shadow: var(--panel-shadow); }
      .panel-neumorph .tg-kpi::after { display: none; }

      /* HUD 角标(holo-hud / tron) */
      .motif-circuit .tg-panel::before, .motif-circuit .tg-panel::after,
      .motif-hexgrid .tg-panel::before, .motif-hexgrid .tg-panel::after {
        content:""; position:absolute; width: 12px; height: 12px; border: 1.5px solid var(--primary); opacity:.7;
      }
      .motif-circuit .tg-panel::before, .motif-hexgrid .tg-panel::before { top:-1px; left:-1px; border-right:none; border-bottom:none; }
      .motif-circuit .tg-panel::after, .motif-hexgrid .tg-panel::after { bottom:-1px; right:-1px; border-left:none; border-top:none; }

      /* ============ 缩略图模式:目录卡片里的等比缩放 ============ */
      .is-thumb { pointer-events: none; }
      .is-thumb .tg-content { overflow: hidden; }
      .is-thumb .tg-nav { overflow: hidden; }
    ` }} />
  );
}
