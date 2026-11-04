// 风格体验目录的主题数据 —— 已提升为全站单一事实源 `@/lib/skins/skins`。
// 本文件仅作再导出,保持 theme-gallery 内既有 import 路径不变(themes.ts)。
export type { Theme, ThemeSeries, PanelStyle, Motif, Skin } from "@/lib/skins/skins";
export { THEMES, themeById, SKINS, skinById, DEFAULT_SKIN_ID } from "@/lib/skins/skins";
