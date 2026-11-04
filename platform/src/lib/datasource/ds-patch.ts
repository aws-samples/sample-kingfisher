// 数据源行的局部更新(唯一作者):SET 给定键 + updatedAt。
//   序 38 B-70 之前 heartbeat / tables 两条路由各写一份 UpdateCommand;探测与发现表共用一个载体后,
//   落库必须是同一支笔(心跳、发现作业记录、发现结果三个键会在同一次推进里一起写)。
// 序 60 B-132 —— 🔴 条件写 `attribute_exists(datasourceId)`:这支笔的调用方全是**在途的 fire-and-forget 收口**
//   (建源后的连通性探测、「检测」/「浏览表」的 Glue 发现作业推进、非 JDBC 建源的异步真连测试),落笔时源可能已被删;
//   DynamoDB UpdateItem 对不存在的键是 upsert ⇒ 原来会凭空造出一条只有状态字段、没有 name / ownerTargetId 的**幽灵行**
//   (2026-10-28 测试账号三条,ULID 时刻与 updatedAt 相差 1.7 分钟、discovery.error 是「找不到 Glue 连接」坐实)。
//   源已删 ⇒ 结论丢弃、回 `gone`(记一行日志);调用方不必关心。
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { logger } from "@/lib/observability/logger";

const USER_ID = "default-user";

export type DsPatchOutcome = "patched" | "gone" | "noop";

export async function patchDataSourceRow(datasourceId: string, patch: Record<string, unknown>): Promise<DsPatchOutcome> {
  const keys = Object.keys(patch);
  if (!keys.length) return "noop";
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.DATASOURCES,
      Key: { userId: USER_ID, datasourceId },
      UpdateExpression: `SET ${keys.map((_, i) => `#k${i} = :v${i}`).join(", ")}, updatedAt = :now`,
      ConditionExpression: "attribute_exists(datasourceId)",
      ExpressionAttributeNames: Object.fromEntries(keys.map((k, i) => [`#k${i}`, k])),
      ExpressionAttributeValues: { ...Object.fromEntries(keys.map((k, i) => [`:v${i}`, patch[k]])), ":now": new Date().toISOString() },
    }));
    return "patched";
  } catch (e) {
    if ((e as { name?: string })?.name === "ConditionalCheckFailedException") {
      logger.info("datasource.patch.gone", { datasourceId, keys, note: "源已删除,在途结论丢弃(B-132)" });
      return "gone";
    }
    throw e;
  }
}
