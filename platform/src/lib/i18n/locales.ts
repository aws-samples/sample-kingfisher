// 国际化(i18n)独立模块 —— 语种类型与常量的单一事实源。
//
// 顶层设计(见 docs/design 或 RESUME):首版支持中/英双语,**默认中文**;
// 采用「中文源串即 key」策略——t("保存") 命中英文字典则显英文,未命中原样返回中文,
// 故任何未覆盖/出错处都优雅降级为中文。zh 模式下 t() 是恒等函数,与改造前像素级一致。

export type Locale = "zh" | "en";

export const SUPPORTED_LOCALES: Locale[] = ["zh", "en"];

// 默认语种:中文(红线——一切不确定/出错都回落中文)。
export const DEFAULT_LOCALE: Locale = "zh";

// localStorage key(沿用项目 bgp-* 前缀约定,见 lib/projects/active.ts)。
export const LOCALE_STORAGE_KEY = "bgp-locale";

// 语种展示名(下拉里用;各自用本语言书写,符合语言选择器惯例)。
export const LOCALE_LABELS: Record<Locale, string> = {
  zh: "简体中文",
  en: "English",
};

// 英语区国家/地区集合(ISO 3166-1 alpha-2)。IP→国家命中则建议 en,否则 zh。
// 覆盖主要英语母语区;非英语区一律默认中文(用户明确要求)。
export const ENGLISH_COUNTRIES = new Set<string>([
  "US", // 美国
  "GB", // 英国
  "AU", // 澳大利亚
  "CA", // 加拿大(含法语区,粗粒度按国家判定,够用)
  "NZ", // 新西兰
  "IE", // 爱尔兰
  "SG", // 新加坡(官方语言含英语)
  "ZA", // 南非
  "IN", // 印度(英语为官方语言之一)
  "PH", // 菲律宾
  "NG", // 尼日利亚
  "KE", // 肯尼亚
  "GH", // 加纳
  "JM", // 牙买加
  "TT", // 特立尼达和多巴哥
]);

// 把类型不定的输入规整为受支持的 Locale;非法值回落默认中文。
export function coerceLocale(v: unknown): Locale {
  return v === "en" ? "en" : "zh";
}

// 由国家码判定建议语种:英语区→en,其余(含未知)→zh。
export function localeForCountry(country: string | null | undefined): Locale {
  if (country && ENGLISH_COUNTRIES.has(country.toUpperCase())) return "en";
  return "zh";
}
