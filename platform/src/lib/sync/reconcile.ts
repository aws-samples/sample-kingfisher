// 数据同步 — 读时对账(reconcile-on-read)的**唯一入口**,按通道分派。
//
// 【为什么有这个文件】列表纯读 DB;若进程内 pollGlueJob 因重启丢失,Glue 批同步任务会永久卡 running ⇒ 对 running 的 glue
//   任务查真实 JobRun 并回写(原逻辑,保持不变)。
//
// 【原形(2026-10-27 测试账号 production 形态实测)】DMS 复制任务在 DMS 侧 FATAL(源库未开 binlog)后,同步**列表**
//   仍显示「运行中」且带「停止」入口,1.5 小时不变;只有打开该任务详情页(它轮询 realtime-status)才回写 failed。
//   根因:本文件此前只对 glue 通道对账(文件头还写着「DMS / Zero-ETL … 这里不强行降级」),DMS / Zero-ETL 的终态判定与回写
//   散在两个详情页路由里,列表没有同一份逻辑;Zero-ETL 更只在响应里算成 error、**不落库**。
// 【根治】判定(纯函数)与回写(条件写 + 运行记录收口)各一个作者,**列表与两个详情页路由共用**:
//   · glue:running 查 JobRun(原逻辑);
//   · dms:running / provisioning 查复制任务本体(不拉逐表统计)⇒ `judgeDmsReplication`;
//   · zero-etl:running / provisioning 查集成 ⇒ `judgeZeroEtlIntegration`
//     (active 时「补建目标库 + 置 running」仍只在详情页做 —— 那是**推进**,不是对账)。
// 🔴 回写带「行仍是我读到的那个在途状态」条件:用户同一瞬间点了「停止」/ 又点了「启动」⇒ 让路、不碰运行记录
//   (同一条不变量:用户的停止永不被自动化盖回)。
// 🔴 查不到 / 查不动(返回 null)⇒ 保留原状态:「不知道」不许写成任何终态。
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { GetJobRunsCommand } from "@aws-sdk/client-glue";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
// task-runs 唯一写通道(50 SPEC §6 S10)。
import { updateRunRecord, resolveRunStamp, settleRunningRuns } from "@/lib/monitor/run-records";
// 对账按任务章取区:home 客户端查非 home 的 JobRun **必然查不到**,
// 而「查不到」在这条路上会让非 home 的任务永远卡 running(对账形同虚设)。区解析失败即抛
// (regionOfTarget 不回落 home),由下方 catch 接住 ⇒ 保留原状态,绝不用错区的答案改状态。
import { bindingTargets, regionOfTarget } from "@/lib/exec-env/data-plane-target";
import { glueClientFor } from "@/lib/exec-env/target-clients";
import { updateSyncTaskIfExists } from "@/lib/sync/task-write";
// 终态失败原话分类(与 pollGlueJob 同一作者);网络漂移 ⇒ 源行标 broken,下一次启动前自愈
import { classifyRunError, isNetworkDrift } from "@/lib/sync/run-error";
import { noteNetworkDriftFromRunError } from "@/lib/datasource/network-reconcile";
import { describeReplicationTaskState, type ReplicationTaskState } from "@/lib/realtime/dms-service";
import { getIntegrationStatus } from "@/lib/realtime/zeroetl-service";

const GLUE_DONE = ["SUCCEEDED", "FAILED", "STOPPED", "ERROR", "TIMEOUT"];

/**
 * 需要对账的在途状态。与 `row-action.ts` 的「可停」集合今天恰好同值,但**语义不同**(这里是「后端可能已到终态而行还没跟上」),
 * 刻意不复用(记忆 one-set-two-meanings-deadlock:同一集合被当两件事用,改其一必伤其二)。
 */
export const SYNC_IN_FLIGHT_STATUSES: readonly string[] = ["running", "provisioning"];

/** 对账判定的结论:任务行写成什么、运行记录收口成什么、错误原文是什么。 */
export interface ChannelVerdict {
  /** 任务行要写成的终态(`error` 是 zero-etl 存量词,与 zeroetl-status 响应同口径) */
  status: "failed" | "stopped" | "error";
  /** 运行记录要收口成的终态(`stopped` = 用户 / 外部停止,与 run-cancel 同词) */
  runStatus: "failed" | "succeeded" | "stopped";
  /** 错误原文(落到运行记录 `error` 与任务行的错误字段;外部正常停止没有) */
  error?: string;
}

