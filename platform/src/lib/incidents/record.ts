// 沉淀 hook:把一条 done 诊断归一成结构化事件写入 bgp-incidents。零侵入
// 只【读取】诊断记录 + 关联 run,不改诊断主流程。可由 reconcile(A.1)或升级后的 AgentCore
// 编排(A.2)调用。幂等:同一 diagnosticId 只沉淀一次(occ 条件写);主档 occurrenceCount 原子累加。

import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import type { Diagnostic } from "@/lib/diagnostics/service";
import { computeSignature } from "./signature";
import { buildSymptomDigest, buildRootCauseSummary } from "./redact";
import { upsertMaster, putOccurrenceIfNew, incidentPk, occSk } from "./store";

export interface RecordResult {
  recorded: boolean; // 是否新沉淀(false = 已存在或跳过)
  signature?: string;
  reason?: string; // 跳过原因(非 done / 无错误文本等)
}

// 从关联运行取错误文本:Glue/Redshift/sync 读 bgp-task-runs.error;Flink 读 bgp-flink-jobs.lastError。
// 与 lib/diagnostics/evidence.ts 的取数一致(诊断本身不持久化原始错误,故须回读)。
//
// 顺带把**这次跑在哪个区**取回来。
// 🔴 为什么在这里取而不是让 `Diagnostic` 加字段:`Diagnostic` 是类型,而知识库对它是
// **零侵入**(只读不改)。run 行上本来就有 `targetId`(run-records 的章),而这个函数**已经在读那一行**
// 顺手带回来是零额外往返;让诊断类型长一个字段则要改写侧,违反零侵入。
// 🔴 取不到就留空,由读侧 `bindingTargets` 统一回落主控区 —— 绝不在这里瞎猜一个区。
async function fetchRunFacts(diag: Diagnostic): Promise<{ errorText: string; targetId?: string }> {
  const taskType = (diag.taskType || "").toLowerCase();
  try {
    if (taskType === "flink") {
      const { Item } = await docClient.send(
        new GetCommand({ TableName: TABLES.FLINK_JOBS, Key: { userId: "default-user", jobId: diag.taskId }, ProjectionExpression: "lastError, targetId, targets" })
      );
      // Flink 作业行上眼下还没有区维⇒ 读到就用,读不到留空由读侧回落
      const t = typeof Item?.targetId === "string" ? Item.targetId : Array.isArray(Item?.targets) ? String(Item!.targets[0] ?? "") : "";
      return { errorText: String(Item?.lastError || ""), targetId: t || undefined };
    }
    if (diag.taskId && diag.runId) {
      const { Item } = await docClient.send(
        new GetCommand({ TableName: TABLES.TASK_RUNS, Key: { taskId: diag.taskId, runId: diag.runId }, ProjectionExpression: "#e, targetId", ExpressionAttributeNames: { "#e": "error" } })
      );
      const t = typeof Item?.targetId === "string" ? Item.targetId : "";
      return { errorText: String(Item?.error || ""), targetId: t || undefined };
    }
  } catch {
    /* best-effort:取不到错误文本时用空串,signature 走 no-error-text 桶 */
  }
  return { errorText: "" };
}

// 沉淀一条 done 诊断。只处理 status==="done"(失败的诊断自身不代表一次可归并的管道故障)。
export async function recordIncident(diag: Diagnostic): Promise<RecordResult> {
  if (!diag || diag.status !== "done") return { recorded: false, reason: "not-done" };

  const { errorText, targetId } = await fetchRunFacts(diag);
  const { signature, engine, symptomTemplate } = computeSignature(diag.taskType, errorText);

  // 症状摘要与根因归纳都走脱敏(不落表名/账号/路径)。
  const symptomDigest = buildSymptomDigest(errorText) || symptomTemplate;
  const rootCauseSummary = buildRootCauseSummary(diag.report, errorText);
  const occurredAt = diag.updatedAt || diag.createdAt || new Date().toISOString();
  const taskName = diag.resourceName || diag.taskId;

  // 先条件写发生记录(幂等去重键 = diagnosticId)。已存在 → 整体跳过,不重复累加计数。
  const isNew = await putOccurrenceIfNew({
    pk: incidentPk(diag.projectId),
    sk: occSk(signature, diag.diagnosticId),
    projectId: diag.projectId,
    signature,
    occurredAt,
    taskId: diag.taskId,
    taskName,
    taskType: diag.taskType || "unknown",
    runId: diag.runId || "",
    diagnosticId: diag.diagnosticId,
    symptomDigest,
    ...(targetId ? { targetId } : {}),
  });

  if (!isNew) return { recorded: false, signature, reason: "already-recorded" };

  // 新发生 → 归并 upsert 主档(occurrenceCount 原子 +1)。
  await upsertMaster({
    projectId: diag.projectId,
    signature,
    engine,
    title: symptomTemplate,
    taskName,
    occurredAt,
    rootCauseSummary,
    targetId,
  });

  return { recorded: true, signature };
}
