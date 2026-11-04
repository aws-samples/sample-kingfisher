"use client";

import React, { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Layout, Menu } from "antd";
import { useAuth } from "@/lib/auth/AuthProvider";
import { groupsFromToken, isAnalystOnly } from "@/lib/auth/roles";
import { menuTree, isGroup, type Node } from "./routes";
// @kf-batch 53-guide-tour-reach —— 导览锚点可达性(收起的菜单分类里子项不在 DOM ⇒ 锚点找不到)
import { useGuide } from "@/components/guide/GuideProvider";
import { tourStepAt } from "@/lib/guide/tour";
import { withParentGroupOpen } from "@/lib/guide/nav-open";
import KingfisherLogo from "./KingfisherLogo";
import { useT } from "@/lib/i18n/useT";

const { Sider } = Layout;

// 找到某路由所属分类的 key（用于自动展开）。
// 🔴 规则本体搬到 `lib/guide/nav-open.ts`（纯函数、可单测）—— 这里只做「把真实菜单树喂给它」。
//    同一条规则有两个消费者（切页自动展开 / 导览当前步),两处各写一遍必然漂移(change-safety A1)。
function parentKeyOf(pathname: string): string | undefined {
  const opened = withParentGroupOpen(menuTree, [], pathname);
  return opened[0];
}

// 运营分析账号：仅保留「智能分析」下的智能问数 + 需求工作台，其余分类不展示。
function filterForAnalyst(tree: Node[]): Node[] {
  const allow = new Set(["/genbi", "/requirements"]);
  const out: Node[] = [];
  for (const n of tree) {
    if (isGroup(n)) {
      const kids = n.children.filter((c) => allow.has(c.key));
      if (kids.length) out.push({ ...n, children: kids });
    } else if (allow.has(n.key)) {
      out.push(n);
    }
  }
  return out;
}

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const t = useT();
  const { getToken } = useAuth();
  const [analyst, setAnalyst] = useState(false);
  const [openKeys, setOpenKeys] = useState<string[]>(() => {
    const p = parentKeyOf(pathname);
    return p ? [p] : [];
  });
  // 皮肤 mode 感知:菜单 theme 跟随当前皮肤(light 皮肤如「晨雾微光」需 light 菜单,否则菜单仍深色=bug)。
  // ThemeProvider 在 <html data-skin-mode> 标记 light/dark;MutationObserver 观察换肤实时切换(不改 ThemeProvider)。
  const [skinMode, setSkinMode] = useState<"light" | "dark">("dark");
  useEffect(() => {
    const read = () => {
      const m = document.documentElement.getAttribute("data-skin-mode");
      setSkinMode(m === "light" ? "light" : "dark");
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin-mode"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    (async () => {
      const groups = groupsFromToken(await getToken());
      setAnalyst(isAnalystOnly(groups));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换页面时，自动展开当前页所属的大类（保留用户已展开的其它类）。
  useEffect(() => {
    setOpenKeys((prev) => withParentGroupOpen(menuTree, prev, pathname));
  }, [pathname]);

  // @kf-batch 53-guide-tour-reach
  // 🔴🔴 导览走到哪一步，就把**那一步的菜单锚点**变成真的看得见的：
  //   ① 展开它所属的分类 —— antd inline 菜单**收起的分类子项压根不在 DOM 里**
  //      (真环境实测:首次进站 7 个分类全收起 ⇒ `nav-/sync` count=0 ⇒ 导览第一步就报「控件不在页面上」);
  //   ② 取消侧栏收起 —— 收起态菜单只剩图标，锚点那个 span 不可见（聚光灯会打在错的位置）。
  // 这不是「替用户点」：它没有产生任何业务副作用，只是把要讲的那一项**露出来**（GT-6 仍要求全程零写请求）。
  const { tourJourney, tourIndex } = useGuide();
  const tourStepPath = tourStepAt(tourJourney, tourIndex)?.path ?? null;
  useEffect(() => {
    if (!tourStepPath) return;
    setCollapsed(false);
    setOpenKeys((prev) => withParentGroupOpen(menuTree, prev, tourStepPath));
  }, [tourStepPath]);

  // menuTree 的 label 是中文源串(作字典 key);渲染处按当前语种翻译,routes.tsx 不动。
  // @kf-batch 53-guide-tour
  // 🔴 每个菜单项的 label 包一层带 `data-testid="nav-<key>"` 的 span —— **新手导览的锚点**。
  //    为什么锚在这里:导览的每一步几乎都要先说「点左侧的 X 进这一页」,而全站 31 个菜单叶子
  //    在这一处一次性获得稳定锚点(逐页给主按钮加 testid 要改十几个文件,且仍然缺导航那一步)。
  // 🔴 为什么不用 antd 的 `data-menu-id`:那是**框架内部属性**(记忆 antd-headless-select-pitfalls:
  //    赌框架内部属性就要接受它随版本变);自己的 testid 由本仓 routes.tsx 的 key 派生,是单一真值。
  const navLabel = (key: string, label: string) => <span data-testid={`nav-${key}`}>{t(label)}</span>;
  const localize = (tree: Node[]): any[] =>
    tree.map((n) =>
      isGroup(n)
        ? { key: n.key, icon: n.icon, label: t(n.label), children: n.children.map((c) => ({ key: c.key, icon: c.icon, label: navLabel(c.key, c.label) })) }
        : { key: n.key, icon: n.icon, label: navLabel(n.key, n.label) },
    );
  const items = localize(analyst ? filterForAnalyst(menuTree) : menuTree);

  return (
    <Sider collapsible collapsed={collapsed} onCollapse={setCollapsed}
      style={{ height: "100vh", position: "sticky", top: 0 }}>
      <div style={{ height: 40, margin: "14px 16px", display: "flex", alignItems: "center", justifyContent: "center", gap: 9, flexShrink: 0 }}>
        <KingfisherLogo size={collapsed ? 30 : 26} />
        {!collapsed && (
          <span style={{ color: "var(--bgp-text, #fff)", fontWeight: 700, fontSize: 17, letterSpacing: 0.5 }}>Kingfisher</span>
        )}
      </div>
      {/* 菜单区独立滚动:分类全展开超出视口时上下滚,收起按钮不被挤走 */}
      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }} className="bgp-sider-scroll">
        <Menu
          theme={skinMode}
          mode="inline"
          selectedKeys={[pathname]}
          openKeys={collapsed ? undefined : openKeys}
          onOpenChange={(keys) => setOpenKeys(keys as string[])}
          items={items}
          onClick={({ key }) => {
            if (typeof key === "string" && key.startsWith("/")) router.push(key);
          }}
        />
      </div>
    </Sider>
  );
}
