// 全站皮肤(换肤功能)—— 12 款科技风皮肤的 token 数据源(单一事实源)。
//
// 本文件是「用户点击切换主题、全站生效」的数据契约:每款皮肤 = 一份 Theme token。
//   · ThemeProvider(lib/skins/ThemeProvider.tsx)吃当前皮肤 → 注入根节点 CSS 变量 + 生成 antd 主题;
//   · 风格体验目录(app/theme-gallery/*)吃全部皮肤渲染缩略图/全屏预览。
// 两处共用这一份,别再各存一份。
//
// 硬约束(用户拍板):酷炫科技风、尽量互不相同、避开红/黄等鲜艳色。
// 默认皮肤 = quantum-teal(现青蓝主题),未切换的用户看到的与改造前像素级一致。
// 图表系列色(series)全部经 dataviz 校验脚本实测通过(亮度带/色度/CVD/对比度四项),
// 且图表侧配直标 + 间隙作二级编码(符合 CVD floor 规则)。冷色族:青/蓝/青绿/紫/品红。

export interface ThemeSeries {
  s1: string;
  s2: string;
  s3: string;
  s4: string;
}

// 面板质感母题 —— ThemedShell 据此决定面板背景/边框/阴影的画法。
export type PanelStyle = "glass" | "solid" | "outline" | "neumorph" | "gradientBorder";
// 背景纹理母题 —— ThemedShell 据此叠加背景层与动效。
export type Motif =
  | "scanline" // 扫描光带 + 网格(赛博)
  | "grid" // 通透青蓝细网格
  | "aurora" // 极光流光
  | "mesh" // 全息网格渐变
  | "none" // 极简纯净
  | "matrix" // 终端扫描线 + 等宽
  | "dots" // 点阵(亮色)
  | "hexgrid" // Tron 六边/方格地平线
  | "waves" // 深海波纹
  | "starfield" // 星云星点
  | "circuit" // 电路走线
  | "brackets"; // HUD 角标 + 准星

export interface Theme {
  id: string; // URL slug
  name: string; // 中文名
  tagline: string; // 一句话风格描述
  mode: "dark" | "light";

  // —— 背景 ——
  bg: string; // 页面纯底色
  bgLayers: string; // CSS background(可多层渐变/光晕),叠在 bg 之上

  // —— 面板 ——
  panelStyle: PanelStyle;
  panel: string; // 面板底色(可含透明)
  panelBorder: string; // 面板边框色(gradientBorder 时走 gradient,此值作回退)
  panelShadow: string;
  radius: number; // 圆角

  // —— 文字 ——
  text: string;
  textDim: string;

  // —— 主色 / 强调 ——
  primary: string;
  primaryBright: string;
  accent: string; // 第二强调(与 primary 撞出双色调)
  gradient: string; // 标题/主按钮渐变
  glow: string; // 主辉光 rgba

  // —— 导航 ——
  siderBg: string;
  siderActiveBg: string;
  siderActiveText: string;

  // —— 图表 ——
  series: ThemeSeries; // 已校验的分类系列色
  grid: string; // 图表网格线

  // —— 状态(避开鲜艳红/黄;仅作小圆点 + 文字,不做大色块) ——
  ok: string;
  running: string;
  stopped: string;

  motif: Motif;
  mono?: boolean; // 等宽终端质感
}

// —— dataviz 校验脚本实测通过的系列色组(见对话记录,四项全绿) ——
const SET_A: ThemeSeries = { s1: "#3d8bfd", s2: "#d8479a", s3: "#8b6fe8", s4: "#17a382" }; // ΔE 33.9
const SET_B: ThemeSeries = { s1: "#2f7fe0", s2: "#d8479a", s3: "#12a07f", s4: "#8466e0" }; // ΔE 12.1
const SET_C: ThemeSeries = { s1: "#2b83d9", s2: "#c94fb0", s3: "#159a86", s4: "#7d6ae0" }; // ΔE 13.3
const SET_D: ThemeSeries = { s1: "#12a07f", s2: "#8b6fe8", s3: "#d8479a", s4: "#3d8bfd" }; // ΔE 33.9(A 的重排)
const SET_LIGHT: ThemeSeries = { s1: "#0891b2", s2: "#be2d8a", s3: "#6d28d9", s4: "#0d9488" }; // 亮色 ΔE 19.0

