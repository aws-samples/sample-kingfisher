export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
// @kf-batch 50-WP7-sync-pushdown —— 产物桶在任务章说的那个区(S3 客户端跨区列桶会被 301 重定向拒)。
import { bindingTargets, regionOfTarget } from "@/lib/exec-env/data-plane-target";
import { s3ClientFor } from "@/lib/exec-env/target-clients";

const USER_ID = "default-user";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const { Item: task } = await docClient.send(new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId: params.id } }));
    if (!task) return apiError("任务不存在", 404);
    const guard = await guardResourceAccess(req, task, "viewer");
    if (guard instanceof NextResponse) return guard;

    const tid = bindingTargets(task as { targets?: unknown; targetId?: unknown })[0];
    const s3 = await s3ClientFor(await regionOfTarget(tid));
    const bucket = task.s3Config?.bucket;
    const prefix = task.s3Config?.prefix || "";
    if (!bucket) return apiOk([]);

    // List files for each source table
    const files: any[] = [];
    for (const table of task.sourceTables || []) {
      const tablePrefix = `${prefix}${table}/`;
      try {
        const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: tablePrefix, MaxKeys: 50 }));
        for (const obj of Contents) {
          files.push({
            key: obj.Key,
            size: obj.Size,
            lastModified: obj.LastModified?.toISOString(),
            table,
          });
        }
      } catch {}
    }

    return apiOk(files);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
