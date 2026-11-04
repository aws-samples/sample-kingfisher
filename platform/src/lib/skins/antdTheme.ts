// 皮肤 token → antd ThemeConfig(全站换肤:ConfigProvider 吃它)。
//
// 结构对齐改造前 lib/theme.ts 的 techTheme;把写死的青蓝值参数化成 skin 字段。
// 亮色皮肤走 defaultAlgorithm,暗色走 darkAlgorithm。默认皮肤 quantum-teal 生成的
// 配置与改造前 techTheme 等价(主色/文字/容器/边框全一致),保证像素级不变。
import { theme as antdTheme, type ThemeConfig } from "antd";
import type { Skin } from "./skins";

// 把 "rgba(12,28,40,0.66)" / "#0c1c28" 的暗色容器底,回退成一个不透明近似(elevated 用)。
function elevated(s: Skin): string {
  // 暗色统一抬一档亮度的容器色;亮色直接用面板色。
  return s.mode === "dark" ? mixToward(s.panel, s.text, 0.06) : s.panel;
}

// 极简线性混合(仅用于派生 elevated/hover 辅助色,不参与校验过的系列色)。
function mixToward(base: string, toward: string, t: number): string {
  const a = parseColor(base);
  const b = parseColor(toward);
  if (!a || !b) return base;
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}
function parseColor(c: string): [number, number, number] | null {
  const hex = c.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = c.match(/rgba?\(([^)]+)\)/);
  if (rgb) {
    const p = rgb[1].split(",").map((x) => parseFloat(x.trim()));
    return [p[0], p[1], p[2]];
  }
  return null;
}

export function skinToAntdTheme(s: Skin): ThemeConfig {
  const isDark = s.mode === "dark";
  return {
    algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: s.primary,
      colorInfo: s.primary,
      colorLink: s.primaryBright,
      colorSuccess: s.ok,
      colorWarning: "#e0a23c", // 低饱和琥珀(非俗黄),沿用改造前
      colorError: "#f5577a", // 玫红(非俗红),沿用改造前
      colorBgBase: s.bg,
      colorBgContainer: s.panel,
      colorBgElevated: elevated(s),
      colorBorder: s.panelBorder,
      colorBorderSecondary: s.grid,
      colorText: s.text,
      colorTextSecondary: s.textDim,
      colorTextPlaceholder: s.textDim,
      colorTextDescription: s.textDim,
      colorIcon: s.textDim,
      colorIconHover: s.primaryBright,
      borderRadius: s.radius,
      wireframe: false,
      fontSize: 14,
    },
    components: {
      Layout: { headerBg: "transparent", siderBg: s.siderBg, bodyBg: "transparent" },
      Menu: isDark
        ? {
            darkItemBg: "transparent",
            darkSubMenuItemBg: "transparent",
            darkItemSelectedBg: s.siderActiveBg,
            darkItemSelectedColor: s.siderActiveText,
            darkItemHoverColor: s.primaryBright,
          }
        : {
            itemBg: "transparent",
            subMenuItemBg: "transparent",
            itemSelectedBg: s.siderActiveBg,
            itemSelectedColor: s.siderActiveText,
            itemHoverColor: s.primary,
          },
      Card: { colorBgContainer: s.panel },
      Table: {
        headerBg: withAlpha(s.primary, 0.07),
        colorBgContainer: "transparent",
        rowHoverBg: withAlpha(s.primary, 0.06),
      },
      Statistic: { colorTextDescription: s.textDim },
      Modal: { contentBg: elevated(s), headerBg: elevated(s) },
      Drawer: { colorBgElevated: elevated(s) },
    },
  };
}

// 给十六进制主色加透明度(用于表头/hover 底);主色恒为 #rrggbb。
function withAlpha(hex: string, a: number): string {
  const c = parseColor(hex);
  if (!c) return hex;
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
}