export const THEMES: Theme[] = [
  // 1) 深空霓虹 —— 现有「赛博霓虹」演进:深紫黑底 + 青/品红双霓虹 + 渐变描边 + 扫描线
  {
    id: "neon-void",
    name: "深空霓虹",
    tagline: "深紫黑底 · 青×品红双霓虹 · 渐变描边 · 扫描光带",
    mode: "dark",
    bg: "#05040f",
    bgLayers:
      "radial-gradient(900px 420px at 85% -10%, rgba(255,77,210,0.16), transparent 60%)," +
      "radial-gradient(820px 400px at -5% 20%, rgba(0,229,255,0.14), transparent 55%)," +
      "radial-gradient(700px 500px at 50% 118%, rgba(139,111,232,0.12), transparent 60%)",
    panelStyle: "gradientBorder",
    panel: "rgba(13,12,32,0.72)",
    panelBorder: "rgba(0,229,255,0.35)",
    panelShadow: "0 0 32px rgba(0,229,255,0.06), 0 0 60px rgba(255,77,210,0.05)",
    radius: 14,
    text: "#e8f1ff",
    textDim: "#93a7c4",
    primary: "#00e5ff",
    primaryBright: "#7df9ff",
    accent: "#ff4dd2",
    gradient: "linear-gradient(90deg,#00e5ff,#8b6fe8 55%,#ff4dd2)",
    glow: "rgba(0,229,255,0.45)",
    siderBg: "rgba(9,8,24,0.66)",
    siderActiveBg: "rgba(0,229,255,0.14)",
    siderActiveText: "#7df9ff",
    series: SET_A,
    grid: "rgba(147,167,196,0.12)",
    ok: "#2dd4a7",
    running: "#00e5ff",
    stopped: "#93a7c4",
    motif: "scanline",
  },

  // 2) 量子青蓝 —— 现平台主题的通透升级:深蓝黑 + 青蓝单色阶梯 + 玻璃 + 细网格
  {
    id: "quantum-teal",
    name: "量子青蓝",
    tagline: "深蓝黑 · 青蓝单色辉光 · 玻璃拟态 · 通透细网格",
    mode: "dark",
    bg: "#071620",
    bgLayers:
      "radial-gradient(1100px 560px at 80% -12%, rgba(86,224,242,0.15), transparent 60%)," +
      "radial-gradient(900px 520px at -6% 110%, rgba(55,172,205,0.11), transparent 55%)",
    panelStyle: "glass",
    panel: "rgba(12,28,40,0.66)",
    panelBorder: "rgba(86,224,242,0.22)",
    panelShadow: "0 0 24px rgba(34,211,238,0.06), inset 0 1px 0 rgba(255,255,255,0.03)",
    radius: 12,
    text: "#cfe6f0",
    textDim: "#8fb0c2",
    primary: "#22d3ee",
    primaryBright: "#56e0f2",
    accent: "#34d3e0",
    gradient: "linear-gradient(90deg,#22d3ee,#56e0f2)",
    glow: "rgba(34,211,238,0.4)",
    siderBg: "rgba(6,19,32,0.72)",
    siderActiveBg: "rgba(34,211,238,0.16)",
    siderActiveText: "#56e0f2",
    series: SET_D,
    grid: "rgba(86,224,242,0.12)",
    ok: "#2dd4bf",
    running: "#22d3ee",
    stopped: "#7d9bae",
    motif: "grid",
  },

  // 3) 午夜品红 —— 深靛底 + 品红/兰紫主调 + 柔玻璃 + 极光
  {
    id: "midnight-magenta",
    name: "午夜品红",
    tagline: "深靛蓝底 · 品红×兰紫主调 · 柔玻璃 · 极光流光",
    mode: "dark",
    bg: "#0d0818",
    bgLayers:
      "radial-gradient(1000px 520px at 15% -10%, rgba(201,107,255,0.18), transparent 58%)," +
      "radial-gradient(900px 480px at 95% 40%, rgba(255,110,199,0.14), transparent 55%)," +
      "radial-gradient(760px 520px at 50% 120%, rgba(94,84,224,0.12), transparent 60%)",
    panelStyle: "glass",
    panel: "rgba(24,16,42,0.66)",
    panelBorder: "rgba(201,107,255,0.28)",
    panelShadow: "0 0 30px rgba(201,107,255,0.08), inset 0 1px 0 rgba(255,255,255,0.03)",
    radius: 16,
    text: "#f2e9ff",
    textDim: "#b3a0cf",
    primary: "#c96bff",
    primaryBright: "#e0a0ff",
    accent: "#ff6ec7",
    gradient: "linear-gradient(90deg,#ff6ec7,#c96bff 60%,#7d6ae0)",
    glow: "rgba(201,107,255,0.45)",
    siderBg: "rgba(18,12,32,0.72)",
    siderActiveBg: "rgba(201,107,255,0.16)",
    siderActiveText: "#e0a0ff",
    series: SET_C,
    grid: "rgba(179,160,207,0.14)",
    ok: "#2dd4a7",
    running: "#c96bff",
    stopped: "#b3a0cf",
    motif: "aurora",
  },

  // 4) 全息玻璃 —— 冷蓝底 + 虹彩渐变 + 重度磨砂 + 全息网格
  {
    id: "holo-glass",
    name: "全息玻璃",
    tagline: "冷蓝底 · 虹彩渐变描边 · 重度磨砂玻璃 · 全息网格",
    mode: "dark",
    bg: "#0a0f1e",
    bgLayers:
      "radial-gradient(760px 420px at 20% 0%, rgba(125,249,255,0.14), transparent 58%)," +
      "radial-gradient(760px 420px at 82% 12%, rgba(183,139,255,0.14), transparent 58%)," +
      "radial-gradient(680px 480px at 60% 120%, rgba(255,122,217,0.10), transparent 60%)",
    panelStyle: "glass",
    panel: "rgba(20,28,52,0.5)",
    panelBorder: "rgba(125,249,255,0.28)",
    panelShadow: "0 8px 40px rgba(10,15,30,0.5), inset 0 1px 0 rgba(255,255,255,0.06)",
    radius: 18,
    text: "#eaf3ff",
    textDim: "#9db0d0",
    primary: "#7df9ff",
    primaryBright: "#aefcff",
    accent: "#b78bff",
    gradient: "linear-gradient(90deg,#7df9ff,#b78bff 55%,#ff7ad9)",
    glow: "rgba(125,249,255,0.4)",
    siderBg: "rgba(14,20,40,0.5)",
    siderActiveBg: "rgba(125,249,255,0.14)",
    siderActiveText: "#aefcff",
    series: SET_A,
    grid: "rgba(157,176,208,0.14)",
    ok: "#2dd4bf",
    running: "#7df9ff",
    stopped: "#9db0d0",
    motif: "mesh",
  },

  // 5) 极简石墨 —— 近乎单色深灰 + 单一电蓝强调 + 纯平面 + 无纹理(专业克制)
  {
    id: "graphite-mono",
    name: "极简石墨",
    tagline: "石墨深灰 · 单一电蓝强调 · 纯平面无光晕 · 克制专业",
    mode: "dark",
    bg: "#16181d",
    bgLayers: "radial-gradient(1200px 700px at 50% -20%, rgba(77,144,254,0.06), transparent 60%)",
    panelStyle: "solid",
    panel: "#1e2128",
    panelBorder: "#2b2f39",
    panelShadow: "0 1px 2px rgba(0,0,0,0.4)",
    radius: 10,
    text: "#e6e8ec",
    textDim: "#8b909b",
    primary: "#4d90fe",
    primaryBright: "#6ea6ff",
    accent: "#4d90fe",
    gradient: "linear-gradient(90deg,#4d90fe,#6ea6ff)",
    glow: "rgba(77,144,254,0.28)",
    siderBg: "#1a1d23",
    siderActiveBg: "rgba(77,144,254,0.14)",
    siderActiveText: "#6ea6ff",
    series: SET_B,
    grid: "rgba(139,144,155,0.14)",
    ok: "#2dd4a7",
    running: "#4d90fe",
    stopped: "#8b909b",
    motif: "none",
  },

  // 6) 矩阵终端 —— 近黑底 + 青绿终端色 + 等宽字 + 扫描线(黑客/CRT)
  {
    id: "matrix-cyan",
    name: "矩阵终端",
    tagline: "近黑底 · 青绿终端荧光 · 等宽字体 · CRT 扫描线",
    mode: "dark",
    bg: "#030806",
    bgLayers: "radial-gradient(900px 500px at 50% -10%, rgba(0,255,208,0.10), transparent 60%)",
    panelStyle: "outline",
    panel: "rgba(4,14,11,0.7)",
    panelBorder: "rgba(0,255,208,0.35)",
    panelShadow: "0 0 20px rgba(0,255,208,0.08), inset 0 0 24px rgba(0,255,208,0.03)",
    radius: 6,
    text: "#c6ffe9",
    textDim: "#5f9e88",
    primary: "#00ffd0",
    primaryBright: "#5affe0",
    accent: "#22d3ee",
    gradient: "linear-gradient(90deg,#00ffd0,#22d3ee)",
    glow: "rgba(0,255,208,0.4)",
    siderBg: "rgba(3,10,8,0.8)",
    siderActiveBg: "rgba(0,255,208,0.12)",
    siderActiveText: "#5affe0",
    series: SET_D,
    grid: "rgba(95,158,136,0.16)",
    ok: "#00ffd0",
    running: "#22d3ee",
    stopped: "#5f9e88",
    motif: "matrix",
    mono: true,
  },

  // 7) 晨雾微光 —— 亮色皮肤:柔白/雾蓝 + 深青主色 + 柔阴影 + 点阵
  {
    id: "mist-light",
    name: "晨雾微光",
    tagline: "雾白亮底 · 深青蓝主色 · 柔和阴影 · 点阵纹理(亮色系)",
    mode: "light",
    bg: "#f4f7fc",
    bgLayers:
      "radial-gradient(1000px 520px at 82% -12%, rgba(8,145,178,0.10), transparent 58%)," +
      "radial-gradient(900px 480px at -6% 110%, rgba(109,40,217,0.07), transparent 55%)",
    panelStyle: "solid",
    panel: "#ffffff",
    panelBorder: "#e3e9f2",
    panelShadow: "0 6px 20px rgba(18,38,63,0.06), 0 1px 3px rgba(18,38,63,0.05)",
    radius: 14,
    text: "#152238",
    textDim: "#5c6b82",
    primary: "#0891b2",
    primaryBright: "#0aa6cc",
    accent: "#6d28d9",
    gradient: "linear-gradient(90deg,#0891b2,#6d28d9)",
    glow: "rgba(8,145,178,0.22)",
    siderBg: "#ffffff",
    siderActiveBg: "rgba(8,145,178,0.10)",
    siderActiveText: "#0891b2",
    series: SET_LIGHT,
    grid: "rgba(92,107,130,0.16)",
    ok: "#0d9488",
    running: "#0891b2",
    stopped: "#94a3b8",
    motif: "dots",
  },

  // 8) 赛博网格 Tron —— 纯黑 + 极细霓虹描边 + 网格地平线 + 锐角(几何硬朗)
  {
    id: "tron-grid",
    name: "赛博网格",
    tagline: "纯黑底 · 极细霓虹描边 · 网格地平线 · 锐利几何(Tron)",
    mode: "dark",
    bg: "#000308",
    bgLayers: "radial-gradient(900px 460px at 50% -6%, rgba(24,224,255,0.12), transparent 62%)",
    panelStyle: "outline",
    panel: "rgba(2,8,14,0.62)",
    panelBorder: "rgba(24,224,255,0.5)",
    panelShadow: "0 0 18px rgba(24,224,255,0.1), inset 0 0 30px rgba(24,224,255,0.03)",
    radius: 2,
    text: "#dffbff",
    textDim: "#6f97a6",
    primary: "#18e0ff",
    primaryBright: "#7ef1ff",
    accent: "#ff4dd2",
    gradient: "linear-gradient(90deg,#18e0ff,#7ef1ff)",
    glow: "rgba(24,224,255,0.5)",
    siderBg: "rgba(0,4,10,0.8)",
    siderActiveBg: "rgba(24,224,255,0.12)",
    siderActiveText: "#7ef1ff",
    series: SET_A,
    grid: "rgba(24,224,255,0.14)",
    ok: "#2dd4bf",
    running: "#18e0ff",
    stopped: "#6f97a6",
    motif: "hexgrid",
  },

  // 9) 深海蓝 —— 深海蓝底 + 青绿点缀 + 玻璃 + 波纹光(冷静通透)
  {
    id: "abyss-blue",
    name: "深海蓝",
    tagline: "深海蓝底 · 青绿点缀 · 玻璃面板 · 流动波纹(冷静通透)",
    mode: "dark",
    bg: "#04121f",
    bgLayers:
      "radial-gradient(1100px 560px at 78% -10%, rgba(47,155,255,0.16), transparent 60%)," +
      "radial-gradient(900px 500px at 10% 115%, rgba(55,230,208,0.12), transparent 58%)",
    panelStyle: "glass",
    panel: "rgba(9,28,45,0.6)",
    panelBorder: "rgba(55,230,208,0.24)",
    panelShadow: "0 0 26px rgba(47,155,255,0.08), inset 0 1px 0 rgba(255,255,255,0.03)",
    radius: 14,
    text: "#e3f2ff",
    textDim: "#8bb0c8",
    primary: "#2f9bff",
    primaryBright: "#63b6ff",
    accent: "#37e6d0",
    gradient: "linear-gradient(90deg,#2f9bff,#37e6d0)",
    glow: "rgba(47,155,255,0.42)",
    siderBg: "rgba(6,22,36,0.74)",
    siderActiveBg: "rgba(47,155,255,0.16)",
    siderActiveText: "#63b6ff",
    series: SET_B,
    grid: "rgba(139,176,200,0.14)",
    ok: "#37e6d0",
    running: "#2f9bff",
    stopped: "#8bb0c8",
    motif: "waves",
  },

  // 10) 星云紫 —— 深紫黑 + 兰紫/品红 + 玻璃 + 星云星点(浩瀚宇宙)
  {
    id: "nebula-violet",
    name: "星云紫",
    tagline: "深紫黑 · 兰紫×品红 · 玻璃面板 · 星云星点(浩瀚宇宙)",
    mode: "dark",
    bg: "#0b0620",
    bgLayers:
      "radial-gradient(900px 520px at 25% -8%, rgba(167,139,250,0.2), transparent 58%)," +
      "radial-gradient(820px 460px at 90% 30%, rgba(255,122,217,0.14), transparent 55%)," +
      "radial-gradient(760px 520px at 55% 120%, rgba(88,101,242,0.14), transparent 60%)",
    panelStyle: "glass",
    panel: "rgba(22,16,46,0.62)",
    panelBorder: "rgba(167,139,250,0.3)",
    panelShadow: "0 0 30px rgba(167,139,250,0.1), inset 0 1px 0 rgba(255,255,255,0.04)",
    radius: 16,
    text: "#efeaff",
    textDim: "#ada0d0",
    primary: "#a78bfa",
    primaryBright: "#c4b0ff",
    accent: "#ff7ad9",
    gradient: "linear-gradient(90deg,#a78bfa,#ff7ad9)",
    glow: "rgba(167,139,250,0.45)",
    siderBg: "rgba(16,10,36,0.74)",
    siderActiveBg: "rgba(167,139,250,0.18)",
    siderActiveText: "#c4b0ff",
    series: SET_C,
    grid: "rgba(173,160,208,0.14)",
    ok: "#2dd4bf",
    running: "#a78bfa",
    stopped: "#ada0d0",
    motif: "starfield",
  },

  // 11) 钢蓝拟态 —— 石板蓝灰 + 柔和拟态凸起 + 单蓝强调(新拟物质感)
  {
    id: "steel-neumorph",
    name: "钢蓝拟态",
    tagline: "石板蓝灰 · 柔和凸起拟态 · 单蓝强调 · 立体质感(Neumorphism)",
    mode: "dark",
    bg: "#1a1f2b",
    bgLayers: "radial-gradient(1200px 700px at 50% -20%, rgba(91,141,239,0.07), transparent 60%)",
    panelStyle: "neumorph",
    panel: "#1f2532",
    panelBorder: "rgba(255,255,255,0.04)",
    panelShadow: "8px 8px 18px rgba(0,0,0,0.42), -8px -8px 18px rgba(255,255,255,0.03)",
    radius: 18,
    text: "#dfe5f0",
    textDim: "#8b95aa",
    primary: "#5b8def",
    primaryBright: "#7ea6f5",
    accent: "#37c9c0",
    gradient: "linear-gradient(90deg,#5b8def,#7ea6f5)",
    glow: "rgba(91,141,239,0.3)",
    siderBg: "#1c222e",
    siderActiveBg: "rgba(91,141,239,0.14)",
    siderActiveText: "#7ea6f5",
    series: SET_B,
    grid: "rgba(139,149,170,0.14)",
    ok: "#37c9c0",
    running: "#5b8def",
    stopped: "#8b95aa",
    motif: "none",
  },

  // 12) 全息 HUD —— 深黑蓝 + 青荧光 + 角标/准星/电路 + 等宽(科幻界面)
  {
    id: "holo-hud",
    name: "全息 HUD",
    tagline: "深黑蓝 · 青荧光线框 · 角标准星与电路 · 等宽读数(科幻 HUD)",
    mode: "dark",
    bg: "#030a12",
    bgLayers: "radial-gradient(1000px 520px at 50% -8%, rgba(53,229,255,0.13), transparent 60%)",
    panelStyle: "outline",
    panel: "rgba(4,14,22,0.66)",
    panelBorder: "rgba(53,229,255,0.4)",
    panelShadow: "0 0 20px rgba(53,229,255,0.1), inset 0 0 28px rgba(53,229,255,0.03)",
    radius: 4,
    text: "#d6f6ff",
    textDim: "#6d97a6",
    primary: "#35e5ff",
    primaryBright: "#82f0ff",
    accent: "#8b6fe8",
    gradient: "linear-gradient(90deg,#35e5ff,#82f0ff)",
    glow: "rgba(53,229,255,0.45)",
    siderBg: "rgba(3,10,18,0.8)",
    siderActiveBg: "rgba(53,229,255,0.12)",
    siderActiveText: "#82f0ff",
    series: SET_D,
    grid: "rgba(109,151,166,0.16)",
    ok: "#2dd4bf",
    running: "#35e5ff",
    stopped: "#6d97a6",
    motif: "circuit",
    mono: true,
  },
];

