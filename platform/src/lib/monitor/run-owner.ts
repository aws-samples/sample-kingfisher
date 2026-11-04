// run 的**归属判定**(读侧)—— 与写侧的 `resolveRunStamp` 成对:一个决定章怎么盖,一个决定谁看得见。
//
// 合同:52 SPEC §1(task-runs 加 projectId,读侧带 legacy 兜底) 定下的
//      「by-id 一律按**资源归属项目**判,不按调用方的 active project」。
//
// ── 为什么需要它(不是所有读路径都能用 projectFilter)────────────────────────────
// `bgp-task-runs` 的读法有两种形状:
//  · **列表型**(monitor/runs)→ Scan + `projectFilter()` 就够;
//  · **按 taskId 直取型**(Copilot `check_run_status`、诊断取证、日志)→ 主键 Query,
//    此时**不能**加 `FilterExpression`:它会与 `Limit` 撞成"过滤在截断之后"的静默少报
//    (在 `redshift/history`、本批在 `monitor/runs` 都修过这个陷阱)。
//    ⇒ 正确做法是**先判任务归谁**,再原样取它的 run —— 与 `guardResourceAccess` 同一条判据。
//
// 🔴 现网实测缺口(本批逮到):`lib/copilot/plan/discovery-tools.ts` 的 `check_run_status`
// 明明拿到了 `CopilotCaller`(带 projectId)**却完全没用** ⇒ A 项目的用户报一个 B 项目的 taskId,
// 就能读到 B 的运行流水(含 `error` 文本:SQL 片段 / 表名 / 报错栈)。该文件抬头写着
// 「鉴权复用 CopilotCaller 身份」—— 声明与实现不符,正是这类洞最容易藏的地方。

import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { DEFAULT_PROJECT_ID } from "@/lib/projects/constants";

const USER_ID = "default-user"; // 单租户分区键(与各 by-id 路由一致)

/** run 的 taskId 可能是这四类资源之一(它们复用同一张运行表)。 */
const OWNER_TABLES: Array<{ table: string; keyAttr: string }> = [
  { table: TABLES.SYNC_TASKS, keyAttr: "taskId" },
  { table: TABLES.WORKFLOWS, keyAttr: "workflowId" },
  { table: TABLES.ETL_JOBS, keyAttr: "jobId" },
  { table: TABLES.ENGINE_JOBS, keyAttr: "jobId" },
];

export interface RunOwnerLookup {
  /** 找到了资源;`projectId` 为 undefined = 存量行(按平台既定口径属默认工作区)。 */
  found: boolean;
  projectId?: string;
}

/**
 * 查 taskId 属于哪个项目。
 *
 * 🔴 **查不到资源时返回 `found:false`,调用方必须当"不可见"处理**(fail-closed)。
 * 不要退化成"查不到就放行" —— 那会让"删掉资源但 run 还在"变成一个绕过通道。
 */
export async function lookupRunOwner(taskId: string): Promise<RunOwnerLookup> {
  if (!taskId) return { found: false };
  for (const { table, keyAttr } of OWNER_TABLES) {
    try {
      const { Item } = await docClient.send(
        new GetCommand({ TableName: table, Key: { userId: USER_ID, [keyAttr]: taskId } })
      );
      if (Item) return { found: true, projectId: Item.projectId ? String(Item.projectId) : undefined };
    } catch {
      // 单表读失败不能当成"不属于任何项目"⇒ 继续试下一张;全部失败则落到 found:false(fail-closed)
    }
  }
  return { found: false };
}

/**
 * 调用方能否看这条 run。
 *
 * 语义与 `projectFilter()` **逐字对齐**(两处若分叉,就会出现"列表里看得到、点进去 403"这种撕裂):
 * · 归属项目 === 调用方项目 ⇒ 可见;
 * · 存量资源(没有 `projectId`)⇒ 只有**默认工作区**看得见(与 `attribute_not_exists(projectId)` 兜底同款)。
 */
export function isRunVisibleTo(owner: RunOwnerLookup, callerProjectId: string): boolean {
  if (!owner.found) return false;
  if (owner.projectId) return owner.projectId === callerProjectId;
  return callerProjectId === DEFAULT_PROJECT_ID;
}

/** 便利组合:一次问完"归谁 + 我能不能看"。 */
export async function canReadRunsOf(taskId: string, callerProjectId: string): Promise<boolean> {
  return isRunVisibleTo(await lookupRunOwner(taskId), callerProjectId);
}
