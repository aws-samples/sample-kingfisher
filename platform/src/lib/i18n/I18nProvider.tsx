"use client";

// i18n 运行时内核 —— 持有当前 locale、检测/持久化、提供 useLocale/useT。
//
// 无闪烁 & SSR 安全策略(与换肤 ThemeProvider 同哲学):
//   - SSR 与首帧都用 DEFAULT_LOCALE(中文)渲染,与服务端 <html lang="zh-CN"> 一致,
//     避免水合不一致;挂载后再按优先级切换,故 en 用户仅首帧一瞬中文,zh 用户全程无感。
//   - 检测优先级:localStorage(用户手动选过) > /api/public/locale(IP→国家建议) > 中文。
//   - 无模块级可变全局,locale 随 React 树流动,天然多请求隔离。

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  coerceLocale,
  type Locale,
} from "./locales";
import { translate, type TransParams } from "./translate";

interface I18nCtx {
  locale: Locale;
  setLocale: (l: Locale) => void;
  // 绑定当前 locale 的翻译函数:t("保存")、t("共 {n} 条", { n })。
  t: (zh: string, params?: TransParams) => string;
}

const Ctx = createContext<I18nCtx | null>(null);

export function useI18n(): I18nCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useI18n / useT 必须在 <I18nProvider> 内使用");
  return c;
}

export default function I18nProvider({ children }: { children: React.ReactNode }) {
  // 首帧固定默认中文(= SSR),挂载后再检测,避免水合不一致。
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  // 挂载:先读 localStorage;没有则问 /api/public/locale(IP→国家建议)。
  useEffect(() => {
    let cancelled = false;
    try {
      const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
      if (saved && SUPPORTED_LOCALES.includes(saved as Locale)) {
        setLocaleState(saved as Locale);
        return; // 用户显式选择优先,不再问 IP
      }
    } catch {
      /* ignore */
    }
    // 未手动选过 → 询问后端按访客 IP 建议(失败静默回落默认中文)。
    (async () => {
      try {
        const res = await fetch("/api/public/locale", { cache: "no-store" });
        const d = await res.json();
        const suggested = coerceLocale(d?.data?.suggestedLocale);
        if (!cancelled && suggested !== DEFAULT_LOCALE) setLocaleState(suggested);
      } catch {
        /* 网络/接口异常 → 保持默认中文 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // locale 变化 → 同步 <html lang>(利于可访问性/浏览器翻译提示)。
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
    }
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);

  const t = useCallback(
    (zh: string, params?: TransParams) => translate(zh, locale, params),
    [locale],
  );

  const ctx: I18nCtx = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}