export function themeById(id: string): Theme | undefined {
  return THEMES.find((t) => t.id === id);
}

// ============================================================================
// 全站换肤 API(在上面 12 款 token 之上派生;theme-gallery 与 ThemeProvider 共用)
// ============================================================================

/** 皮肤 = 主题(同一份数据,换个业务名)。 */
export type Skin = Theme;
export const SKINS = THEMES;
export const skinById = themeById;

/** 默认皮肤:现青蓝主题。未切换用户看到的 == 改造前,像素级一致。 */
export const DEFAULT_SKIN_ID = "quantum-teal";

export function resolveSkin(id: string | null | undefined): Skin {
  return (id && themeById(id)) || themeById(DEFAULT_SKIN_ID) || THEMES[0];
}

/**
 * 皮肤 token → 全站 CSS 变量(`--bgp-*`)。挂到根节点后,globals.css / 骨架 / 图表
 * 都读这些变量,故切换皮肤即全站生效。变量名带 bgp 前缀避免与 antd/预览页(--tg-*)冲突。
 */
export function skinToCssVars(s: Skin): Record<string, string> {
  return {
    "--bgp-bg": s.bg,
    "--bgp-panel": s.panel,
    "--bgp-panel-border": s.panelBorder,
    "--bgp-radius": `${s.radius}px`,
    "--bgp-text": s.text,
    "--bgp-text-dim": s.textDim,
    "--bgp-primary": s.primary,
    "--bgp-primary-bright": s.primaryBright,
    "--bgp-accent": s.accent,
    "--bgp-gradient": s.gradient,
    "--bgp-glow": s.glow,
    "--bgp-sider-bg": s.siderBg,
    "--bgp-sider-active-bg": s.siderActiveBg,
    "--bgp-sider-active-text": s.siderActiveText,
    "--bgp-s1": s.series.s1,
    "--bgp-s2": s.series.s2,
    "--bgp-s3": s.series.s3,
    "--bgp-s4": s.series.s4,
    "--bgp-grid": s.grid,
    "--bgp-ok": s.ok,
    "--bgp-running": s.running,
    "--bgp-stopped": s.stopped,
  };
}

