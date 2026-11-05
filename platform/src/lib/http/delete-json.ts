// 页面「删除」动作**读响应**的唯一作者(零服务端 import;浏览器与判据共用)。
//
// 【缺陷原形(2026-10-23 …9435 页面驱动段 wp24 首跑抓到)】/sync 列表「删除」= `await fetch(DELETE); message.success("已删除")`,
//   完全不看响应:DMS 通道任务还在建(复制任务 creating)那一刻服务端回 **409 TEARDOWN_IN_PROGRESS**(行不删、通道不撤,这是对的),
//   页面却提示「已删除」、行还在 —— 「页面显示的状态只许来自真正的结论」(AGENTS §11 第 9 条)被破。同形:/datasources ·
//   /etl-jobs 删作业 · /redshift 删任务 · /workflow 四页;其余 23 处各自 `res.json()` 读信封、口径不一(守卫 delete-json-guard 钉清单只减不增)。
//   此前的 API 驱动判据直接打 DELETE 并按 409 重试 ⇒ 永远看不见页面这一层说假话。
// 【根治】一个读法:读 JSON 信封(该缺陷的全局拦截器已把非 JSON 的 /api 错误页整形成 `{success:false,error:{message,code}}`);
//   非 2xx / `success === false` / 带 error ⇒ 抛 `DeleteRejected`(服务端 message 原话 + code + HTTP 状态),页面只做
//   `message.error(e.message)`;**成功才**提示「已删除」。2xx 无正文(204)视为成功。
// 2026-11-04:信封文案 / 错误码的读法只有一个作者(error-envelope.ts),这里不再内联第二份判断。
import { errorCodeOf, errorMessageOf } from "./error-envelope";

export class DeleteRejected extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "DeleteRejected";
  }
}

type Envelope = { success?: boolean; error?: { message?: string; code?: string } | string; [k: string]: unknown };

/** 发 DELETE 并按标准信封判成败;失败抛 DeleteRejected(带服务端原话),成功返回信封(204 ⇒ `{}`)。 */
export async function deleteJson<T extends Record<string, unknown> = Record<string, unknown>>(url: string, init: Omit<RequestInit, "method"> = {}): Promise<T> {
  const res = await fetch(url, { ...init, method: "DELETE" });
  let body: Envelope | null = null;
  try {
    body = (await res.json()) as Envelope;
  } catch {
    body = null;
  }
  const err = body?.error;
  if (!res.ok || (body !== null && (body.success === false || (err !== undefined && body.success !== true)))) {
    throw new DeleteRejected(errorMessageOf(body, `删除失败(HTTP ${res.status})`), res.status, errorCodeOf(body));
  }
  return (body ?? {}) as T;
}
