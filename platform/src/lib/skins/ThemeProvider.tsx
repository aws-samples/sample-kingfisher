"use client";

// 全站换肤内核 —— 持有当前皮肤、localStorage 持久化、注入 CSS 变量 + body 背景、生成 antd 主题。
//
// 无闪烁策略:SSR 与首帧都用 DEFAULT_SKIN_ID(现青蓝)渲染,与服务端一致;挂载后从
// localStorage 读回用户选择并应用。故未切换用户全程看到现青蓝,已切换用户在首帧后瞬间应用。
// 一个 <head> 内联脚本在 React 之前先把已存皮肤的 body 背景刷上,进一步消除深色→其它色的闪动
// (脚本与存储键定义在 ./early-skin-script —— 普通模块;根布局是服务端组件,不能从本文件这种客户端模块取值)。

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";
import { useLocale } from "@/lib/i18n/useT";
import {
  DEFAULT_SKIN_ID,
  resolveSkin,
  skinToCssVars,
  skinBodyBackground,
  skinBodyBackgroundSize,
  SKINS,
  type Skin,
} from "./skins";
import { skinToAntdTheme } from "./antdTheme";
import { SKIN_STORAGE_KEY } from "./early-skin-script";

interface SkinCtx {
  skinId: string;
  skin: Skin;
  setSkinId: (id: string) => void;
  skins: Skin[];
}

const Ctx = createContext<SkinCtx | null>(null);

export function useSkin(): SkinCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSkin 必须在 <ThemeProvider> 内使用");
  return c;
}

/** 把皮肤应用到真实 DOM:根节点 CSS 变量 + body 背景 + mode 标记。 */
function applySkinToDom(skin: Skin) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const vars = skinToCssVars(skin);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.style.setProperty("--bgp-body-bg", skinBodyBackground(skin));
  root.style.setProperty("--bgp-body-bg-size", skinBodyBackgroundSize(skin));
  root.setAttribute("data-skin", skin.id);
  root.setAttribute("data-skin-mode", skin.mode);
  document.body.style.background = skinBodyBackground(skin);
  document.body.style.backgroundSize = skinBodyBackgroundSize(skin);
  document.body.style.backgroundAttachment = "fixed";
  document.body.style.color = skin.text;
}

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  // 首帧固定默认皮肤(= SSR),避免水合不一致;挂载后再切到已存皮肤。
  const [skinId, setSkinIdState] = useState<string>(DEFAULT_SKIN_ID);

  // 挂载:读 localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SKIN_STORAGE_KEY);
      if (saved && saved !== skinId && SKINS.some((s) => s.id === saved)) {
        setSkinIdState(saved);
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const skin = useMemo(() => resolveSkin(skinId), [skinId]);

  // 皮肤变化 → 刷 DOM
  useEffect(() => {
    applySkinToDom(skin);
  }, [skin]);

  const setSkinId = useCallback((id: string) => {
    setSkinIdState(id);
    try {
      localStorage.setItem(SKIN_STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
  }, []);

  const antdConfig = useMemo(() => skinToAntdTheme(skin), [skin]);

  // i18n:antd 内置文案(分页/表格空态/Popconfirm 按钮/表单校验等)随语种整批切换。
  const { locale } = useLocale();

  const ctx: SkinCtx = useMemo(
    () => ({ skinId, skin, setSkinId, skins: SKINS }),
    [skinId, skin, setSkinId],
  );

  return (
    <Ctx.Provider value={ctx}>
      <ConfigProvider locale={locale === "en" ? enUS : zhCN} theme={antdConfig}>
        {children}
      </ConfigProvider>
    </Ctx.Provider>
  );
}
