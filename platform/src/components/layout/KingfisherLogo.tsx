"use client";

// Kingfisher 品牌图标 —— 内联 SVG 翠鸟侧影(不引外部图片/依赖)。
// 用当前皮肤主色渐变着色(--bgp-primary → --bgp-primary-bright),任何皮肤下都清晰。
// 翠鸟特征:短粗尖喙、圆头、蹲坐姿态、翘短尾;侧身站在枝上的经典剪影。
import React from "react";

export default function KingfisherLogo({ size = 26 }: { size?: number }) {
  const gid = React.useId().replace(/:/g, "");
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      role="img"
      aria-label="Kingfisher"
      style={{ flexShrink: 0, filter: "drop-shadow(0 0 6px var(--bgp-glow, rgba(34,211,238,0.4)))" }}
    >
      <defs>
        <linearGradient id={`kf-${gid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--bgp-primary-bright, #56e0f2)" />
          <stop offset="100%" stopColor="var(--bgp-primary, #22d3ee)" />
        </linearGradient>
        <linearGradient id={`kf-accent-${gid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--bgp-accent, #34d3e0)" />
          <stop offset="100%" stopColor="var(--bgp-primary, #22d3ee)" />
        </linearGradient>
      </defs>

      {/* 身体 + 圆头(蹲坐侧影) */}
      <path
        d="M20 26 C20 17 27 12 34 12 C41 12 46 17 47 24 C53 27 57 33 56 40 C55 47 49 50 42 50 L30 50 C23 50 18 45 17 38 C16 32 17 28 20 26 Z"
        fill={`url(#kf-${gid})`}
      />
      {/* 尖长喙(翠鸟标志性) */}
      <path d="M20 24 L4 20 L20 30 Z" fill={`url(#kf-accent-${gid})`} />
      {/* 翅膀(叠色暗面,拉出层次) */}
      <path
        d="M34 26 C42 26 49 30 52 37 C49 44 43 46 37 45 C31 44 28 39 29 33 C30 29 31 27 34 26 Z"
        fill="var(--bgp-accent, #34d3e0)"
        opacity="0.42"
      />
      {/* 短尾上翘 */}
      <path d="M54 41 L63 45 L55 48 Z" fill={`url(#kf-${gid})`} />
      {/* 眼睛 */}
      <circle cx="30" cy="23" r="2.6" fill="var(--bgp-bg, #071620)" />
      <circle cx="30.8" cy="22.2" r="0.9" fill="#fff" opacity="0.9" />
      {/* 栖枝 */}
      <rect x="24" y="52" width="26" height="3" rx="1.5" fill="var(--bgp-text-dim, #8fb0c2)" opacity="0.5" />
    </svg>
  );
}
