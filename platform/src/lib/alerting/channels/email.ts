// 邮件通道(SES v2)。SendEmail 纯文本。
// ⚠️ SES sandbox 限制:发件人/收件人须先在 SES 验证身份,否则 SendEmail 抛异常——notify 会把该
// 异常如实记入 channelResults.error(诚实行为,非假成功)。演示主推 webhook 通道;邮件需账号侧验证后启用。
// IAM:ses:SendEmail 由独立 ManagedPolicy 授予(见 platform-stack,禁 TaskRole.addToPolicy)。

import { homeRegion } from "@/lib/place/home-region";
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { AlertChannel } from "../types";
import { SendOutcome } from "./http";

const region = homeRegion();
const ses = sdkClient("control-plane", SESv2Client, { region });

export async function sendEmail(channel: AlertChannel, subject: string, text: string): Promise<SendOutcome> {
  const from = channel.emailFrom;
  const to = channel.emailTo || [];
  if (!from || !to.length) return { ok: false, error: "邮件通道缺少发件人或收件人" };
  try {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: to },
        Content: {
          Simple: {
            Subject: { Data: subject.slice(0, 200), Charset: "UTF-8" },
            Body: { Text: { Data: text, Charset: "UTF-8" } },
          },
        },
      })
    );
    return { ok: true };
  } catch (e: any) {
    // 常见:身份未验证 / sandbox 只能发给已验证地址 → 如实回错(便于用户按提示去 SES 验证)。
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}
