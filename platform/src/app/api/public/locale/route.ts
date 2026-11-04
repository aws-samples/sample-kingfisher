export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk } from "@/lib/api-response";
import { localeForCountry, coerceLocale, DEFAULT_LOCALE, type Locale } from "@/lib/i18n/locales";

// PUBLIC(被 middleware /api/public/* 放行,零改 auth):按访客 IP 建议初始语种。
// 判定优先级:CloudFront-Viewer-Country(IP→国家)> Accept-Language > 默认中文。
// 仅返回「建议值」;客户端 localStorage 手动选择始终优先(见 I18nProvider)。
//
// 依赖:CloudFront 需用 ALL_VIEWER_AND_CLOUDFRONT_2022 origin policy 透传国家头
// (见 infra/lib/platform-stack.ts)。未透传时自动回落 Accept-Language,仍可用。

function fromAcceptLanguage(header: string | null): Locale | null {
  if (!header) return null;
  // 取首选语言标签,如 "en-US,en;q=0.9,zh;q=0.8" → "en-us"。
  const primary = header.split(",")[0]?.trim().toLowerCase();
  if (!primary) return null;
  if (primary.startsWith("en")) return "en";
  if (primary.startsWith("zh")) return "zh";
  return null; // 其它语言 → 交由默认(中文)
}

export async function GET(req: NextRequest) {
  const country = req.headers.get("cloudfront-viewer-country");
  let suggested: Locale;

  if (country) {
    suggested = localeForCountry(country);
  } else {
    // 无 CloudFront 国家头(本地/未透传)→ 退回浏览器 Accept-Language。
    suggested = fromAcceptLanguage(req.headers.get("accept-language")) ?? DEFAULT_LOCALE;
  }

  return apiOk({
    suggestedLocale: coerceLocale(suggested),
    country: country || null, // 便于排障/无头验证
  });
}
