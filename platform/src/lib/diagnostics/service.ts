// 故障诊断服务：诊断记录 CRUD + 后台编排（构造证据 → 调 DevOps Agent → 存报告）。
// 异步：API 立即创建 running 记录并触发后台调查（fire-and-forget），前端轮询结果。

import { PutCommand, GetCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { ulid } from "ulid";
import { buildIncidentContext, buildFlinkIncidentContext, type IncidentContext } from "./evidence";
import { investigate } from "./devops-agent";
import { recordIncident } from "@/lib/incidents/record";

const PK = "diagnostic";

export interface Diagnostic {
  pk: string;
  diagnosticId: string;
  taskId: string;
  runId: string;
  taskType: string;
  resourceName: string;
  projectId: string;
  status: "running" | "done" | "failed";
  report?: string;
  error?: string;
  agentSpaceId?: string;
  executionId?: string;
  // 本次诊断是否注入了知识库【人工已验证】的历史修复(复利闭环"读"半环留痕)。
  usedIncidentHistory?: boolean;
  // 命中的故障签名(关联 bgp-incidents 主档;未命中为空)。
  incidentSignature?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export async function getDiagnostic(diagnosticId: string): Promise<Diagnostic | null> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.DIAGNOSTICS, Key: { pk: PK, diagnosticId } }));
  return (Item as Diagnostic) || null;
}

// 列出诊断（可按 taskId/runId 过滤）。低量，Query 全部 + 内存过滤。
export async function listDiagnostics(filter?: { taskId?: string; runId?: string; projectId?: string }): Promise<Diagnostic[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.DIAGNOSTICS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": PK },
      ScanIndexForward: false,
    })
  );
  let items = Items as Diagnostic[];
  if (filter?.taskId) items = items.filter((d) => d.taskId === filter.taskId);
  if (filter?.runId) items = items.filter((d) => d.runId === filter.runId);
  if (filter?.projectId) items = items.filter((d) => d.projectId === filter.projectId);
  return items;
}

// 建 running 记录 + 后台跑调查(fire-and-forget):构造证据 → DevOps Agent 调查 → 存报告。
// 诊断可能数十秒,不能阻塞 HTTP(CloudFront 60s)。证据构造由 buildCtx 提供,故同一套留痕/编排
// 既服务 Glue/Redshift/sync(taskId+runId),也服务 Flink(jobId,无 run 记录)。
async function createAndRun(
  base: { taskId: string; runId: string; projectId: string; createdBy: string },
  buildCtx: () => Promise<IncidentContext>,
): Promise<Diagnostic> {
  const now = new Date().toISOString();
  const diagnosticId = ulid();
  const rec: Diagnostic = {
    pk: PK,
    diagnosticId,
    taskId: base.taskId,
    runId: base.runId,
    taskType: "",
    resourceName: "",
    projectId: base.projectId,
    status: "running",
    createdBy: base.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  await docClient.send(new PutCommand({ TableName: TABLES.DIAGNOSTICS, Item: rec }));

  (async () => {
    try {
      const ctx = await buildCtx();
      const result = await investigate(ctx.prompt);
      const finalStatus = result.report ? "done" : "failed";
      await docClient.send(
        new UpdateCommand({
          TableName: TABLES.DIAGNOSTICS,
          Key: { pk: PK, diagnosticId },
          // 落库 usedIncidentHistory/incidentSignature(证据构造时算出,复利闭环留痕)。
          UpdateExpression:
            "SET #s = :s, report = :r, taskType = :tt, resourceName = :rn, agentSpaceId = :a, executionId = :e, usedIncidentHistory = :uih, incidentSignature = :isig, updatedAt = :t",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":s": finalStatus,
            ":r": result.report || "(DevOps Agent 未返回内容)",
            ":tt": ctx.taskType,
            ":rn": ctx.resourceName,
            ":a": result.agentSpaceId,
            ":e": result.executionId,
            ":uih": !!ctx.usedIncidentHistory,
            ":isig": ctx.incidentSignature || "",
            ":t": new Date().toISOString(),
          },
        })
      );
      // 诊断落 done 即时沉淀 hook(复利闭环"写"半环):把这条诊断归一成结构化事件
      // 写 bgp-incidents。幂等(occ 条件写去重),与 reconcile-on-read 兜底路径共存不冲突;
      // best-effort,沉淀失败绝不影响诊断结果对用户可见。
      if (finalStatus === "done") {
        try {
          const finalRec = await getDiagnostic(diagnosticId);
          if (finalRec) await recordIncident(finalRec);
        } catch { /* 沉淀失败不影响诊断 */ }
      }
    } catch (e: any) {
      await docClient
        .send(
          new UpdateCommand({
            TableName: TABLES.DIAGNOSTICS,
            Key: { pk: PK, diagnosticId },
            UpdateExpression: "SET #s = :s, #err = :err, updatedAt = :t",
            ExpressionAttributeNames: { "#s": "status", "#err": "error" },
            ExpressionAttributeValues: { ":s": "failed", ":err": String(e?.message || e).slice(0, 800), ":t": new Date().toISOString() },
          })
        )
        .catch(() => {});
    }
  })();

  return rec;
}

// 创建诊断记录（running）并在后台跑调查。返回 diagnosticId 供前端轮询。
export async function startDiagnosis(input: {
  taskId: string;
  runId: string;
  projectId: string;
  createdBy: string;
}): Promise<Diagnostic> {
  return createAndRun(input, () => buildIncidentContext(input.taskId, input.runId, input.projectId));
}

// 对 Flink(MSAF)流作业发起诊断(无 run 记录,按 jobId 取证)。复用同一留痕/编排。
export async function startFlinkDiagnosis(input: {
  jobId: string;
  projectId: string;
  createdBy: string;
}): Promise<Diagnostic> {
  return createAndRun(
    { taskId: input.jobId, runId: "", projectId: input.projectId, createdBy: input.createdBy },
    () => buildFlinkIncidentContext(input.jobId, input.projectId),
  );
}