/** 对账要读的任务行字段(列表 Scan 出来的整行 / 详情页 Get 出来的整行都满足)。 */
export interface SyncTaskRowLike {
  taskId: string;
  status?: string;
  channel?: string;
  glueJobName?: string;
  realtimeConfig?: { replicationTaskArn?: string; [k: string]: unknown };
  integrationArn?: string;
  /** 区章(`bindingTargets` 三级回落读 `targets` → `targetId` → home;这里只声明 targets,存量 `targetId` 由它在运行期读) */
  targets?: unknown;
  projectId?: string | null;
}

const DMS_FAILED_STATUSES = ["failed", "failed-move"];

/**
 * DMS 复制任务状态 ⇒ 任务终态(纯函数;列表对账与 realtime-status 详情路由共用)。
 *
 * · `failed` / `failed-move` ⇒ failed(running 与 provisioning 都认:这是 DMS 自己说的终态);
 * · 🔴 **provisioning 只认上面这一条**:启动编排会复用上一次留下的复制任务(可能带着旧 lastFailure、处于 stopped / ready),
 *   在它 StartReplicationTask 之前这些全是正常中间态,按失败处理就是把一次正常启动判死;
 * · running 且 DMS `stopped`:StopReason 含 ERROR ⇒ failed;含 FINISHED 或(全量 100% 且无 lastFailure)⇒ stopped / 运行成功;
 *   带 lastFailure ⇒ failed;其余 = 有人在服务侧停了它 ⇒ stopped / 运行 stopped;
 * · running 且 DMS `ready` 带 lastFailure ⇒ failed(任务被服务侧重置且带失败);
 * · running / starting / stopping / modifying / testing / creating / 其它 ⇒ null —— 🔴 **运行中的任务不因残留的 lastFailure 被判死**
 *   (改动前 realtime-status 的 `st.status === "failed" || st.lastFailure` 会把「失败过一次、已在控制台恢复、正在跑」的任务写成 failed)。
 */
export function judgeDmsReplication(st: ReplicationTaskState, taskStatus: string): ChannelVerdict | null {
  if (!SYNC_IN_FLIGHT_STATUSES.includes(taskStatus)) return null;
  const dmsStatus = String(st.status || "").toLowerCase();
  if (DMS_FAILED_STATUSES.includes(dmsStatus)) {
    return { status: "failed", runStatus: "failed", error: st.lastFailure || `DMS 复制任务状态 ${dmsStatus}` };
  }
  if (taskStatus !== "running") return null;
  if (dmsStatus === "stopped") {
    const reason = String(st.stopReason || "");
    if (/ERROR/i.test(reason)) {
      return { status: "failed", runStatus: "failed", error: st.lastFailure || `DMS 复制任务已停止:${reason}` };
    }
    if (/FINISHED/i.test(reason) || (st.fullLoadProgress === 100 && !st.lastFailure)) {
      return { status: "stopped", runStatus: "succeeded" };
    }
    if (st.lastFailure) return { status: "failed", runStatus: "failed", error: st.lastFailure };
    return { status: "stopped", runStatus: "stopped" };
  }
  if (dmsStatus === "ready" && st.lastFailure) return { status: "failed", runStatus: "failed", error: st.lastFailure };
  return null;
}

/**
 * Zero-ETL 集成状态 ⇒ 任务终态(纯函数;列表对账与 zeroetl-status 详情路由共用)。
 * 集成 `failed` ⇒ error(存量词)+ 错误原文;creating / active / modifying / syncing / needs_attention … ⇒ null(不是终态,不动)。
 */
export function judgeZeroEtlIntegration(integrationStatus: string, errors: readonly string[], taskStatus: string): ChannelVerdict | null {
  if (!SYNC_IN_FLIGHT_STATUSES.includes(taskStatus)) return null;
  if (String(integrationStatus || "").toLowerCase() !== "failed") return null;
  const error = errors.filter(Boolean).join("; ") || "Zero-ETL 集成状态 failed";
  return { status: "error", runStatus: "failed", error };
}

