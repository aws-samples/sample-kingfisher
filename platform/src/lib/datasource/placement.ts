// @kf-batch 50-W3f-T0-T3
// 模块 50 —— 数据源落点(placement)的**类型 + 迁移**(门票 T3,50 ROADMAP §2octies.17 ⑧ / SPEC §1.3a S6)。
//
// 用户要看「他那个区的数据源」,而 `bgp-datasources` 实测 **region / targetId 零命中**:平台根本不知道
// 一条数据源归哪个执行目标。这一刀只做两件**改数据**的事,**不接线、不改 UI**:
//  ① 新建行由 `placementForNewDataSource()` 盖 `ownerTargetId`(单一作者,两条建源路径同源);
//  ② 存量行由 `backfillDataSourcePlacement()` 一次性补齐。
// 读侧 / 界面选择 / 跨区可达性判定 = O4,而 O4 的前置是**跨区网络拍板**(公网 vs VPC peering),不是 UI 问题。
//
// 🔴 存量为什么一律归 `tgt_home`(与 `resolveRunStamp` 缺省 home 同一条理由,不是随手兜底):
//    placement 概念出现之前,平台只有一条执行路径、所有数据源都从 home 的 Glue 连接探测与同步;
//    「那时建的数据源在 home」是**历史事实**,不是猜测。而**新建行**不走这条推理 —— 由 ① 显式盖章。
// 🔴 迁移**只补空缺**(`attribute_not_exists`),已有值的行一个字节不动 ⇒ 可反复执行;**不碰 `updatedAt`**
//    (系统迁移不是用户编辑,把 3 条数据源全显示成「刚刚更新」是误导)。
import { ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { DATASOURCE_OWNER_TARGET_ATTR } from "./placement-shared";

export { DATASOURCE_OWNER_TARGET_ATTR };

/**
 * 新建数据源要盖的落点字段。两条建源路径(JDBC / 非 JDBC)都必须展开它,由门禁钉住。
 *
 * @kf-batch 50-WP4quater-reads(工单 SC-2)
 * 🔴 用户 2026-09-10:「**所有的任务都要创建在当前区域,不能只是创建在主控区,没意义,
 * 除非在主控区创建任务,可以选择在主控区下发到其他指定区域执行。不然也是白干了。**」
 * ⇒ 落点由调用方给(路由从「顶栏视角 / 显式选择」得到并**校验过合法性 + 真解析过资源袋**);
 * 不给 = 主控区(与改动前逐字节等价,是回滚点)。
 *
 * 🔴 这里**不做校验**:校验要读描述符(异步 + 会抛),而本函数是同步的字段构造器,
 * 两件事混在一起会让「盖章」这个动作有两种失败模式。校验在路由里、盖章之前。
 */
export function placementForNewDataSource(targetId?: string): { [DATASOURCE_OWNER_TARGET_ATTR]: string } {
  return { [DATASOURCE_OWNER_TARGET_ATTR]: targetId || HOME_TARGET_ID };
}

export interface PlacementBackfillResult {
  scanned: number;
  backfilled: number;
  alreadyPlaced: number;
}

export async function backfillDataSourcePlacement(): Promise<PlacementBackfillResult> {
  const missing: Array<{ userId: string; datasourceId: string }> = [];
  let scanned = 0;
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await docClient.send(
      new ScanCommand({
        TableName: TABLES.DATASOURCES,
        FilterExpression: "attribute_not_exists(#o)",
        ExpressionAttributeNames: { "#o": DATASOURCE_OWNER_TARGET_ATTR },
        ProjectionExpression: "userId, datasourceId",
        ExclusiveStartKey: lastKey,
      })
    );
    scanned += res.ScannedCount ?? res.Items?.length ?? 0;
    for (const it of res.Items ?? []) {
      missing.push({ userId: String(it.userId), datasourceId: String(it.datasourceId) });
    }
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  let backfilled = 0;
  let alreadyPlaced = scanned - missing.length;
  for (const key of missing) {
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: TABLES.DATASOURCES,
          Key: key,
          UpdateExpression: "SET #o = :home",
          ConditionExpression: "attribute_exists(datasourceId) AND attribute_not_exists(#o)",
          ExpressionAttributeNames: { "#o": DATASOURCE_OWNER_TARGET_ATTR },
          ExpressionAttributeValues: { ":home": HOME_TARGET_ID },
        })
      );
      backfilled++;
    } catch (e: unknown) {
      // 条件不满足 = 扫描与写入之间别人已补上(或行已删);正常分支。
      if ((e as { name?: string }).name === "ConditionalCheckFailedException") alreadyPlaced++;
      else throw e;
    }
  }
  return { scanned, backfilled, alreadyPlaced };
}
