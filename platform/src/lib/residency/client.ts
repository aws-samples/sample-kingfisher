// 浏览器侧的免责告知配合件(50 INTERACTION v2.17 §4bis.4;SPEC v3.23 §3.2 的 409 形状)。
//
// 服务端对跨法域 target 的数据操作,在用户没同意当前版本免责告知时回 **409**:
//   { success:false, error:{ code:"CONFLICT", message, detail:{ reason:"residency-ack-required", targetId, disclaimer:{version,text,textHash} } } }
// 前端据 `detail.reason` 弹窗(文案取**服务端下发**的 disclaimer,不自己拼 —— 文案单作者在 disclaimer.ts,页面只显示),
// 用户点〔同意并继续〕⇒ POST /api/residency/ack ⇒ 重试**同一请求**;点〔取消〕⇒ 什么都不执行。
// 🔴 本文件零服务端依赖(可被任何客户端组件 import);判 409 只认 `detail.reason`,不认文案。
import { RESIDENCY_ACK_REQUIRED } from "@/lib/exec-env/residency";

export interface DisclaimerView {
  version: string;
  text: string;
  textHash: string;
}

export interface AckRequiredDetail {
  reason: typeof RESIDENCY_ACK_REQUIRED;
  targetId: string;
  disclaimer: DisclaimerView;
}

/** 从任意响应体里识别「需要先同意免责告知」;不是 ⇒ null。 */
export function ackRequiredOf(body: unknown): AckRequiredDetail | null {
  const detail = (body as { error?: { detail?: unknown } } | null)?.error?.detail as
    | { reason?: unknown; targetId?: unknown; disclaimer?: { version?: unknown; text?: unknown; textHash?: unknown } }
    | undefined;
  if (!detail || detail.reason !== RESIDENCY_ACK_REQUIRED) return null;
  const d = detail.disclaimer;
  if (!d || typeof d.version !== "string" || typeof d.text !== "string" || typeof d.textHash !== "string") return null;
  if (typeof detail.targetId !== "string" || !detail.targetId) return null;
  return { reason: RESIDENCY_ACK_REQUIRED, targetId: detail.targetId, disclaimer: { version: d.version, text: d.text, textHash: d.textHash } };
}

/** 同意:把服务端下发的版本 + 哈希原样回传(服务端逐字核对)。返回 true = 已留存(含幂等的 created:false)。 */
export async function postResidencyAck(d: AckRequiredDetail): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch("/api/residency/ack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: d.targetId, version: d.disclaimer.version, textHash: d.disclaimer.textHash }),
  });
  let body: { success?: boolean; error?: { message?: string } } | null = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON 走下面兜底 */
  }
  if (res.ok && body?.success) return { ok: true };
  return { ok: false, message: body?.error?.message || `同意记录写入失败(HTTP ${res.status})` };
}

export type AckResolution = "retry" | "cancel" | "n/a";

/**
 * 带「同意后自动重试一次」的 fetch:`resolveAck` 由 `useResidencyAck()` 提供(弹窗 + POST ack)。
 * 返回原始 Response 与已解析的 body;`cancelled=true` 表示用户在告知弹窗上点了取消(调用方直接结束,不报错)。
 */
export async function fetchWithResidencyAck(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  resolveAck: (detail: AckRequiredDetail) => Promise<AckResolution>
): Promise<{ res: Response; body: any; cancelled: boolean }> {
  let res = await fetch(input, init);
  let body: any = null;
  try {
    body = await res.clone().json();
  } catch {
    body = null;
  }
  const need = res.status === 409 ? ackRequiredOf(body) : null;
  if (!need) return { res, body, cancelled: false };
  const v = await resolveAck(need);
  if (v !== "retry") return { res, body, cancelled: true };
  res = await fetch(input, init);
  try {
    body = await res.clone().json();
  } catch {
    body = null;
  }
  return { res, body, cancelled: false };
}
