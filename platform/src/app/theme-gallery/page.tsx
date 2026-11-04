"use client";

// 风格体验目录(卡片墙)—— 12 款科技风皮肤缩略图,点任意一款进全屏沉浸预览。
// 独立静态页,自带全部样式,不触碰任何共享代码(lib/theme.ts / layout / routes 均不动)。
import React from "react";
import Link from "next/link";
import { THEMES } from "./themes";
import ThemeThumb from "./ThemeThumb";

export default function ThemeGalleryPage() {
  return (
    <div className="tgx-root">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />

      <header className="tgx-hero">
        <div className="tgx-hero-badge">◢ THEME GALLERY</div>
        <h1 className="tgx-hero-title">风格体验目录</h1>
        <p className="tgx-hero-sub">
          12 款科技风皮肤候选 · 每款都是「整站换肤后的样子」(导航 + 顶栏 + 仪表盘 + GenBI 执行链路)。
          点任意一款进入全屏预览,逐一对比挑选。图表配色均经可访问性校验(避开红/黄,冷色族)。
        </p>
        <div className="tgx-hero-meta">共 {THEMES.length} 款 · 暗色 {THEMES.filter((t) => t.mode === "dark").length} · 亮色 {THEMES.filter((t) => t.mode === "light").length}</div>
      </header>

      <div className="tgx-grid">
        {THEMES.map((t, i) => (
          <Link key={t.id} href={`/theme-gallery/${t.id}`} className="tgx-card">
            <div className="tgx-card-thumb">
              <ThemeThumb theme={t} width={336} />
              <div className="tgx-card-hover"><span className="tgx-card-cta">进入全屏预览 →</span></div>
            </div>
            <div className="tgx-card-info">
              <div className="tgx-card-row">
                <span className="tgx-card-no">{String(i + 1).padStart(2, "0")}</span>
                <span className="tgx-card-name">{t.name}</span>
                <span className={`tgx-mode ${t.mode}`}>{t.mode === "dark" ? "暗色" : "亮色"}</span>
              </div>
              <div className="tgx-card-tag">{t.tagline}</div>
              <div className="tgx-swatches">
                {[t.primary, t.accent, t.series.s1, t.series.s2, t.series.s3, t.series.s4].map((c, j) => (
                  <span key={j} className="tgx-sw" style={{ background: c }} title={c} />
                ))}
              </div>
            </div>
          </Link>
        ))}
      </div>

      <footer className="tgx-foot">
        说明:本目录为独立静态预览模块,不影响现有平台主题。选定后可将该皮肤的 token 提升为全站可切换主题。
      </footer>
    </div>
  );
}

const STYLES = `
  .tgx-root { margin: -24px; padding: 32px 32px 48px; min-height: calc(100vh - 64px);
    background:
      radial-gradient(1000px 500px at 85% -10%, rgba(139,111,232,0.14), transparent 60%),
      radial-gradient(900px 460px at -5% 15%, rgba(0,229,255,0.12), transparent 55%),
      #06060f;
    color: #e8f1ff; font-family: system-ui,-apple-system,'Segoe UI','PingFang SC',sans-serif; }
  .tgx-hero { max-width: 900px; margin-bottom: 28px; }
  .tgx-hero-badge { display:inline-block; font-size: 12px; letter-spacing: 3px; color: #7df9ff;
    border: 1px solid rgba(125,249,255,0.35); border-radius: 999px; padding: 4px 14px; background: rgba(0,229,255,0.06); }
  .tgx-hero-title { font-size: 34px; font-weight: 800; margin: 16px 0 10px; letter-spacing: 2px;
    background: linear-gradient(90deg,#00e5ff,#a78bfa 50%,#ff6ec7); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .tgx-hero-sub { font-size: 14px; line-height: 1.7; color: #a6b6d4; margin: 0 0 10px; }
  .tgx-hero-meta { font-size: 12.5px; color: #7f90b0; }

  .tgx-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 20px; }
  .tgx-card { display:block; text-decoration:none; border-radius: 16px; overflow: hidden;
    background: rgba(16,16,32,0.6); border: 1px solid rgba(127,140,180,0.18);
    transition: transform .22s, box-shadow .22s, border-color .22s; }
  .tgx-card:hover { transform: translateY(-4px); border-color: rgba(125,249,255,0.5);
    box-shadow: 0 14px 40px rgba(0,0,0,0.5), 0 0 30px rgba(0,229,255,0.12); }
  .tgx-card-thumb { position: relative; height: 210px; overflow: hidden; border-bottom: 1px solid rgba(127,140,180,0.18); }
  .tgx-card-hover { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
    background: linear-gradient(180deg, transparent, rgba(6,6,15,0.55)); opacity: 0; transition: opacity .22s; }
  .tgx-card:hover .tgx-card-hover { opacity: 1; }
  .tgx-card-cta { font-size: 13px; font-weight: 700; color: #04121a; background: linear-gradient(90deg,#7df9ff,#a78bfa);
    padding: 8px 18px; border-radius: 999px; box-shadow: 0 0 20px rgba(125,249,255,0.5); }
  .tgx-card-info { padding: 14px 16px 16px; }
  .tgx-card-row { display:flex; align-items:center; gap: 10px; }
  .tgx-card-no { font-size: 12px; font-weight: 800; color: #4a5a7a; font-variant-numeric: tabular-nums; }
  .tgx-card-name { font-size: 16px; font-weight: 700; color: #eaf2ff; flex: 1; }
  .tgx-mode { font-size: 10.5px; padding: 2px 9px; border-radius: 999px; }
  .tgx-mode.dark { color: #7df9ff; background: rgba(0,229,255,0.1); border: 1px solid rgba(125,249,255,0.3); }
  .tgx-mode.light { color: #ffd9a0; background: rgba(255,200,120,0.08); border: 1px solid rgba(255,200,120,0.25); }
  .tgx-card-tag { font-size: 12px; color: #93a7c4; margin: 8px 0 12px; line-height: 1.5; min-height: 34px; }
  .tgx-swatches { display:flex; gap: 6px; }
  .tgx-sw { width: 22px; height: 12px; border-radius: 4px; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.12); }

  .tgx-foot { margin-top: 32px; font-size: 12px; color: #6f7fa0; text-align: center; }
`;
