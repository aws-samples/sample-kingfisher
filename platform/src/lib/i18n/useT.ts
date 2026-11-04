"use client";

// 便捷 hook —— 各组件顶部 `const t = useT();` 后即可 t("中文") / t("共 {n} 条", { n })。
// useLocale() 供需要读当前语种/切换语种的场景(如语言选择器、antd ConfigProvider 联动)。

import { useI18n } from "./I18nProvider";
import type { TransParams } from "./translate";
import type { Locale } from "./locales";

export function useT(): (zh: string, params?: TransParams) => string {
  return useI18n().t;
}

export function useLocale(): { locale: Locale; setLocale: (l: Locale) => void } {
  const { locale, setLocale } = useI18n();
  return { locale, setLocale };
}
