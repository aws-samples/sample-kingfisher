export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { getReplicationStatus } from "@/lib/realtime/dms-service";
// @kf-batch 56-B128-channel-reconcile —— 终态判定 / 回写与列表读时对账**同一份**(lib/sync/reconcile)
import { applyDmsStatus } from "@/lib/sync/reconcile";

// 模块 31 (R6) — 实时任务运行态(CDC 延迟/已复制行数/状态),供监控展示。viewer+ RBAC。
const USER_ID = "default-user";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item: task } = await docClient.send(
    new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId: params.id } })
  );
  if (!task) return apiError("同步任务不存在", 404, { code: "NOT_FOUND" });
  const ctx = await guardResourceAccess(req, task, "viewer");
  if (ctx instanceof NextResponse) return ctx;

  const taskArn = task.realtimeConfig?.replicationTaskArn;
  if (!taskArn) return apiOk({ provisioned: false, status: task.status || "draft" });

  const st = await getReplicationStatus(taskArn);
  if (!st) return apiOk({ provisioned: true, status: "unknown" });

  // BUG-4(2026-07-04)/ B-128(2026-10-27):DMS 侧 failed、或 stopped 带失败 ⇒ 任务与运行记录如实回写 failed;
  // 全量(full-load)跑完自然 stopped ⇒ stopped / 运行成功;常驻 CDC 正常 running 不动。
  // 🔴 判定与落库不在本路由里写第二遍 —— 列表读时对账与这里共用 `applyDmsStatus`(改动前两处各一份:列表只做 glue,
  //   DMS 失败后列表滞留「运行中」1.5 小时,直到有人打开详情页;运行中的任务还会被残留的 lastFailure 误判成 failed)。
  const settled = await applyDmsStatus(task as never, st);
  return apiOk({ provisioned: true, ...st, ...(settled ? { status: settled } : {}) });
}