/**
 * 把判定落库:任务行(条件写:行仍是读到时的那个在途状态)+ 收口仍 running 的运行记录。
 * @returns `true` = 任务行真改到了;`false` = 行已不存在 / 已被别人改了状态(用户停止、另一次启动)⇒ 什么都不碰。
 * 其它错误(凭证 / 限流)照旧抛,由调用方决定保留原状态。
 */
export async function settleSyncChannelVerdict(task: SyncTaskRowLike, verdict: ChannelVerdict, targetId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const names: Record<string, string> = { "#s": "status" };
  const values: Record<string, unknown> = { ":s": verdict.status, ":now": now, ":cur": task.status };
  const sets = ["#s = :s", "updatedAt = :now"];
  const errorText = verdict.error ? verdict.error.slice(0, 500) : undefined;
  if (errorText) {
    values[":err"] = errorText;
    if (task.channel === "zero-etl") {
      sets.push("zeroEtlError = :err");
    } else if (task.realtimeConfig && typeof task.realtimeConfig === "object") {
      // 详情页「错误」栏读的是 realtimeConfig.error(与启动编排写失败原因的字段同一个);`error` 是 DDB 保留字 ⇒ 起别名
      names["#err"] = "error";
      sets.push("realtimeConfig.#err = :err");
    }
  }
  // 唯一写通道(行不存在 no-op);叠加「状态未被别人改过」条件
  const wrote = await updateSyncTaskIfExists({
    taskId: task.taskId,
    UpdateExpression: `SET ${sets.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    onlyIf: "#s = :cur",
  });
  if (!wrote.ok) return false;
  // 收口仍 running 的运行记录(翻页 + 条件写 + 不改写用户取消,都在 settleRunningRuns 里)。
  // 🔴 章按真落点显式盖(裸 resolveRunStamp(task) 在同步通道上会盖成 home;wiring 门禁钉)。
  try {
    await settleRunningRuns({
      taskId: task.taskId,
      status: verdict.runStatus,
      set: { finishedAt: now, ...(errorText ? { error: errorText } : {}) },
      stamp: resolveRunStamp(task, targetId),
    });
  } catch {
    /* best-effort:运行记录收口失败不回滚任务行(行状态是用户看的真值,先保它) */
  }
  return true;
}

/**
 * realtime-status 详情路由用:拿到复制任务状态后判定并落库,回「任务行该显示的状态」(没到终态 ⇒ null,路由照旧回 DMS 原值)。
 * 落库失败(行被用户抢先改了 / 基建错误)不影响返回值:判定是对 DMS 事实的陈述,与行写没写进去无关。
 */
export async function applyDmsStatus(task: SyncTaskRowLike, st: ReplicationTaskState): Promise<ChannelVerdict["status"] | null> {
  const verdict = judgeDmsReplication(st, String(task.status ?? ""));
  if (!verdict) return null;
  try {
    await settleSyncChannelVerdict(task, verdict, bindingTargets(task)[0]);
  } catch {
    /* 保留原状态;响应仍如实说 DMS 的终态 */
  }
  return verdict.status;
}

/** zeroetl-status 详情路由用:同上(集成 failed ⇒ error 落库,不再只在响应里算)。 */
export async function applyZeroEtlStatus(task: SyncTaskRowLike, integrationStatus: string, errors: readonly string[]): Promise<ChannelVerdict["status"] | null> {
  const verdict = judgeZeroEtlIntegration(integrationStatus, errors, String(task.status ?? ""));
  if (!verdict) return null;
  try {
    await settleSyncChannelVerdict(task, verdict, bindingTargets(task)[0]);
  } catch {
    /* 同上 */
  }
  return verdict.status;
}

async function reconcileGlue(task: SyncTaskRowLike): Promise<SyncTaskRowLike> {
  if (task.status !== "running" || !task.glueJobName) return task;
  const tid = bindingTargets(task)[0];
  const glue = await glueClientFor(await regionOfTarget(tid));
  const { JobRuns = [] } = await glue.send(new GetJobRunsCommand({ JobName: task.glueJobName, MaxResults: 1 }));
  if (JobRuns.length === 0) return task;
  const run = JobRuns[0];
  const state = run.JobRunState;
  if (!state || !GLUE_DONE.includes(state)) return task;
  const now = new Date().toISOString();
  const newStatus = state === "SUCCEEDED" ? "succeeded" : "error";
  // 🔴🔴 本处是这类缺陷**最危险**的一个入口:对账的 `task` 来自**列表**(没有重新 Get),
  //   从读列表到写回之间行完全可能已被删掉 ⇒ 盲 Update 会把它**凭空造回来**。
  await updateSyncTaskIfExists({
    taskId: task.taskId,
    UpdateExpression: "SET #s = :s, updatedAt = :now",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":s": newStatus, ":now": now },
  }).catch(() => {});
  const errCls = classifyRunError(run.ErrorMessage);
  const dsId = (task as { datasourceId?: unknown }).datasourceId;
  if (newStatus === "error" && isNetworkDrift(errCls.kind) && typeof dsId === "string" && dsId) {
    void noteNetworkDriftFromRunError({ datasourceId: dsId }, run.ErrorMessage).catch(() => undefined);
  }
  // 收口最近一条仍 running 的 run 记录。
  try {
    const { Items = [] } = await docClient.send(new QueryCommand({
      TableName: TABLES.TASK_RUNS, KeyConditionExpression: "taskId = :t",
      ExpressionAttributeValues: { ":t": task.taskId }, ScanIndexForward: false, Limit: 1,
    }));
    if (Items[0]?.status === "running") {
      // 走唯一写通道(条件写 + 保留字自动起别名)。
      await updateRunRecord({
        taskId: task.taskId,
        runId: Items[0].runId,
        set: {
          status: state === "SUCCEEDED" ? "succeeded" : "failed",
          finishedAt: now,
          duration: run.ExecutionTime || 0,
          error: errCls.message || null,
          ...(run.ErrorMessage ? { errorRaw: run.ErrorMessage, errorKind: errCls.kind } : {}),
        },
        // 章按真落点显式盖(同步任务区维在 targets[],裸调必盖 home)
        stamp: resolveRunStamp(task, tid),
      }).catch(() => {});
    }
  } catch { /* best-effort */ }
  return { ...task, status: newStatus };
}

async function reconcileDms(task: SyncTaskRowLike): Promise<SyncTaskRowLike> {
  const arn = task.realtimeConfig?.replicationTaskArn;
  if (typeof arn !== "string" || !arn) return task; // 复制任务还没建出来(编排早期)⇒ 没有可对账的后端事实
  const st = await describeReplicationTaskState(arn);
  if (!st) return task;
  const verdict = judgeDmsReplication(st, String(task.status ?? ""));
  if (!verdict) return task;
  const wrote = await settleSyncChannelVerdict(task, verdict, bindingTargets(task)[0]);
  return wrote ? { ...task, status: verdict.status } : task;
}

async function reconcileZeroEtl(task: SyncTaskRowLike): Promise<SyncTaskRowLike> {
  if (typeof task.integrationArn !== "string" || !task.integrationArn) return task;
  const integration = await getIntegrationStatus(task.integrationArn);
  const verdict = judgeZeroEtlIntegration(integration.status, integration.errors, String(task.status ?? ""));
  if (!verdict) return task;
  const wrote = await settleSyncChannelVerdict(task, verdict, bindingTargets(task)[0]);
  return wrote ? { ...task, status: verdict.status } : task;
}

/**
 * 对账单个同步任务(列表每行每次刷新调一次);返回纠正后的任务对象。
 * 任何一步失败(区解析 / 服务侧查询 / 落库)⇒ 保留原状态 —— 对账只许把「后端已到终态」的事实带回来,不许制造事实。
 */
export async function reconcileSyncTask<T extends SyncTaskRowLike>(task: T): Promise<T> {
  if (!task || !SYNC_IN_FLIGHT_STATUSES.includes(String(task.status ?? ""))) return task;
  try {
    switch (task.channel) {
      case "glue":
        return (await reconcileGlue(task)) as T;
      case "dms":
        return (await reconcileDms(task)) as T;
      case "zero-etl":
        return (await reconcileZeroEtl(task)) as T;
      default:
        return task;
    }
  } catch {
    return task; // 对账失败保留原状态
  }
}
