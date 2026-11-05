// EMR 运行记录写入器（写共享表 bgp-task-runs）。
// 复刻 lib/etl/job-service.ts:54-106 的 createRunRecord/finishRunRecord/updateJobStatus，
// 但作业表指向 bgp-engine-jobs（ENGINE_JOBS），taskType 固定 "emr-serverless"。
// 保留字 status/duration/error 做 Update 必须 ExpressionAttributeNames 别名（否则整条写入失败）。

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
// 两个 task-runs 写入点改走**唯一写通道**(50 SPEC §6 S10:禁裸 Put/Update 打 task-runs)。
import { putRunRecord, updateRunRecord, resolveRunStamp, type RunOwner } from "@/lib/monitor/run-records";
// 2026-11-04:作业行回写只许落在仍存在的作业行上(条件写不满足 = 行已删 ⇒ 丢弃,不造幽灵行)
import { isConditionalCheckFailed } from "@/lib/aws/ddb-errors";

const USER_ID = "default-user";
/** 2026-11-04:引擎作业行回写的存在性条件(与 ETL 侧 job-service 的 JOB_ROW_EXISTS 同一句;两张作业表主键同形)。 */
export const ENGINE_JOB_ROW_EXISTS = "attribute_exists(jobId)";

/** run 归属取自**作业行**(不是请求头),见 `resolveRunStamp` 的说明。 */
export type EngineJobRef = RunOwner & { jobId: string };

export async function createRunRecord(
  job: EngineJobRef,
  runId: string,
  extra: Record<string, unknown>,
  triggeredBy = "manual",
  // 🔴 **这次真跑的那个 target**(不是作业绑定的第一个)。少了它,非 home 的 EMR run 会盖成 home 的章
  // ⇒ 监控页按区筛静默少报,而且对账/取日志会去 home 找 application(必然找不到)。
  targetId?: string,
  // 多区扇出的关联标识,只透传到写通道的一等参数。
  runGroupId?: string
) {
  await putRunRecord({
    taskId: job.jobId,
    runId,
    taskType: "emr-serverless",
    triggeredBy,
    stamp: resolveRunStamp(job, targetId),
    runGroupId,
    extra, // nativeRunId / applicationId / runDate
  });
}

export async function finishRunRecord(
  job: EngineJobRef,
  runId: string,
  status: string,
  extra: Record<string, unknown> = {}
) {
  await updateRunRecord({
    taskId: job.jobId,
    runId,
    set: { status, finishedAt: new Date().toISOString(), ...extra },
    stamp: resolveRunStamp(job),
  });
}

// 回写作业表（bgp-engine-jobs）的 lastRun* 与 status。
// jobStatus = 作业级枚举（draft/ready/running/succeeded/failed，无 stopped）；
// runStatus = run 级真实态（可含 stopped），省略时同 jobStatus。二者分离是因为 EMR run 有 stopped
// 而作业主表无该枚举（run 记录才是 run 级状态的权威来源，见 bgp-task-runs）。
// 2026-11-04:🔴 条件写 —— UpdateItem 是 upsert,作业行已删时轮询器 / 对账 / stop 的回写会凭空造出一条没有名字的幽灵作业行(与删源后在途探测写回已删行留幽灵行同类)。
export async function updateEngineJobStatus(jobId: string, jobStatus: string, runId: string, runStatus?: string) {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.ENGINE_JOBS,
        Key: { userId: USER_ID, jobId },
        UpdateExpression: "SET #s = :s, lastRunId = :r, lastRunStatus = :ls, lastRunAt = :t, updatedAt = :t",
        ConditionExpression: ENGINE_JOB_ROW_EXISTS,
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": jobStatus, ":r": runId, ":ls": runStatus ?? jobStatus, ":t": new Date().toISOString() },
      })
    );
  } catch (e) {
    if (!isConditionalCheckFailed(e)) throw e;
    console.warn("[emr] 作业行已不存在,丢弃状态回写(不造幽灵行)", JSON.stringify({ jobId, runId, jobStatus, runStatus }));
  }
}

// EMR JobRunState → 统一 4 值状态词表（对齐 bgp-task-runs 约定）。
export function mapEmrState(state?: string): "running" | "succeeded" | "failed" | "stopped" {
  switch (state) {
    case "SUCCESS":
      return "succeeded";
    case "FAILED":
      return "failed";
    case "CANCELLING":
    case "CANCELLED":
      return "stopped";
    default:
      // SUBMITTED / PENDING / QUEUED / SCHEDULED / RUNNING
      return "running";
  }
}

export const EMR_TERMINAL_STATES = ["SUCCESS", "FAILED", "CANCELLED"];
