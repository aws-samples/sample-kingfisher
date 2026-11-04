// 模块 34 — 企业微信群机器人通道。webhook 直发 markdown,无签名。
// 企微失败也回 HTTP 200(errcode 在 body),故解析 errcode 做业务级判定。

import type { AlertChannel } from "../types";
import { postJson, SendOutcome } from "./http";

export async function sendWecom(channel: AlertChannel, title: string, markdown: string): Promise<SendOutcome> {
  if (!channel.webhookUrl) return { ok: false, error: "通道缺少 webhook URL" };
  return postJson(
    channel.webhookUrl,
    { msgtype: "markdown", markdown: { content: `**${title}**\n${markdown}` } },
    (text) => {
      try {
        const code = JSON.parse(text)?.errcode ?? 0;
        return code && code !== 0 ? text : null;
      } catch {
        return null;
      }
    }
  );
}
