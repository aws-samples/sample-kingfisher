export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { recommendChannel } from "@/lib/sync/sync-service";
// 通道 × 执行区的唯一规则:数据源所在的区不提供的通道 ⇒ 不支持并写明原因(向导据此置灰)
import { applyChannelPlace } from "@/lib/sync/channel-place";
import { datasourceOwnerTarget } from "@/lib/datasource/placement-shared";
import { apiOk, apiError } from "@/lib/api-response";

const USER_ID = "default-user";

export async function POST(req: NextRequest) {
  const { sourceType, targetType, syncMode, datasourceId } = await req.json();
  const rec = recommendChannel(sourceType || "mysql", targetType || "redshift", syncMode || "full");
  // 带了数据源 ⇒ 再按它所在的执行区过一遍(落点由服务端读数据源行得出,不信请求体)。
  // 不带 ⇒ 只按源 / 目标 / 模式给(不知道在哪个区,就不替它假设一个区)。
  if (typeof datasourceId !== "string" || !datasourceId) return apiOk(rec);
  const { Item: ds } = await docClient.send(
    new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId } })
  );
  if (!ds) return apiError(`数据源 ${datasourceId} 不存在`, 404, { code: "NOT_FOUND" });
  let targetId: string;
  try {
    targetId = datasourceOwnerTarget(ds as Record<string, unknown>);
  } catch (e) {
    return apiError(`数据源 ${datasourceId} 的执行环境标记非法:${String((e as Error)?.message ?? e).slice(0, 200)}`, 400, { code: "VALIDATION_FAILED" });
  }
  return apiOk(applyChannelPlace(rec, targetId));
}
