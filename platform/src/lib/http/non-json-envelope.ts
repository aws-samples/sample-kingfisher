// 序 49 ⑨ B-110 —— 页面拿到「不是 JSON 的 /api 响应」时的唯一作者(零服务端 import,浏览器与判据共用)。
//
// 【缺陷原形(第四十三轮 c,…9435 18:07Z)】平台边缘访问频率规则把一批 `/api/*` 请求拦成 **HTML 403**,CloudFront / ALB 的
//   502 / 504 也是 HTML 页;页面几乎每个调用点都是 `const d = await res.json()` ⇒ 抛 `Unexpected token '<'`,用户只在控制台
//   看到天书、页面无任何可读提示。B-107 的 `aiFetchJson` 只给七条 AI 路由包过(`describeNonJson`),其余 ~300 个调用点裸奔。
// 【根治】不逐个改调用点:`AuthProvider` 的全局 fetch 拦截器(所有 `/api/*` 请求的必经之路)在**状态 ≥ 400 且响应体不是 JSON**
//   时把响应整形成标准错误信封 `{ success:false, error:{ message, code }, status, nonJson:true }`(同状态码、`content-type: application/json`),
//   于是每个调用点原有的 `d?.error?.message || "…失败"` 分支就能把可读文案显示出来。2xx 一律不碰(文件下载 / 流式响应走 /api 也是 2xx)。
//   `aiFetchJson` 的非 JSON 文案从这里 import,两处一个口径。

export const NON_JSON_ERROR_CODES = { gatewayTimeout: "UPSTREAM_TIMEOUT", other: "UPSTREAM_ERROR" } as const;

export interface NonJsonEnvelope {
  success: false;
  error: { message: string; code: (typeof NON_JSON_ERROR_CODES)[keyof typeof NON_JSON_ERROR_CODES] };
  /** 原 HTTP 状态 */
  status: number;
  /** 响应体不是 JSON(网关 / 边缘错误页)—— 轮询类调用方据此当瞬态继续等 */
  nonJson: true;
}

/** 非 JSON 响应的可读文案(按状态码分三类;措辞只写事实)。 */
export function describeNonJson(status: number): string {
  if (status === 403) {
    return `服务响应异常(HTTP 403):请求被平台边缘访问规则暂时拦下(多为同一地址短时间内请求过多),请稍候约 1 分钟再试;若持续出现请联系管理员`;
  }
  if (status === 504 || status === 502 || status === 503) {
    return `服务响应异常(HTTP ${status}):网关超时或上游不可用,请求可能仍在后台继续,请稍后重试`;
  }
  return `服务响应异常(HTTP ${status}):返回的不是 JSON`;
}

export function nonJsonEnvelope(status: number): NonJsonEnvelope {
  return {
    success: false,
    status,
    nonJson: true,
    error: {
      message: describeNonJson(status),
      code: status === 504 ? NON_JSON_ERROR_CODES.gatewayTimeout : NON_JSON_ERROR_CODES.other,
    },
  };
}

export function isJsonContentType(contentType: string | null | undefined): boolean {
  return /^\s*application\/(?:[\w.+-]+\+)?json\b/i.test(contentType || "");
}

/**
 * 把一次 `/api/*` 响应整形:状态 ≥ 400 且不是 JSON ⇒ 同状态码的 JSON 错误信封;其余原样返回(不读 body)。
 * 响应头声明不是 JSON 但正文其实是 JSON(上游没写对 content-type)⇒ 原样放行,正文一个字节不改。
 */
export async function normalizeApiResponse(res: Response): Promise<Response> {
  if (res.status < 400) return res;
  if (isJsonContentType(res.headers.get("content-type"))) return res;
  let text = "";
  try {
    text = await res.clone().text();
  } catch {
    return res;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return res;
  } catch {
    // 不是 JSON ⇒ 下面整形
  }
  const headers = new Headers(res.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.delete("content-length");
  return new Response(JSON.stringify(nonJsonEnvelope(res.status)), { status: res.status, statusText: res.statusText, headers });
}
