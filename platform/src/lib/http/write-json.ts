// 页面「保存 / 提交」动作**读应答**的唯一作者(零服务端 import;浏览器与判据共用)。与 `delete-json.ts` 是一对。
//
// 【缺陷原形(2026-11-26 读代码)】编排画布「保存」= `await fetch(PUT); message.success("已保存")`,完全不看应答:
//   服务端拒绝(内容太大、没有权限、对象正被另一个长操作占用……)时页面照样提示「已保存」并把画布标成没有未保存的改动,
//   用户离开页面内容就丢了。同形:画布「发布」前的静默保存(没存上却发布了旧画布)、「应用调度」写 cron、「下游依赖」、
//   数仓查询页「保存查询」、任务监控「调度配置」改 cron。
// 【根治】一个读法:读 JSON 信封(全局拦截器已把非 JSON 的 /api 错误页整形成 `{ success:false, error:{ message, code } }`);
//   非 2xx / `success === false` ⇒ 抛 `WriteRejected`(服务端原话 + code + HTTP 状态),页面只做 `message.error(e.message)`;
//   **成功才**提示「已保存」。2xx 无正文(204)视为成功。守卫(write-json-guard)钉住「页面里把写请求的应答丢掉」的调用点只减不增。
import { errorCodeOf, errorMessageOf } from "./error-envelope";

export class WriteRejected extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "WriteRejected";
  }
}

type Envelope = { success?: boolean; error?: { message?: string; code?: string } | string; [k: string]: unknown };

export type WriteMethod = "POST" | "PUT" | "PATCH";

/**
 * 发一次带 JSON 请求体的写请求并按标准信封判成败;失败抛 WriteRejected(带服务端原话),成功返回信封(204 ⇒ `{}`)。
 * `payload` 为 `undefined` 时不带请求体(例如「触发」「发布」这类动作)。
 */
export async function writeJson<T extends Record<string, unknown> = Record<string, unknown>>(
  url: string,
  method: WriteMethod,
  payload?: unknown,
  init: Omit<RequestInit, "method" | "body"> = {}
): Promise<T> {
  const hasBody = payload !== undefined;
  const res = await fetch(url, {
    ...init,
    method,
    ...(hasBody ? { headers: { "Content-Type": "application/json", ...(init.headers || {}) }, body: JSON.stringify(payload) } : {}),
  });
  let body: Envelope | null = null;
  try {
    body = (await res.json()) as Envelope;
  } catch {
    body = null;
  }
  // 成败只看 HTTP 状态与信封的 `success`:不少保存路由成功时直接回保存后的那一行(没有信封),
  // 而行上可以合法地带一个叫 `error` 的字段(同步任务上一次失败的原因)—— 不许拿它把一次成功的保存判成失败。
  if (!res.ok || (body !== null && body.success === false)) {
    throw new WriteRejected(errorMessageOf(body, `保存失败(HTTP ${res.status})`), res.status, errorCodeOf(body));
  }
  return (body ?? {}) as T;
}
