export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { getIntegrationStatus, ensureDestinationDatabase, getReplicatedCounts } from "@/lib/realtime/zeroetl-service";
import { updateSyncTaskIfExists } from "@/lib/sync/task-write";
// @kf-batch 56-B128-channel-reconcile —— 集成 failed 的判定 / 落库与列表读时对账**同一份**(lib/sync/reconcile)
import { applyZeroEtlStatus } from "@/lib/sync/reconcile";

// 模块 31 (Zero-ETL) — 增量同步(真·CDC)运行态:集成状态 + 已复制行数。viewer+ RBAC。
//
// 幂等推进(进程重启可恢复):若集成已 active 但任务仍 provisioning,则在此补建目标库并把任务
// 置 running——这样即便 /start 的后台长轮询进程被回收,用户打开详情页轮询本端点也能推进到位。
const USER_ID = "default-user";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item: task } = await docClient.send(
    new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId: params.id } })
  );
  if (!task) return apiError("同步任务不存在", 404, { code: "NOT_FOUND" });
  const ctx = await guardResourceAccess(req, task, "viewer");
  if (ctx instanceof NextResponse) return ctx;

  const integrationArn = task.integrationArn;
  const cfg = task.zeroEtlConfig || {};
  if (!integrationArn) {
    return apiOk({ provisioned: false, status: task.status || "draft", channel: task.channel });
  }

  let integrationStatus = "unknown";
  let errors: string[] = [];
  try {
    const s = await getIntegrationStatus(integrationArn);
    integrationStatus = s.status;
    errors = s.errors;
  } catch (e: any) {
    return apiOk({ provisioned: true, integrationStatus: "unknown", status: task.status, workgroup: cfg.workgroup, destDb: cfg.destDb, error: String(e?.message || e).slice(0, 200) });
  }

  let effectiveStatus = task.status;
  let counts: { table: string; rows: number | null }[] = [];

  if (integrationStatus === "active") {
    // 幂等推进:补建目标库(已存在则跳过)+ 把任务置 running。
    if (cfg.destDb && cfg.integrationId) {
      try {
        await ensureDestinationDatabase(cfg.destDb, cfg.integrationId);
        if (task.status !== "running") {
          // @kf-batch 50-B08-sync-task-write-guard —— 唯一写通道
          await updateSyncTaskIfExists({
            taskId: params.id,
            UpdateExpression: "SET #s = :s, updatedAt = :now REMOVE zeroEtlError",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":s": "running", ":now": new Date().toISOString() },
          });
        }
        effectiveStatus = "running";
        // 已复制行数(best-effort;源表来自任务配置)。
        if (cfg.schema && Array.isArray(task.sourceTables) && task.sourceTables.length > 0) {
          counts = await getReplicatedCounts(cfg.destDb, cfg.schema, task.sourceTables);
        }
      } catch (e: any) {
        return apiOk({ provisioned: true, integrationStatus, status: task.status, workgroup: cfg.workgroup, destDb: cfg.destDb, error: String(e?.message || e).slice(0, 200) });
      }
    }
  } else if (integrationStatus === "failed") {
    // B-128:改动前这里只把响应算成 error、**不落库** ⇒ 列表仍「运行中」。现在与列表对账共用一份判定 + 条件写
    //   (任务行 error + zeroEtlError;运行记录收口 failed;用户已停止则让路)。
    effectiveStatus = (await applyZeroEtlStatus(task as never, integrationStatus, errors)) ?? "error";
  } else {
    effectiveStatus = "provisioning";
  }

  return apiOk({
    provisioned: true,
    integrationStatus,
    status: effectiveStatus,
    workgroup: cfg.workgroup,
    destDb: cfg.destDb,
    schema: cfg.schema,
    counts,
    errors,
  });
}
