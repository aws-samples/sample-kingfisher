// 钉钉群机器人通道。webhook + 可选加签(安全设置选「加签」时必须)。
// 加签口径:sign = urlEncode(base64(HmacSHA256(secret, `${timestamp}\n${secret}`))),拼到 &timestamp=&sign=。
// 钉钉即使业务失败也回 HTTP 200(errcode 在 body),故解析 errcode 做业务级判定。

import { createHmac } from "crypto";
import type { AlertChannel } from "../types";
import { postJson, SendOutcome } from "./http";

function signedUrl(webhookUrl: string, secret?: string): string {
  if (!secret) return webhookUrl;
  const ts = Date.now();
  const sign = encodeURIComponent(createHmac("sha256", secret).update(`${ts}\n${secret}`).digest("base64"));
  const sep = webhookUrl.includes("?") ? "&" : "?";
  return `${webhookUrl}${sep}timestamp=${ts}&sign=${sign}`;
}

export async function sendDingtalk(channel: AlertChannel, title: string, markdown: string): Promise<SendOutcome> {
  if (!channel.webhookUrl) return { ok: false, error: "通道缺少 webhook URL" };
  const url = signedUrl(channel.webhookUrl, channel.secret);
  return postJson(
    url,
    { msgtype: "markdown", markdown: { title, text: `### ${title}\n\n${markdown}` } },
    (text) => {
      try {
        const code = JSON.parse(text)?.errcode ?? 0;
        return code && code !== 0 ? text : null;
      } catch {
        return null; // 非 JSON,以 HTTP 状态为准
      }
    }
  );
}
