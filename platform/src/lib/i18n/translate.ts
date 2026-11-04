// 纯翻译逻辑(不依赖 React,可单测)。
//
// 策略「中文源串即 key」:
//   - zh:恒等返回中文源串(再做插值),与改造前像素级一致、零风险。
//   - en:查英文字典 EN[zh],命中用译文,未命中原样返回中文源串(优雅降级)。
// 插值占位用 {name} 形式:t("共 {n} 条", { n: 12 }) → "共 12 条" / "12 total"。

import type { Locale } from "./locales";
import { EN } from "./messages/en";

export type TransParams = Record<string, string | number>;

// 用 {key} 占位做插值;缺失的占位保持原样(不抛错)。
export function interpolate(template: string, params?: TransParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m,
  );
}

// 核心翻译:zh 恒等 / en 查表降级,末尾统一插值。
export function translate(zh: string, locale: Locale, params?: TransParams): string {
  if (locale === "zh") return interpolate(zh, params);
  const en = EN[zh];
  return interpolate(en ?? zh, params);
}
