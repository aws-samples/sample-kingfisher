"use client";

// 内容区多页签(keep-alive):每访问一个路由开一个页签,切换菜单不卸载已打开页面,
// 页签可关闭、可切回,上一个页面的表单/滚动等状态原样保留(企业后台常见形态)。
//
// keep-alive 原理:App Router 下 layout 的 children 是随当前路由变化的 LayoutRouter,
// 直接缓存元素引用切回时仍会渲染"当前路由"。FrozenRouter 把每个页签首挂时的
// LayoutRouterContext 冻结,配合 antd Tabs 非激活页签不销毁(display:none),
// 每个页签就固定渲染自己的路由子树。
//
// @kf-batch 42-ux-feedback(用户 2026-10-15:「多 tab 需要增加选项,关闭其它 tab,否则要一个一个点击关闭」)
//   页签标题上右键 ⇒ 菜单「关闭其它 / 关闭右侧 / 关闭全部」。规则(闭合,单测钉住 `closeTabsBy`):
//   · 关闭其它:只留被右键的那一页,并切到它;· 关闭右侧:关掉它右边的全部,当前页在被关的那些里就切到它;
//   · 关闭全部:全部关掉只留**首页 `/`**(页签不能为空;首页一直是回家的锚)并切到首页。
//   页签至少保留一个 —— 与单个关闭的既有规则一致。
import React, { useContext, useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Dropdown, Tabs } from "antd";
import type { MenuProps } from "antd";
import { LayoutRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { routeLabelParts } from "./routes";
import { useT } from "@/lib/i18n/useT";
import { closeTabsBy, HOME_TAB_PATH, type CloseTabsMode, type TabItem } from "./multitabs-close";

function FrozenRouter({ children }: { children: React.ReactNode }) {
  const context = useContext(LayoutRouterContext);
  const frozen = useRef(context).current;
  if (!frozen) return <>{children}</>;
  return <LayoutRouterContext.Provider value={frozen}>{children}</LayoutRouterContext.Provider>;
}

export default function MultiTabs({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const t = useT();
  // 页签只存 path;标题在渲染时按当前语种翻译,故切换语言标题也随之更新。
  const [tabs, setTabs] = React.useState<TabItem[]>([{ path: pathname }]);
  // 每个页签缓存自己路由的 children 元素引用(同引用 → React 保留 fiber 与组件状态)
  const nodesRef = useRef(new Map<string, React.ReactNode>());
  nodesRef.current.set(pathname, children);

  // 路由 → 页签标题:翻译菜单 label + 「·详情」后缀(业务详情页仅标注归属,不翻数据)。
  const tabLabel = (path: string): string => {
    const { base, detail } = routeLabelParts(path);
    return detail ? `${t(base)}·${t("详情")}` : t(base);
  };

  useEffect(() => {
    setTabs((prev) => (prev.some((tb) => tb.path === pathname) ? prev : [...prev, { path: pathname }]));
  }, [pathname]);

  const closeTab = (path: string) => {
    setTabs((prev) => {
      if (prev.length <= 1) return prev;
      const idx = prev.findIndex((tb) => tb.path === path);
      if (idx < 0) return prev;
      const next = prev.filter((tb) => tb.path !== path);
      nodesRef.current.delete(path);
      // 关的是当前页签 → 跳到左邻(没有则右邻)
      if (path === pathname) router.push(next[Math.max(0, idx - 1)].path);
      return next;
    });
  };

  const closeMany = (anchorPath: string, mode: CloseTabsMode) => {
    setTabs((prev) => {
      const { keep, goto } = closeTabsBy(prev, anchorPath, mode, pathname);
      const keepSet = new Set(keep.map((tb) => tb.path));
      for (const tb of prev) if (!keepSet.has(tb.path)) nodesRef.current.delete(tb.path);
      if (goto) router.push(goto);
      return keep;
    });
  };

  // 🔴 菜单项的点击必须 stopPropagation:Dropdown 的菜单虽然渲染在 portal 里,React 合成事件仍沿 **React 树**冒泡到 antd Tabs 的 tab 节点,
  //   被当成「点了这个页签」⇒ Tabs onChange(anchor) ⇒ router.push(anchor) 压过 closeMany 的 router.push("/")。
  //   「关闭其它 / 右侧」的 goto 恰好就是 anchor 所以看不出来;「关闭全部」从**非当前**页签发起就会落到被右键的那一页而不是首页
  //   (2026-10-15 …7698 页面驱动 p42b T1-c 抓到;探针 probe_tabs_closeall:当前页签发起 ⇒ 对,非当前 ⇒ 错)。
  const act = (mode: CloseTabsMode, tb: TabItem): NonNullable<MenuProps["onClick"]> => ({ domEvent }) => {
    domEvent.stopPropagation();
    closeMany(tb.path, mode);
  };
  const menuFor = (tb: TabItem, index: number): MenuProps["items"] => [
    { key: "others", label: <span data-testid="multitab-close-others">{t("关闭其它")}</span>, disabled: tabs.length <= 1, onClick: act("others", tb) },
    { key: "right", label: <span data-testid="multitab-close-right">{t("关闭右侧")}</span>, disabled: index >= tabs.length - 1, onClick: act("right", tb) },
    { key: "all", label: <span data-testid="multitab-close-all">{t("关闭全部")}</span>, disabled: tabs.length <= 1 && tabs[0]?.path === HOME_TAB_PATH, onClick: act("all", tb) },
  ];

  return (
    <Tabs
      className="bgp-multitabs"
      type="editable-card"
      hideAdd
      size="small"
      activeKey={pathname}
      onChange={(key) => router.push(key)}
      onEdit={(key, action) => {
        if (action === "remove" && typeof key === "string") closeTab(key);
      }}
      items={tabs.map((tb, i) => ({
        key: tb.path,
        // 右键页签标题 ⇒ 批量关闭菜单(左键照旧切换页签)
        label: (
          <Dropdown trigger={["contextMenu"]} menu={{ items: menuFor(tb, i) }}>
            <span data-testid="multitab-label" data-path={tb.path}>{tabLabel(tb.path)}</span>
          </Dropdown>
        ),
        closable: tabs.length > 1,
        children: (
          <FrozenRouter>{nodesRef.current.get(tb.path)}</FrozenRouter>
        ),
      }))}
    />
  );
}
