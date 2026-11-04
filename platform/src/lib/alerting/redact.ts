// 通道脱敏。返回前端时抹掉 secret / webhook 明文(只留是否已配置的布尔位),
// 避免敏感值经 API 泄漏。编辑时前端只在"要改"时才回传新值,不回传=保持原值(见 update 逻辑)。

import type { AlertChannel } from "./types";

export interface RedactedChannel extends Omit<AlertChannel, "secret" | "webhookUrl"> {
  hasSecret: boolean;
  hasWebhook: boolean;
  webhookHint?: string; // webhook 尾段提示(便于识别是哪个),不含完整 URL
}

export function redactChannel(c: AlertChannel): RedactedChannel {
  const { secret, webhookUrl, ...rest } = c;
  return {
    ...rest,
    hasSecret: !!secret,
    hasWebhook: !!webhookUrl,
    ...(webhookUrl ? { webhookHint: "…" + webhookUrl.slice(-8) } : {}),
  };
}
