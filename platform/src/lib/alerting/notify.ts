// 模块 34 — 告警分发编排。给定一个待通知的告警 + 一组通道,并行投递(每通道 3s 超时独立),
// 聚合每通道结果 → 汇总最终状态(全成功=notified / 部分=partial / 全失败=failed)。
// 单通道失败不阻塞其他通道(投递结果各自记入 channelResults,便于排障)。

import type { AlertChannel, ChannelDeliveryResult, EventStatus, Severity } from "./types";
import { sendDingtalk } from "./channels/dingtalk";
import { sendWecom } from "./channels/wecom";
import { sendEmail } from "./channels/email";
import { sendGeneric } from "./channels/generic";

// 一条告警的通知素材(与具体通道无关)。
export interface Notification {
  title: string; // 如 "[P1] 数据同步失败：orders_sync"
  severity: Severity;
  ruleName: string;
  message: string; // 正文(markdown/纯文本通用)
  trigger: Record<string, unknown>;
}

// 把一条告警投递到一个通道,产出该通道的投递结果。
async function deliverOne(channel: AlertChannel, n: Notification): Promise<ChannelDeliveryResult> {
  const at = new Date().toISOString();
  const base = { channelId: channel.channelId, channelType: channel.type, at };
  if (!channel.enabled) return { ...base, ok: false, error: "通道已禁用" };
  let outcome;
  switch (channel.type) {
    case "dingtalk":
      outcome = await sendDingtalk(channel, n.title, n.message);
      break;
    case "wecom":
      outcome = await sendWecom(channel, n.title, n.message);
      break;
    case "email":
      outcome = await sendEmail(channel, n.title, `${n.message}\n\n—— ${n.ruleName}`);
      break;
    case "generic":
      outcome = await sendGeneric(channel, {
        title: n.title,
        severity: n.severity,
        message: n.message,
        ruleName: n.ruleName,
        trigger: n.trigger,
        at,
      });
      break;
    default:
      outcome = { ok: false, error: `未知通道类型: ${(channel as any).type}` };
  }
  return { ...base, ok: outcome.ok, ...(outcome.httpStatus ? { httpStatus: outcome.httpStatus } : {}), ...(outcome.error ? { error: outcome.error } : {}) };
}

// 并行分发到全部通道,聚合结果与最终状态。
export async function dispatch(
  channels: AlertChannel[],
  n: Notification
): Promise<{ status: EventStatus; results: ChannelDeliveryResult[] }> {
  if (!channels.length) {
    return { status: "notified", results: [] }; // 没配通道:仅记事件,不视为失败
  }
  const results = await Promise.all(channels.map((c) => deliverOne(c, n)));
  const okCount = results.filter((r) => r.ok).length;
  const status: EventStatus = okCount === results.length ? "notified" : okCount === 0 ? "failed" : "partial";
  return { status, results };
}
