// @kf-batch 53-guide-tour-reach
// 导览锚点的**可达性**规则(纯逻辑,单一作者)。
//
// 🔴 为什么需要这一层(WP-21 部署前勘定源码抓到的真缺口):
//   左侧菜单是 antd 的 inline Menu,分类(SubMenu)**收起时子项压根不在 DOM 里**
//   (`@rc-component/menu` 的 InlineSubMenuList:`forceRender: forceSubMenuRender`,默认 false;
//    首次展开后 `removeOnLeave: false` 会把它留在 DOM 但 `display:none` ⇒ rect 0×0)。
//   而导览每一步几乎都是「先点左侧菜单进这一页」⇒ 锚点 `nav-<path>` 在分类没展开时:
//     · 从没展开过 ⇒ 元素不存在 ⇒ 导览第一步就报「控件不在页面上」(对新用户等于导览是废的);
//     · 展开过又收起 ⇒ 元素在、但 0×0 且不可见 ⇒ **聚光灯静默打在错的位置**(比报错更坏)。
//   根治 = 导览走到哪一步,Sidebar 就把**那一步所属的分类**打开(声明式,不合成点击);
//   「元素在但不可见」由 `anchorIsUsable` 一并判成「不在页面上」(见 tour.ts)。
//
// 🔴 为什么不把菜单树 import 进来:`components/layout/routes.tsx` 带 JSX 图标,而本仓 vitest
//   是 `environment: node` + tsconfig `jsx: preserve` ⇒ 测试里 import .tsx 直接解析失败。
//   所以规则做成**把树当参数传进来**的纯函数:Sidebar 传真实 `menuTree`,单测传夹具树 + 从
//   routes.tsx 文本解析出的真实分类表(两头都能验,且不给运行期加任何依赖)。

/** 只要 key 与(可选的)children.key —— 刻意不要求图标/标签,便于测试与复用。 */
export interface NavNodeLike {
  key: string;
  children?: ReadonlyArray<{ key: string }>;
}

/** 某个路由属于哪个分类;顶层叶子返回 undefined(它不需要展开任何分类)。 */
export function parentGroupKeyOf(tree: readonly NavNodeLike[], path: string): string | undefined {
  for (const n of tree) {
    if (n.children?.some((c) => c.key === path)) return n.key;
  }
  return undefined;
}

/**
 * 把 `path` 所属的分类并进已展开集合。
 * 🔴 **无需变更时返回原数组引用** —— 每次都造新数组会让 `setOpenKeys` 每轮 effect 都刷新一次状态
 * (菜单动画反复重播;也让「用户手动收起的分类」被无谓地重置)。
 */
export function withParentGroupOpen(
  tree: readonly NavNodeLike[],
  prev: readonly string[],
  path: string | null | undefined
): string[] {
  if (!path) return prev as string[];
  const p = parentGroupKeyOf(tree, path);
  if (!p || prev.includes(p)) return prev as string[];
  return [...prev, p];
}
