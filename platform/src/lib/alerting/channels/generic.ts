// 通用 JSON webhook 通道。POST 结构化 payload 到任意端点,供接第三方 IM / 平台自测 sink。
// 自测闭环:generic 通道指向平台自身 api/alerting/test-sink,即可在不接真实钉钉/企微账号下
// 端到端无头验证「规则命中→投递→sink 收到」。

import type { AlertChannel } from "../types";
import { postJson, SendOutcome } from "./http";

export interface GenericPayload {
  title: string;
  severity: string;
  message: string;
  ruleName: string;
  trigger: Record<string, unknown>;
  at: string;
}

export async function sendGeneric(channel: AlertChannel, payload: GenericPayload): Promise<SendOutcome> {
  if (!channel.webhookUrl) return { ok: false, error: "通道缺少 webhook URL" };
  return postJson(channel.webhookUrl, payload);
}
