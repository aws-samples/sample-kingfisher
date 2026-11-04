// 序 46 B-107 → 模块 55 —— 页面侧 AI 调用的统一取数(零服务端 import,只给浏览器组件用)。
//
// 2026-10-21 序 50 起这里是**薄壳**:202 → 终态的跟踪搬到了全局 fetch 拦截器(lib/auth/AuthProvider.tsx →
// lib/long-ops/client/follow.ts,所有 `/api/` 下请求的必经之路),本函数拿到的响应已经是终态同形信封;
// 它只剩 B-107 原有的另一半职责:先 `text()` 再解析,非 JSON(网关错误页)一律包成 `{ success:false, error:{ message } }`,
// 文案说清是网关超时还是别的 HTTP 状态。七个 AI 页面调用点的形状不变:`const d = await aiFetchJson(url, init)` ⇒ `d.success ? d.data : d.error.message`。

// 序 49 ⑨ B-110:非 JSON 文案的唯一作者在 lib/http/non-json-envelope(全局 fetch 拦截器也用它),这里只 import。
import { describeNonJson } from "@/lib/http/non-json-envelope";

export interface AiErrorBody {
  success: false;
  error: { message: string; code?: string; detail?: unknown };
  /** 原 HTTP 状态(非 JSON 响应 / 终态失败时也给,便于页面与判据分辨 504 与 500) */
  status?: number;
  /** 响应体不是 JSON(网关错误页) */
  nonJson?: true;
}
export interface AiOkBody<T = unknown> {
  success: true;
  data: T;
  _meta?: Record<string, unknown>;
}
export type AiJsonBody<T = unknown> = AiOkBody<T> | AiErrorBody;

/** 把一次响应读成信封:非 JSON 不再抛,包成 success:false。 */
export async function readJsonEnvelope(res: Response): Promise<AiJsonBody> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as AiJsonBody;
    if (parsed && typeof parsed === "object" && "success" in parsed) {
      if (parsed.success === false) return { ...parsed, status: res.status };
      return parsed;
    }
    return { success: false, status: res.status, nonJson: true, error: { message: describeNonJson(res.status) } };
  } catch {
    return { success: false, status: res.status, nonJson: true, error: { message: describeNonJson(res.status) } };
  }
}

/**
 * 发一次 AI 调用并拿到终态信封。200 ⇒ 原样;非 JSON ⇒ 友好错误。
 * (202 → 终态由全局 fetch 拦截器在本函数拿到响应之前完成;这里不再轮询,也不知道 /api/long-ops 的存在。)
 */
export async function aiFetchJson<T = any>(url: string, init: RequestInit): Promise<AiJsonBody<T>> {
  return readJsonEnvelope(await fetch(url, init)) as Promise<AiJsonBody<T>>;
}
