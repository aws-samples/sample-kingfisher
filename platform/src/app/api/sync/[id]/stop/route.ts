export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
// @kf-batch 50-WP24-sync-teardown —— 停/删共用**同一个**下线作者(见 lib/sync/teardown.ts 顶部注释)
import { teardownSyncChannel, teardownFailureMessage, teardownIsRetryable } from "@/lib/sync/teardown";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { guardResourceAccess } from "@/lib/projects/guard";
// @kf-batch 52-P52.2-W2a-run-stamp — task-runs 唯一写通道(50 SPEC §6 S10)。
import { settleRunningRuns, resolveRunStamp } from "@/lib/monitor/run-records";
import { updateSyncTaskIfExists } from "@/lib/sync/task-write";


const USER_ID = "default-user";

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const { Item: task } = await docClient.send(
      new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId: params.id } })
    );
    if (!task) return apiError("任务不存在", 404);
    const guard = await guardResourceAccess(req, task, "editor");
    if (guard instanceof NextResponse) return guard;

    // 🔴🔴 真下线走**单一作者**(改动前这里的三处都不成立:zero-etl 删集成失败被 `catch {}` 吞掉、
    //   Glue 用 `JobRunIds: []` **停不了任何 run**、**DMS 通道压根没被处理**(全仓没有
    //   StopReplicationTask)⇒ 页面显示「已停止」而后台照跑照计费,多法域下就是停不下来的跨境流动)。
    const td = await teardownSyncChannel(task as never, { purge: false });
    if (td.hardFailures.length) {
      // 🔴 停不下来就**不许**把 status 改成 stopped(与 WP-18d 同一条不变量:
      //   记录不许比现实更「已停止」;台账留着,用户还能再点一次)。
      // 🔴 「还在停的路上」⇒ **409 可重试**;「停不下来」⇒ 502 故障。
      //   两者混成一个码 = 把可恢复说成坏了(而 504 更糟:那是「不知道成没成」)。
      const retryable = teardownIsRetryable(td);
      return apiError(
        teardownFailureMessage(td, retryable
          ? "任务状态**保持不变** —— 复制任务**正在停的路上**,过几十秒再点一次「停止」即可。"
          : "任务状态**保持不变** —— 它没能真正停下来,请重试或查该通道的服务侧状态。"),
        retryable ? 409 : 502,
        retryable
          ? { code: "TEARDOWN_IN_PROGRESS", detail: { teardown: td, retryable: true } }
          : { code: "UPSTREAM_ERROR", detail: { teardown: td } }
      );
    }

    const now = new Date().toISOString();
    // @kf-batch 50-B08-sync-task-write-guard —— 唯一写通道
    await updateSyncTaskIfExists({
      taskId: params.id,
      UpdateExpression: "SET #s = :s, updatedAt = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "stopped", ":now": now },
    });

    // B10-FIX: close out any run still stuck in "running" for this task. Realtime (DMS) runs
    // have no pollGlueJob to write a terminal state, so stopping/destroying left them pinned
    // at running forever — polluting the monitor "运行中" count and misleading users.
    // @kf-batch 52-P52.2-W2a-run-stamp — 同款循环收敛到 settleRunningRuns(并补上原先缺的翻页)。
    try {
      await settleRunningRuns({ taskId: params.id, status: "stopped", set: { finishedAt: now }, stamp: resolveRunStamp(task) });
    } catch {}

    recordAudit(req, "sync.stop", { resourceType: "sync", resourceId: params.id, detail: { name: task.name, teardown: td } }).catch(() => {});

    return apiOk({ stopped: true, teardown: td });
  } catch (err: any) {
    return apiError(err.message, 500);
  }
}
