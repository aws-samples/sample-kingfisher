export const dynamic = "force-dynamic";
// @kf-batch 50-WP28-platform-action-node(WP-29 问数 · CAP-GENBI)
// GET /api/genbi/cards/[cardId]/runs  这张卡的刷新历史(手动 + 定时,同一条 taskId `gcard_<cardId>`)。
// 🔴 只回 run 台账里的非数据字段(时间 / 状态 / 触发方式 / 行数 / 快照 id / 真因);结果行在该区快照里。
import { NextRequest, NextResponse } from "next/server";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { requireIdentity } from "@/lib/auth/identity";
import { requireProject } from "@/lib/projects/guard";
import { apiOk, apiError } from "@/lib/api-response";
import { getCardPointer } from "@/lib/genbi/cards-store";
import { cardScheduleTaskId } from "@/lib/genbi/cards-refresh";

const FIELDS = ["runId", "status", "triggeredBy", "startedAt", "finishedAt", "duration", "rowCount", "snapshotId", "error", "targetId", "scheduler"] as const;

export async function GET(req: NextRequest, props: { params: Promise<{ cardId: string }> }) {
  const params = await props.params;
  const who = await requireIdentity(req);
  if (who instanceof Response) return who;
  const pointer = await getCardPointer(who.sub, params.cardId);
  if (!pointer) return apiError("卡片不存在", 404, { code: "NOT_FOUND" });
  const pctx = await requireProject(req, "viewer", pointer.projectId);
  if (pctx instanceof NextResponse) return pctx;
  try {
    const { Items = [] } = await docClient.send(
      new QueryCommand({
        TableName: TABLES.TASK_RUNS,
        KeyConditionExpression: "taskId = :t",
        ExpressionAttributeValues: { ":t": cardScheduleTaskId(params.cardId) },
        Limit: 100,
      })
    );
    const runs = (Items as Array<Record<string, unknown>>)
      .map((r) => Object.fromEntries(FIELDS.filter((k) => r[k] !== undefined).map((k) => [k, r[k]])))
      .sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
    return apiOk({
      runs,
      lastRefreshedAt: pointer.lastRefreshedAt ?? null,
      lastRefreshStatus: pointer.lastRefreshStatus ?? null,
      refreshCount: pointer.refreshCount ?? 0,
      snapshots: pointer.refreshSnapshots ?? [],
    });
  } catch (e) {
    return apiError(`读取刷新历史失败:${String((e as Error)?.message ?? e)}`, 500);
  }
}
