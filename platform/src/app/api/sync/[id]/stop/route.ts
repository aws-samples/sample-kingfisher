export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { getCorrelationId } from "@/lib/observability/logger";
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";

const USER_ID = "default-user";

// POST /api/sync/[id]/stop — 停止同步任务:把后台通道真正停下来,停不下来就不许把状态改成「已停止」。
// 主体在 lib/sync/long-ops.ts(sync-stop,与删除共用同一个下线作者 lib/sync/teardown.ts):执行体等通道真正到终态
//   —— DMS 复制任务还在启动时要先等它启动完才能停 —— 再改状态、收口还挂着「运行中」的运行行、记审计;
//   超 45 秒由统一框架转 202,页面自动轮询到终态(用户只点一次)。「还在停的路上」409 / 「停不下来」502,状态都保持不变。
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const { Item: task } = await docClient.send(
      new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId: params.id } })
    );
    if (!task) return apiError("任务不存在", 404);
    const guard = await guardResourceAccess(req, task, "editor");
    if (guard instanceof NextResponse) return guard;
    const result = await submitLongOp(
      { kind: "sync-stop", params: { taskId: params.id }, correlationId: getCorrelationId(req) },
      { req, identity: guard.identity },
    );
    return longOpResponse(req, result);
  } catch (err: any) {
    const lo = longOpErrorResponse(err);
    if (lo) return lo;
    return apiError(err.message, 500);
  }
}
