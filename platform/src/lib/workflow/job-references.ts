// 「这个作业被哪些工作流的离线作业节点引用」的**唯一作者** + 删作业时的 409 拒因(与删源同口径)。
//
// 【为什么要有它】删作业前不核工作流引用 ⇒ 作业行 / Glue 作业 / application 照删,引用它的工作流留在画布里,
//   下一次定时触发才在运行期报「作业不存在」—— 错误离根因很远,而且已经晚了。删前核一遍、被引用就 409 逐条点名,一样不删。
// 【口径(§3.7「项目内」)】扫 `bgp-workflows` 的 `dagDefinition.nodes[].data.jobRef.jobId`,按作业所属项目分两摊:
//   · **本项目**的工作流 ⇒ 逐条点名(id / name / nodeIds),用户自己能去画布里改;
//   · **其他项目**的工作流 ⇒ 一样拒删(删掉会让那张图坏掉),但**只给数量不给名字**(项目隔离:别的项目的对象名不许借 409 泄给本项目)。
//   项目归属用 `resolveRunStamp(...).projectId`(存量无 projectId 的行归默认项目),与作业行 / run 盖章同一口径,不另写缺省。
import { NextResponse } from "next/server";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiError } from "@/lib/api-response";
import { resolveRunStamp } from "@/lib/monitor/run-records";
import { jobRefOf } from "./job-ref";

const USER_ID = "default-user";

export interface WorkflowJobReference {
  id: string;
  name: string;
  projectId?: string;
  /** 引用该作业的节点 id(一张图里可能不止一个) */
  nodeIds: string[];
}

export interface JobReferences {
  /** 与作业同项目的工作流(逐条可点名) */
  inProject: WorkflowJobReference[];
  /** 其他项目里引用了它的工作流**数量**(名字不出项目) */
  otherProjectCount: number;
}

/** 引用了 `jobId` 的工作流,按作业所属项目 `projectId` 分摊(按工作流去重;一张图里多个节点引用同一作业只记一条、nodeIds 列全)。 */
export async function workflowsReferencingJob(jobId: string, projectId: string | null | undefined): Promise<JobReferences> {
  const id = String(jobId ?? "").trim();
  const empty: JobReferences = { inProject: [], otherProjectCount: 0 };
  if (!id) return empty;
  const jobProject = resolveRunStamp({ projectId: projectId ?? undefined }).projectId;
  const out: JobReferences = { inProject: [], otherProjectCount: 0 };
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await docClient.send(
      new ScanCommand({
        TableName: TABLES.WORKFLOWS,
        FilterExpression: "userId = :uid",
        ExpressionAttributeNames: { "#n": "name" },
        ExpressionAttributeValues: { ":uid": USER_ID },
        ProjectionExpression: "workflowId, #n, projectId, dagDefinition",
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      })
    );
    for (const row of (page.Items ?? []) as Array<Record<string, unknown>>) {
      const nodes = ((row.dagDefinition as { nodes?: unknown[] } | undefined)?.nodes ?? []) as Array<{ id?: unknown; type?: unknown; data?: Record<string, unknown> | null }>;
      const nodeIds = nodes
        .filter((n) => n?.type === "job" && jobRefOf(n)?.jobId === id)
        .map((n) => String(n.id ?? ""));
      if (!nodeIds.length) continue;
      const wfProject = resolveRunStamp(row as { projectId?: string }).projectId;
      if (wfProject !== jobProject) {
        out.otherProjectCount += 1;
        continue;
      }
      out.inProject.push({
        id: String(row.workflowId ?? ""),
        name: String(row.name ?? row.workflowId ?? ""),
        ...(typeof row.projectId === "string" ? { projectId: row.projectId } : {}),
        nodeIds,
      });
    }
    ExclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return out;
}

/** 有没有任何引用(本项目逐条 / 其他项目计数)⇒ 删除要拒。 */
export function hasJobReferences(refs: JobReferences): boolean {
  return refs.inProject.length > 0 || refs.otherProjectCount > 0;
}

/**
 * 删作业被拒的响应(409 `JOB_IN_USE`;页面把 message 原话给用户看)。
 *   本项目:`这个作业仍被 N 个工作流的离线作业节点引用:「A」、「B」 —— 已拒绝删除。…`(原话不变);
 *   其他项目:只说 `另有 N 个其他项目的工作流引用了它`,detail 只给计数,不给名字。
 */
export function jobInUseResponse(refs: JobReferences): NextResponse {
  const { inProject, otherProjectCount } = refs;
  const names = inProject.map((r) => `「${r.name}」`).join("、");
  const others = otherProjectCount > 0 ? `另有 ${otherProjectCount} 个其他项目的工作流引用了它` : "";
  const message = inProject.length
    ? `这个作业仍被 ${inProject.length} 个工作流的离线作业节点引用:${names}${others ? `;${others}` : ""} —— 已拒绝删除。` +
      `请先在这些工作流的画布里移除该节点(或改为引用别的作业)再删;删掉会让这些工作流下次运行时在该节点失败。`
    : `这个作业仍被离线作业节点引用:${others} —— 已拒绝删除。` +
      `请先请那些项目的成员在工作流画布里移除该节点(或改为引用别的作业)再删;删掉会让这些工作流下次运行时在该节点失败。`;
  return apiError(message, 409, {
    code: "JOB_IN_USE",
    detail: {
      workflows: inProject.map((r) => ({ id: r.id, name: r.name, nodeIds: r.nodeIds })),
      otherProjects: { count: otherProjectCount },
    },
  });
}
