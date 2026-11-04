// 模块 21 — 暗黑科技主题 (v1.12.3)
//
// 「暗黑 / 科技酷炫」主题，配色借鉴青蓝科技风参考图：以 antd 暗色算法为基底，
// 形成完整的**青蓝单色阶梯**——深蓝黑底 (#08131b 系) → 青蓝中间调容器/边框
// (面板本身泛青光) → 亮青高光 (#56e0f2)。避免"暗→亮青点缀"的断层，营造通透辉光感。
import { theme as antdTheme, type ThemeConfig } from "antd";

// 调色板（集中管理，便于 page 内联样式复用）。
export const TECH = {
  primary: "#22d3ee", // 霓虹青（科技主色）
  primaryBright: "#56e0f2", // 亮青高光（参考图辉光色）
  accent: "#34d3e0", // 青（点缀，偏纯青而非青绿）
  bgBase: "#071620", // 深蓝黑底（偏蓝，借鉴参考图 #08131b）
  bgSider: "#061320",
  bgContainer: "#0c1c28", // 容器（青蓝中间调，泛青）
  bgGlass: "rgba(12, 28, 40, 0.66)", // 玻璃容器
  bgGlassHeader: "rgba(7, 18, 27, 0.74)",
  border: "#1d4254", // 边框（青蓝中间调，发青，借鉴 #214f62/#193748）
  borderSecondary: "#163243",
  borderGlow: "rgba(86, 224, 242, 0.22)",
  text: "#cfe6f0",
  textSecondary: "#8fb0c2",
} as const;

export const techTheme: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    colorPrimary: TECH.primary,
    colorInfo: TECH.primary,
    colorLink: TECH.primaryBright,
    colorSuccess: "#2dd4bf", // 青绿（非俗绿）
    colorWarning: "#e0a23c", // 低饱和琥珀（非俗黄）
    colorError: "#f5577a", // 玫红（非俗红）
    colorBgBase: TECH.bgBase,
    colorBgContainer: TECH.bgContainer,
    colorBgElevated: "#11293a",
    colorBorder: TECH.border,
    colorBorderSecondary: TECH.borderSecondary,
    colorText: TECH.text,
    colorTextSecondary: "#a4c0d2",
    colorTextPlaceholder: "#7d9bae",
    colorTextDescription: "#9fbccf",
    colorIcon: "#7d9bae",
    colorIconHover: TECH.primaryBright,
    borderRadius: 8,
    wireframe: false,
    fontSize: 14,
  },
  components: {
    Layout: { headerBg: "transparent", siderBg: TECH.bgSider, bodyBg: "transparent" },
    Menu: {
      darkItemBg: "transparent",
      darkSubMenuItemBg: "transparent",
      darkItemSelectedBg: "rgba(34, 211, 238, 0.18)",
      darkItemSelectedColor: TECH.primaryBright,
      darkItemHoverColor: TECH.primaryBright,
    },
    Card: { colorBgContainer: TECH.bgGlass },
    Table: { headerBg: "rgba(34, 211, 238, 0.07)", colorBgContainer: "transparent", rowHoverBg: "rgba(34, 211, 238, 0.06)" },
    Statistic: { colorTextDescription: TECH.textSecondary },
    Modal: { contentBg: "#0c1c28", headerBg: "#0c1c28" },
    Drawer: { colorBgElevated: "#0c1c28" },
  },
};
