// @kf-batch 42-ux-feedback(用户 2026-10-15:「多 tab 需要增加选项,关闭其它 tab,否则要一个一个点击关闭」)
// 多页签**批量关闭**的纯规则 —— 单一作者,零 React / 零 antd / 零 next,组件 MultiTabs.tsx 与单测共用。
//   · 关闭其它:只留被右键的那一页;· 关闭右侧:关掉它右边的全部;· 关闭全部:只留首页 `/`(页签不能为空;首页一直是回家的锚)。
//   当前页被关掉才需要跳转(others / right 跳锚点,all 跳首页);锚点不在页签里(竞态)⇒ 原样返回。
export interface TabItem {
  path: string;
}

export type CloseTabsMode = "others" | "right" | "all";
export const HOME_TAB_PATH = "/";

/** 返回 `{ keep, goto }`:`keep` 是关完后剩下的页签(保序),`goto` 是需要跳转到的路径(当前页还在就是 null)。 */
export function closeTabsBy(tabs: TabItem[], anchorPath: string, mode: CloseTabsMode, currentPath: string): { keep: TabItem[]; goto: string | null } {
  const idx = tabs.findIndex((tb) => tb.path === anchorPath);
  let keep: TabItem[];
  if (mode === "others") keep = idx < 0 ? tabs : [tabs[idx]];
  else if (mode === "right") keep = idx < 0 ? tabs : tabs.slice(0, idx + 1);
  else keep = tabs.filter((tb) => tb.path === HOME_TAB_PATH);
  if (keep.length === 0) keep = [{ path: HOME_TAB_PATH }];
  const stillOpen = keep.some((tb) => tb.path === currentPath);
  const goto = stillOpen ? null : (mode === "all" ? HOME_TAB_PATH : anchorPath);
  return { keep, goto };
}
