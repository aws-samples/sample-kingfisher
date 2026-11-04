"use client";

// 目录卡片里的等比缩略图:把完整 ThemedShell 以 1200×760 渲染,再整体缩放贴进卡片。
import React from "react";
import type { Theme } from "./themes";
import ThemedShell from "./ThemedShell";

const BASE_W = 1200;
const BASE_H = 760;

export default function ThemeThumb({ theme, width = 336 }: { theme: Theme; width?: number }) {
  const scale = width / BASE_W;
  const height = BASE_H * scale;
  return (
    <div style={{ width, height, overflow: "hidden", position: "relative", borderRadius: 12 }}>
      <div style={{ width: BASE_W, height: BASE_H, transform: `scale(${scale})`, transformOrigin: "top left" }}>
        <ThemedShell theme={theme} variant="thumb" />
      </div>
    </div>
  );
}
