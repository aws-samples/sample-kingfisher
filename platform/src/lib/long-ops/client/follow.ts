// 模块 55 长操作统一框架 —— 客户端传输层:把一次 202(协议记号 long-op/1)跟到终态,再整形成**与同步响应完全一样的 Response**。
//
// 🔴 零服务端 import(浏览器拦截器与判据共用)。调用方只有一个:lib/auth/AuthProvider.tsx 的全局 fetch 拦截器
//   (所有 same-origin `/api/` 下请求的必经之路)⇒ ~300 个页面调用点一行不改就拿到终态;`aiFetchJson`(B-107)退成薄壳。
// 只认 `data.protocol === "long-op/1"` 的 202:GenBI `{taskId,status:"pending",async:true}` 与 B-95 `{status:"warming"}` 原样放行。
//
// 终态整形(55 DESIGN D5):
//   succeeded ⇒ `resultStatus ?? 200` + `{ success:true, data: result, _meta? }`
//   failed    ⇒ `errorStatus ?? 500` + (`errorBody` 原信封 | `{ success:false, error:{ message, code:"UPSTREAM_ERROR" }, status }`)
//   timeout   ⇒ 504 + `{ success:false, error:{ message: LONG_OP_TIMEOUT_MESSAGE, code:"UPSTREAM_TIMEOUT" }, status:504 }`
// 整形出的 Response 带头 `x-bgp-long-op: <taskId>`(判据据此证明走了 202 路径)。

import { describeNonJson } from "@/lib/http/non-json-envelope";
import {
  LONG_OP_PROTOCOL, LONG_OPS_API, LONG_OP_RESPONSE_HEADER, LONG_OP_TIMEOUT_MESSAGE,
  type LongOpAcceptedBody, type LongOpStateBody,
} from "../protocol";
import { emitLongOpEvent, type LongOpEventDetail } from "./events";

export const LONG_OP_POLL_MS = 2000;
/** 前端总预算:服务端天花板 300s + 余量;正常服务端会先回 timeout。 */
export const LONG_OP_CLIENT_BUDGET_MS = 320_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isJsonContentType(res: Response): boolean {
  return /^\s*application\/(?:[\w.+-]+\+)?json\b/i.test(res.headers.get("content-type") || "");
}

/** 这次响应是不是长操作协议的 202(是 ⇒ 回载荷;不是 ⇒ null,调用方原样放行)。不消耗原 Response 的 body。 */
export async function peekLongOpAccepted(res: Response): Promise<LongOpAcceptedBody | null> {
  if (res.status !== 202 || !isJsonContentType(res)) return null;
  let parsed: unknown;
  try {
    parsed = await res.clone().json();
  } catch {
    return null;
  }
  const data = (parsed as { data?: Record<string, unknown> } | null)?.data;
  if (!data || data.protocol !== LONG_OP_PROTOCOL || typeof data.taskId !== "string") return null;
  return {
    taskId: data.taskId,
    kind: typeof data.kind === "string" ? data.kind : "",
    label: typeof data.label === "string" ? data.label : "",
    status: "running",
    async: true,
    protocol: LONG_OP_PROTOCOL,
  };
}

function jsonResponse(body: unknown, status: number, taskId: string): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  headers.set(LONG_OP_RESPONSE_HEADER, taskId);
  return new Response(JSON.stringify(body), { status, headers });
}

/** 终态 ⇒ 与同步分支同形的 Response(纯函数;判据直接测)。 */
export function terminalToResponse(state: LongOpStateBody, meta?: unknown): Response {
  if (state.status === "succeeded") {
    // resultRaw:执行体给的就是整个响应体(编排四条路由的摊平形状)⇒ 不包信封,与同步分支 `NextResponse.json(data)` 同形
    if (state.resultRaw) return jsonResponse(state.result, state.resultStatus ?? 200, state.taskId);
    return jsonResponse({ success: true, data: state.result, ...(meta ? { _meta: meta } : {}) }, state.resultStatus ?? 200, state.taskId);
  }
  if (state.status === "failed") {
    const status = state.errorStatus ?? 500;
    if (state.errorBody && typeof state.errorBody === "object") return jsonResponse(state.errorBody, status, state.taskId);
    return jsonResponse({ success: false, status, error: { message: state.error || "执行失败", code: "UPSTREAM_ERROR" } }, status, state.taskId);
  }
  return jsonResponse({ success: false, status: 504, error: { message: LONG_OP_TIMEOUT_MESSAGE, code: "UPSTREAM_TIMEOUT" } }, 504, state.taskId);
}

