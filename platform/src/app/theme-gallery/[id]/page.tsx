"use client";

// 单款皮肤全屏沉浸预览 —— 覆盖真实平台 chrome,铺满视口展示「整站换成这款皮肤的样子」。
// 顶部悬浮工具条:返回目录 / 上一款 / 下一款 / 应用(占位:选定后再提升为全站主题)。
import React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { THEMES, themeById } from "../themes";
import ThemedShell from "../ThemedShell";
import { useSkin } from "@/lib/skins/ThemeProvider";
import { message } from "antd";

export default function ThemePreviewFullPage() {
  const params = useParams();
  const router = useRouter();
  const { skinId, setSkinId } = useSkin();
  const id = String(params?.id || "");
  const idx = THEMES.findIndex((t) => t.id === id);
  const theme = themeById(id);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && idx > 0) router.push(`/theme-gallery/${THEMES[idx - 1].id}`);
      if (e.key === "ArrowRight" && idx < THEMES.length - 1) router.push(`/theme-gallery/${THEMES[idx + 1].id}`);
      if (e.key === "Escape") router.push("/theme-gallery");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idx, router]);

  if (!theme) {
    return (
      <div style={{ margin: -24, minHeight: "calc(100vh - 64px)", display: "flex", alignItems: "center", justifyContent: "center", color: "#93a7c4", background: "#06060f" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 18, marginBottom: 12 }}>未找到皮肤「{id}」</div>
          <Link href="/theme-gallery" style={{ color: "#7df9ff" }}>← 返回风格目录</Link>
        </div>
      </div>
    );
  }

  const prev = idx > 0 ? THEMES[idx - 1] : null;
  const next = idx < THEMES.length - 1 ? THEMES[idx + 1] : null;

  return (
    <div className="tgf-root">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />

      {/* 悬浮工具条 */}
      <div className="tgf-bar">
        <Link href="/theme-gallery" className="tgf-back">← 返回目录</Link>
        <div className="tgf-title">
          <span className="tgf-no">{String(idx + 1).padStart(2, "0")} / {String(THEMES.length).padStart(2, "0")}</span>
          <span className="tgf-name">{theme.name}</span>
          <span className="tgf-tag">{theme.tagline}</span>
        </div>
        <div className="tgf-actions">
          {prev ? <Link href={`/theme-gallery/${prev.id}`} className="tgf-nav" title={prev.name}>← 上一款</Link> : <span className="tgf-nav disabled">← 上一款</span>}
          {next ? <Link href={`/theme-gallery/${next.id}`} className="tgf-nav" title={next.name}>下一款 →</Link> : <span className="tgf-nav disabled">下一款 →</span>}
          <button
            className="tgf-apply"
            onClick={() => {
              setSkinId(theme.id);
              message.success(`已切换到「${theme.name}」皮肤,全站已生效`);
            }}
          >
            {skinId === theme.id ? "✓ 当前皮肤" : "应用此皮肤"}
          </button>
        </div>
      </div>

      {/* 全屏外壳 */}
      <div className="tgf-stage">
        <ThemedShell theme={theme} variant="full" />
      </div>

      <div className="tgf-hint">← → 切换皮肤 · Esc 返回目录</div>
    </div>
  );
}

const STYLES = `
  /* 用 fixed 覆盖整个视口(含真实侧栏/顶栏),实现真·整站换肤的沉浸预览。纯本页 CSS,不动共享布局。 */
  .tgf-root { position: fixed; inset: 0; z-index: 9999; display: flex; flex-direction: column;
    background: #050509; font-family: system-ui,-apple-system,'Segoe UI','PingFang SC',sans-serif; }
  .tgf-bar { display:flex; align-items:center; justify-content:space-between; gap: 16px; padding: 10px 18px;
    background: rgba(10,10,20,0.9); border-bottom: 1px solid rgba(127,140,180,0.2); backdrop-filter: blur(8px); flex-shrink: 0; z-index: 10; }
  .tgf-back { font-size: 13px; color: #93a7c4; text-decoration: none; padding: 6px 12px; border-radius: 8px;
    border: 1px solid rgba(127,140,180,0.25); transition: all .16s; white-space: nowrap; }
  .tgf-back:hover { color: #7df9ff; border-color: rgba(125,249,255,0.5); }
  .tgf-title { display:flex; align-items:center; gap: 12px; min-width: 0; flex: 1; }
  .tgf-no { font-size: 12px; font-weight: 800; color: #4a5a7a; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .tgf-name { font-size: 16px; font-weight: 700; color: #eaf2ff; white-space: nowrap; }
  .tgf-tag { font-size: 12px; color: #7f90b0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tgf-actions { display:flex; align-items:center; gap: 8px; flex-shrink: 0; }
  .tgf-nav { font-size: 12.5px; color: #cfe0f5; text-decoration:none; padding: 6px 12px; border-radius: 8px;
    border: 1px solid rgba(127,140,180,0.25); transition: all .16s; white-space: nowrap; }
  .tgf-nav:hover { border-color: rgba(125,249,255,0.5); color: #7df9ff; }
  .tgf-nav.disabled { opacity: .35; }
  .tgf-apply { cursor: pointer; font-size: 12.5px; font-weight: 700; color: #04121a; border: none; padding: 7px 16px; border-radius: 8px;
    background: linear-gradient(90deg,#7df9ff,#a78bfa); box-shadow: 0 0 18px rgba(125,249,255,0.4); white-space: nowrap; }
  .tgf-stage { flex: 1; min-height: 0; position: relative; overflow: hidden; }
  .tgf-hint { position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%); font-size: 11px; color: #6f7fa0;
    background: rgba(10,10,20,0.7); padding: 4px 14px; border-radius: 999px; border: 1px solid rgba(127,140,180,0.2); z-index: 20; pointer-events: none; }
`;
