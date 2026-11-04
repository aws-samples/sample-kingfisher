// @kf-batch 37-sync-backfill —— 序 37 ⑦:补数中心支持同步任务(kind = "sync-task",task 作用域)。
//
// 「能不能补」的判定只有这一个作者:建计划(`app/api/backfill/plan`)、目标下拉(`app/api/backfill/targets`)、
// 执行实例(`execute.ts`,任务在建计划之后可能被改过)三处都调 `syncTaskBackfillRejection`。
//
// 执行 = 与手动运行**同一个**启动核心 `startGlueSyncRun`(triggeredBy="backfill",runDate = 实例日期,带补数计划号);
// 启动核心之前的入口判定(章反向卡 / 跨区取数 / 空活)在这里按手动启动路由的**同一顺序**、用**同一批单一作者函数**再做一遍 ——
// 补数不经过 HTTP 路由,少一道就等于补数能绕开路由上的拒绝(例如源在别的区 ⇒ 跨区取数)。
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
import { assertDefinitionRunsHere } from "@/lib/exec-env/definition-binding";
import { datasourceOwnerTarget } from "@/lib/datasource/placement-shared";
import { syncWorkRejection } from "@/lib/sync/task-shape";
import { syncTaskUsesRunDate } from "@/lib/sync/run-vars";
import { startGlueSyncRun } from "@/lib/sync/start-run";
import type { DataSource } from "@/types/datasource";
import type { BackfillInstanceRow } from "./types";

const USER_ID = "default-user";

export const SYNC_TASK_NO_DATE_VAR_MESSAGE = "这个同步任务没有用到日期变量,每天补出来的结果完全相同,补数没有意义";

/**
 * 这个同步任务能不能补数。能 ⇒ null;不能 ⇒ 中文原因(直接回给用户)。纯函数,不碰 AWS。
 *  · 只支持 glue 通道:zero-etl / dms 是持续复制,没有「某一天」可补;
 *  · 增量任务不支持:增量靠水位线推进,按历史日期重跑与水位语义冲突(启动核心对补数 run 也不推进水位,这里先拒);
 *  · 必须用到日期变量(过滤条件或源表名模板):否则每天补出来一模一样。
 */
export function syncTaskBackfillRejection(task: Record<string, unknown>): string | null {
  const channel = (task.channel as string) || "glue";
  if (channel !== "glue") return `只有 Glue 通道的同步任务支持补数(当前通道 ${channel} 是持续复制,没有按日期补的概念)`;
  if (task.syncMode === "incremental") {
    return "增量同步任务不支持按日期补数(增量靠水位线推进,按历史日期重跑会与水位冲突);如需补历史,请建一个带日期过滤条件的全量任务";
  }
  if (!syncTaskUsesRunDate(task as { whereClause?: unknown; sourceTables?: unknown })) return SYNC_TASK_NO_DATE_VAR_MESSAGE;
  return null;
}

/**
 * 执行一个同步任务补数实例:入口判定 → 启动核心。任何拒绝都**抛出**(runner 把它记成该实例的失败原因,不留卡死的 running)。
 * @param taskId 同步任务 id(= 补数目标 id = run 记录的 taskId ⇒ runner 按 (taskId, runId) 读终态回收)
 */
export async function runSyncTaskBackfillInstance(
  taskId: string,
  inst: BackfillInstanceRow,
  runDate: string
): Promise<{ runTaskId: string; runId: string }> {
  const { Item: task } = await docClient.send(new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId } }));
  if (!task) throw new Error("同步任务不存在");
  const reject = syncTaskBackfillRejection(task);
  if (reject) throw new Error(reject);

  // 以下顺序与 `app/api/sync/[id]/start/route.ts` 的 POST 相同。
  const bound = bindingTargets(task as { targets?: unknown; targetId?: unknown });
  // 实例自带的 targetId = 建计划时 bindingTargets(task) 展开的那个章;存量 / 缺省 ⇒ 回落绑定的第一个(与其它分支一致)。
  const tid = inst.targetId || bound[0];
  // 反向卡:建计划之后任务被改绑到别的区 ⇒ 实例的章与任务的章不一致 ⇒ 拒(不按旧章去跑)。
  assertDefinitionRunsHere(task, "同步任务", tid);

  const { Item: ds } = await docClient.send(
    new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: task.datasourceId } })
  );
  if (!ds) throw new Error("数据源不存在");
  const dsOwner = datasourceOwnerTarget(ds as Record<string, unknown>);
  if (!bound.includes(dsOwner)) {
    throw new Error(
      `禁止跨区取数:数据源在执行环境 ${dsOwner},而任务绑定在 ${bound.join(" / ")} —— 源与任务必须在同一执行环境`
    );
  }
  // B-123:「从哪读」按数据源范式判(S3 / DynamoDB 源没有库名)⇒ 数据源行一起交给单一作者
  const workReject = syncWorkRejection(task as { sourceDatabase?: unknown; sourceTables?: unknown }, ds);
  if (workReject) throw new Error(workReject);

  const started = await startGlueSyncRun({
    task, taskId, ds: ds as DataSource, tid, dsOwner,
    triggeredBy: "backfill", runDate, backfillPlanId: inst.planId,
  });
  if (!started.started) throw new Error(started.message);
  return { runTaskId: taskId, runId: started.runId };
}