export interface FollowDeps {
  /** 原生 fetch(拦截器传未打补丁的 `orig`,免得轮询再进一次拦截器) */
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  /** 与提交请求同一套头(Authorization / x-bgp-project / x-bgp-env) */
  headers?: HeadersInit;
  pollMs?: number;
  budgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** 事件出口(缺省 DOM CustomEvent;判据注入) */
  emit?: (detail: LongOpEventDetail) => void;
}

/**
 * 跟一个已接受的长操作到终态。永不 reject:网络抖动 / 非 JSON 5xx 视为瞬态继续;服务端明确回 4xx / 5xx JSON(404 / 403 / 500)
 * 就把那个信封原样交回(状态码同);预算耗尽 ⇒ 504 timeout 同形。
 */
export async function followLongOp(accepted: LongOpAcceptedBody, deps: FollowDeps): Promise<Response> {
  const sleep = deps.sleep ?? defaultSleep;
  const emit = deps.emit ?? emitLongOpEvent;
  const pollMs = deps.pollMs ?? LONG_OP_POLL_MS;
  const budgetMs = deps.budgetMs ?? LONG_OP_CLIENT_BUDGET_MS;
  const startedAt = Date.now();
  const base = { taskId: accepted.taskId, kind: accepted.kind, label: accepted.label };
  emit({ ...base, phase: "started", elapsedMs: 0 });
  const settle = (outcome: LongOpEventDetail["outcome"], res: Response): Response => {
    emit({ ...base, phase: "settled", elapsedMs: Date.now() - startedAt, outcome });
    return res;
  };
  while (Date.now() - startedAt < budgetMs) {
    await sleep(pollMs);
    let res: Response;
    try {
      res = await deps.fetchImpl(`${LONG_OPS_API}/${encodeURIComponent(accepted.taskId)}`, { method: "GET", cache: "no-store", headers: deps.headers });
    } catch {
      continue; // 网络抖动:跳过本次,下轮重试
    }
    let parsed: { success?: boolean; data?: LongOpStateBody; _meta?: unknown; error?: unknown } | null = null;
    const text = await res.text().catch(() => "");
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object") {
      // 非 JSON(网关 / 边缘错误页):≥ 400 当瞬态继续等;2xx 却不是 JSON 也只能继续等
      if (res.status >= 400 && res.status !== 404 && res.status !== 403) continue;
      if (res.status === 404 || res.status === 403) {
        return settle("aborted", jsonResponse({ success: false, status: res.status, error: { message: describeNonJson(res.status), code: "UPSTREAM_ERROR" } }, res.status, accepted.taskId));
      }
      continue;
    }
    if (parsed.success === false) {
      // 服务端明确拒绝(任务不存在 / 不是本人 / 读库失败)⇒ 原信封交回,状态码同
      return settle("aborted", jsonResponse(parsed, res.status >= 400 ? res.status : 500, accepted.taskId));
    }
    const state = parsed.data;
    if (!state || typeof state !== "object") continue;
    if (state.status === "succeeded" || state.status === "failed" || state.status === "timeout") {
      return settle(state.status, terminalToResponse({ ...state, taskId: accepted.taskId }, parsed._meta));
    }
    emit({ ...base, phase: "progress", elapsedMs: typeof state.elapsedMs === "number" ? state.elapsedMs : Date.now() - startedAt });
  }
  return settle("timeout", terminalToResponse({ taskId: accepted.taskId, kind: accepted.kind, label: accepted.label, status: "timeout", elapsedMs: Date.now() - startedAt }));
}
