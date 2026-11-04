// 通知通道 CRUD(bgp-alert-channels)。单逻辑分区 pk="alertchannel",channelId(ULID)。
// 通道跨规则复用(一个钉钉群机器人可被多条规则引用),故独立成表而非内嵌进规则。
// webhook secret / 收件人是用户运行期输入,随表 CMK 静态加密存储,严禁写进代码。

import { PutCommand, GetCommand, QueryCommand, UpdateCommand, DeleteCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { AlertChannel, ChannelType, CHANNEL_TYPES } from "./types";

const PK = "alertchannel";

function validateForType(type: ChannelType, input: any): void {
  if (type === "dingtalk" || type === "wecom" || type === "generic") {
    const url = String(input?.webhookUrl || "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("该通道需要合法的 webhook URL(http/https)");
  }
  if (type === "email") {
    const from = String(input?.emailFrom || "").trim();
    const to = Array.isArray(input?.emailTo) ? input.emailTo.filter(Boolean) : [];
    if (!from) throw new Error("邮件通道需要已在 SES 验证的发件人");
    if (!to.length) throw new Error("邮件通道需要至少一个收件人");
  }
}

export async function listChannels(): Promise<AlertChannel[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.ALERT_CHANNELS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": PK },
      ScanIndexForward: false,
    })
  );
  return Items as AlertChannel[];
}

export async function getChannel(channelId: string): Promise<AlertChannel | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.ALERT_CHANNELS, Key: { pk: PK, channelId } })
  );
  return (Item as AlertChannel) || null;
}

// 批量取多个通道(引擎分发时按规则的 channelIds 一次拿齐)。空数组直接返回空。
export async function getChannels(channelIds: string[]): Promise<AlertChannel[]> {
  const ids = Array.from(new Set(channelIds.filter(Boolean)));
  if (!ids.length) return [];
  const { Responses = {} } = await docClient.send(
    new BatchGetCommand({
      RequestItems: {
        [TABLES.ALERT_CHANNELS]: { Keys: ids.map((channelId) => ({ pk: PK, channelId })) },
      },
    })
  );
  return (Responses[TABLES.ALERT_CHANNELS] || []) as AlertChannel[];
}

export async function createChannel(
  input: {
    name?: string;
    type?: string;
    webhookUrl?: string;
    secret?: string;
    emailFrom?: string;
    emailTo?: string[];
  },
  ctx: { createdBy: string }
): Promise<AlertChannel> {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("缺少通道名称");
  const type = CHANNEL_TYPES.includes(input.type as ChannelType) ? (input.type as ChannelType) : null;
  if (!type) throw new Error("type 必须是 dingtalk / wecom / email / generic");
  validateForType(type, input);
  const now = new Date().toISOString();
  const channel: AlertChannel = {
    pk: PK,
    channelId: ulid(),
    name,
    type,
    ...(input.webhookUrl ? { webhookUrl: String(input.webhookUrl).trim() } : {}),
    ...(input.secret ? { secret: String(input.secret).trim() } : {}),
    ...(input.emailFrom ? { emailFrom: String(input.emailFrom).trim() } : {}),
    ...(Array.isArray(input.emailTo) ? { emailTo: input.emailTo.filter(Boolean) } : {}),
    enabled: true,
    createdBy: ctx.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  await docClient.send(new PutCommand({ TableName: TABLES.ALERT_CHANNELS, Item: channel }));
  return channel;
}

export async function updateChannel(
  channelId: string,
  patch: {
    name?: string;
    webhookUrl?: string;
    secret?: string;
    emailFrom?: string;
    emailTo?: string[];
    enabled?: boolean;
  }
): Promise<AlertChannel | null> {
  const current = await getChannel(channelId);
  if (!current) return null;
  // 若改了连接相关字段,按当前 type 重新校验(合并后再验,避免半改导致非法态)。
  if (patch.webhookUrl !== undefined || patch.emailFrom !== undefined || patch.emailTo !== undefined) {
    validateForType(current.type, {
      webhookUrl: patch.webhookUrl ?? current.webhookUrl,
      emailFrom: patch.emailFrom ?? current.emailFrom,
      emailTo: patch.emailTo ?? current.emailTo,
    });
  }
  const sets: string[] = ["updatedAt = :now"];
  const values: Record<string, unknown> = { ":now": new Date().toISOString() };
  const names: Record<string, string> = {};
  if (patch.name !== undefined) {
    const n = String(patch.name).trim();
    if (!n) throw new Error("通道名称不能为空");
    sets.push("#nm = :nm"); values[":nm"] = n; names["#nm"] = "name";
  }
  if (patch.webhookUrl !== undefined) { sets.push("webhookUrl = :u"); values[":u"] = String(patch.webhookUrl).trim(); }
  if (patch.secret !== undefined) { sets.push("secret = :s"); values[":s"] = String(patch.secret).trim(); }
  if (patch.emailFrom !== undefined) { sets.push("emailFrom = :ef"); values[":ef"] = String(patch.emailFrom).trim(); }
  if (patch.emailTo !== undefined) { sets.push("emailTo = :et"); values[":et"] = Array.isArray(patch.emailTo) ? patch.emailTo.filter(Boolean) : []; }
  if (patch.enabled !== undefined) { sets.push("#en = :en"); values[":en"] = !!patch.enabled; names["#en"] = "enabled"; }
  const { Attributes } = await docClient.send(
    new UpdateCommand({
      TableName: TABLES.ALERT_CHANNELS,
      Key: { pk: PK, channelId },
      UpdateExpression: "SET " + sets.join(", "),
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    })
  );
  return (Attributes as AlertChannel) || null;
}

export async function deleteChannel(channelId: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLES.ALERT_CHANNELS, Key: { pk: PK, channelId } }));
}