/**
 * `<body>` 的完整背景(纯底色 + 光晕层 + 部分母题叠加细网格)。
 * grid / scanline / matrix / hexgrid / circuit 等母题会叠一层细网格,
 * 使 quantum-teal 精确复刻改造前 globals.css 的 body 背景(深蓝黑 + 青蓝光晕 + 44px 网格)。
 */
export function skinBodyBackground(s: Skin): string {
  const gridMotifs = new Set(["grid", "scanline", "matrix", "hexgrid", "circuit", "holo-hud"]);
  const layers: string[] = [];
  if (s.bgLayers) layers.push(s.bgLayers);
  if (gridMotifs.has(s.motif)) {
    layers.push(
      `linear-gradient(${s.grid} 1px, transparent 1px)`,
      `linear-gradient(90deg, ${s.grid} 1px, transparent 1px)`,
    );
  }
  layers.push(s.bg);
  return layers.join(", ");
}

/** body 背景对应的 background-size(与 skinBodyBackground 的层数一一对应)。 */
export function skinBodyBackgroundSize(s: Skin): string {
  const gridMotifs = new Set(["grid", "scanline", "matrix", "hexgrid", "circuit", "holo-hud"]);
  const sizes: string[] = [];
  if (s.bgLayers) sizes.push("auto");
  if (gridMotifs.has(s.motif)) sizes.push("44px 44px", "44px 44px");
  sizes.push("auto");
  return sizes.join(", ");
}
