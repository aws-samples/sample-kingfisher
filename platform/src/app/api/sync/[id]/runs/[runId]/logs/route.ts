export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
// 日志按**这条 run 自己的章**取(run-cancel 同款):
// 日志存在跑它的那个区的 scripts 桶(pollGlueJob 写入侧),桶名/区都从 binding 解析,
// 存量 run 无 targetId ⇒ home(与 resolveRunStamp 的三级回落同一条理由)。
import { resolveGlueBinding, stampedTargetOf } from "@/lib/exec-env/data-plane-target";
import { s3ClientFor } from "@/lib/exec-env/target-clients";

const USER_ID = "default-user";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string; runId: string }> }
) {
  const params = await props.params;
  try {
    const { Item: task } = await docClient.send(
      new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId: params.id } })
    );
    if (task) {
      const guard = await guardResourceAccess(req, task, "viewer");
      if (guard instanceof NextResponse) return guard;
    }
    const { Item: run } = await docClient.send(new GetCommand({
      TableName: TABLES.TASK_RUNS, Key: { taskId: params.id, runId: params.runId },
    }));

    if (!run) return apiOk({ logs: ["运行记录不存在"], source: "none" });

    // 实时(CDC)任务把编排步骤日志内联存在运行记录里(无 Glue/S3 日志),直接返回。
    if (Array.isArray(run.logs) && run.logs.length > 0) {
      return apiOk({ logs: run.logs, source: "inline", status: run.status });
    }

    // Try S3 first
    if (run.logS3Key) {
      try {
        const landing = await resolveGlueBinding({ targetId: stampedTargetOf(run) });
        const bucket = landing.scriptsBucket;
        const s3 = await s3ClientFor(landing.region);
        const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: run.logS3Key }));
        const text = await Body?.transformToString();
        if (text) {
          return apiOk({ logs: text.split("\n"), source: "s3", s3Key: run.logS3Key });
        }
      } catch {}
    }

    return apiOk({ logs: ["日志尚未生成，任务完成后将自动保存到 S3"], source: "pending", status: run.status });
  } catch (e: any) {
    return apiOk({ logs: [`日志加载失败: ${e.message}`], source: "error" });
  }
}
