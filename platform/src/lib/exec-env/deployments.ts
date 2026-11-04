// @kf-batch 50-P50.3-multibind
// **逐 target 下发台账**(50 SPEC §1.3a-S1)+ **版本一致性矩阵的格子语义**(INTERACTION §3.1 / §2bis.4)。
//
// ── 合同原文(S1,被点名为「整个模块「哪个任务打哪个 target」的核心数据模型」)──────
//   5 类资源定义表 + flink 加三个**纯追加**属性:
//     · `targets?: string[]`(缺省 `["tgt_home"]`)
//     · `deployments?: {[targetId]: {version, publishedAt, status:"ok"|"failed", error?}}`
//     · `specializedFrom?: {targetId, sourceId, at}`
//
// ── 🔴 最承重的那个**纯函数** `deploymentCellState()` 现在住在 `deployments-shared.ts` ──
// (客户端看板要 import 它,而本文件依赖 AWS SDK;抄两份的表现就是"接口说要处理、看板画成不用管"。)
// 版本一致性矩阵的全部价值 = 「漏发 / 失败 / 版本不齐**一眼可见**」。
// 而它最容易犯的错**不是漏报,是误报**:INTERACTION §2bis.4 专门为此立了规矩 ——
// `🔶已特化` / `—未绑定` / `⊘数据不可用` **三类格不参与红黄判定、不报警**。
// 用户原话是「不是所有区域的计算任务都绝对一致,某些区域是特定的计算任务也是正常的」。
// 如果把"这个区本来就不该有"误抓成"漏了这个区",看板会天天误报 ⇒ 三天后没人看它 ⇒
// 这个组件就白做了。所以三类格各有独立分支,而且**每一类都有负向单测**。
//
// ⚠️ **如实登记**:`⊘数据不可用`(数据异质,§2bis.3)的**判定输入本批还没有生产者** ——
// 它要"该任务引用的数据源在该 target 是否可达",而数据源的 per-target 可达性判定属后续刀。
// 这里**保留分支并显式接一个入参**,不假装它不存在:调用方传 `dataUnavailable` 才会出这个态。
// 刻意不悄悄把它当 `unbound` 处理 —— 那两件事的处置完全不同(一个是正常、一个要去建数据源)。

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@/lib/aws/dynamodb";
import type { DeploymentRecord } from "./deployments-shared";

/**
 * 🔴 **格子语义与判态纯函数已移入 `deployments-shared.ts`**(客户端组件也要 import 它,
 * 而本文件依赖 `@aws-sdk/lib-dynamodb`)。这里**只做转出**,不再有第二份定义 ——
 * 既有 import 路径保持不变。
 */
export {
  ATTENTION_STATES,
  needsAttention,
  deploymentCellState,
  rowAttentionCount,
  bindingShape,
  specializedTargetsOf,
} from "./deployments-shared";
export type { DeploymentRecord, CellState, BindingShape } from "./deployments-shared";

// ══════════════════════════════════════════════════════════════════════════════
// 台账写入 —— **唯一写口**
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 把一条 (定义 × target) 的下发结果写进资源行的 `deployments` map。
 *
 * 🔴 用 **map 路径写**(`SET #d.#t = :v` + `if_not_exists` 建父)而不是整包覆盖:
 * 逐 target 串行下发时,后一个 target 的写入绝不能把前一个的结果抹掉 ——
 * 整包覆盖在"下发到第 3 个区时失败"这种最常见的情形下,会把前两个成功记录一起弄没,
 * 于是矩阵显示"三个格子全是漏发",而真相是两个已经好了。
 *
 * 🔴 **失败也要写**(`status:"failed"` + `error`):不写就退化成 `never-deployed`,
 * 而"从没发过"与"发过但失败了"的处置完全不同(后者要看错误、可能是权限或组件缺失)。
 */
export async function recordDeployment(args: {
  table: string;
  key: Record<string, string>;
  targetId: string;
  record: DeploymentRecord;
}): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: args.table,
      Key: args.key,
      // `if_not_exists(#d, :empty)` 让父 map 不存在时也能写(存量行没有这个属性)。
      UpdateExpression: "SET #d = if_not_exists(#d, :empty), #u = :now",
      ExpressionAttributeNames: { "#d": "deployments", "#u": "updatedAt" },
      ExpressionAttributeValues: { ":empty": {}, ":now": new Date().toISOString() },
    })
  );
  await docClient.send(
    new UpdateCommand({
      TableName: args.table,
      Key: args.key,
      UpdateExpression: "SET #d.#t = :v",
      // 🔴 targetId 必须走 ExpressionAttributeNames:它含 `_`,而且 map 的 key 直接拼进表达式
      // 会在含保留字/特殊字符时整条写失败(而不是只失败这一项)。
      ExpressionAttributeNames: { "#d": "deployments", "#t": args.targetId },
      ExpressionAttributeValues: { ":v": args.record },
    })
  );
}

/**
 * 删掉一条 (定义 × target) 的下发记录 —— **下线**时用。
 *
 * 🔴 **不删就是「看板假绿」**:DAG 已经从 MWAA 撤掉了,台账里那条 `status:"ok"` 还在
 * ⇒ 矩阵显示 ✓ 一致,而实际上那个区什么都没有。看板最不能犯的错就是这个。
 *
 * 🔴 用 `attribute_exists(#d)` 兜住"存量行根本没有 `deployments` 属性"这一情形:
 * 对不存在的父 map 走嵌套路径 REMOVE,DynamoDB 会抛 `ValidationException`(路径非法),
 * 而这不是错误 —— 那正是"本来就没有下发记录"。条件不满足即视为已删。
 */
export async function removeDeployment(args: {
  table: string;
  key: Record<string, string>;
  targetId: string;
}): Promise<void> {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: args.table,
        Key: args.key,
        UpdateExpression: "REMOVE #d.#t SET #u = :now",
        ConditionExpression: "attribute_exists(#d)",
        ExpressionAttributeNames: { "#d": "deployments", "#t": args.targetId, "#u": "updatedAt" },
        ExpressionAttributeValues: { ":now": new Date().toISOString() },
      })
    );
  } catch (e) {
    if ((e as { name?: string })?.name !== "ConditionalCheckFailedException") throw e;
  }
}
