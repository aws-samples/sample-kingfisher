// 「双写回链」在页面上的**两个方向的链接地址,唯一作者**(纯函数,浏览器可 import)。
//
//   · 作业 / 同步任务的运行历史行(`triggeredBy === "workflow"`,行上带 workflowId / workflowRunId / workflowName)
//     → 点回**工作流实例**:`/workflow/<workflowId>?run=<workflowRunId>`(工作流详情页读 `?run=` 自动打开那次运行的「节点详情」)。
//   · 工作流实例的「节点详情」里每个作业 / 同步节点 → 点回**作业自己的运行历史**:
//       ETL / EMR 作业都在离线计算页:`/etl-jobs?jobId=<jobId>&tab=runs`(页面读这两个参数选中作业并切到「运行历史」);
//       同步任务:`/sync/<taskId>`(详情页的运行历史页签)。
// 🔴 runId 形如 `<raw>#<targetId>`(复合键):`#` 在 URL 里是 fragment 起点 ⇒ 必须 encodeURIComponent,否则工作流页只收到前半段。
// 🔴 这里只拼地址、不读任何浏览器状态;两边页面读参数一律在挂载后的 effect 里做(水合纪律)。
import { jobRefOf, type WorkflowNodeLike } from "./job-ref";
import type { JobNodeRef } from "@/types/workflow";

/** 离线计算页认的页签参数(闭合;别的值一律忽略,不猜)。 */
export const ETL_JOBS_TABS = ["edit", "runs", "rungroups"] as const;
export type EtlJobsTab = (typeof ETL_JOBS_TABS)[number];
export function isEtlJobsTab(v: unknown): v is EtlJobsTab {
  return (ETL_JOBS_TABS as readonly string[]).includes(String(v ?? ""));
}

/** 运行行 → 触发它的工作流实例。没有 workflowId ⇒ null(老行 / 不是工作流触发的行不给链接)。 */
export function workflowRunHref(run: { workflowId?: unknown; workflowRunId?: unknown }): string | null {
  const wf = String(run?.workflowId ?? "").trim();
  if (!wf) return null;
  const rid = String(run?.workflowRunId ?? "").trim();
  return `/workflow/${encodeURIComponent(wf)}${rid ? `?run=${encodeURIComponent(rid)}` : ""}`;
}

/** 工作流实例节点 → 它引用的作业 / 同步任务(发布定义里读出来的事实,随节点行一起回给页面)。 */
export type NodeBackLink =
  | { nodeId: string; nodeType: "job"; kind: JobNodeRef["kind"]; jobId: string }
  | { nodeId: string; nodeType: "sync"; syncTaskId: string };

/** 一个 dagDefinition 节点的回链事实;不是作业 / 同步节点、或引用缺失 ⇒ null。 */
export function nodeBackLinkOf(node: WorkflowNodeLike): NodeBackLink | null {
  const nodeId = String(node?.id ?? "");
  if (node?.type === "job") {
    const ref = jobRefOf(node);
    return ref ? { nodeId, nodeType: "job", kind: ref.kind, jobId: ref.jobId } : null;
  }
  if (node?.type === "sync") {
    const taskId = String(node?.data?.syncTaskId ?? "").trim();
    return taskId ? { nodeId, nodeType: "sync", syncTaskId: taskId } : null;
  }
  return null;
}

/** 回链 → 页面地址(ETL 与 EMR 作业同在离线计算页,按 jobId 选中 + 切到运行历史;同步任务进详情页)。 */
export function nodeBackLinkHref(link: NodeBackLink | null | undefined): string | null {
  if (!link) return null;
  if (link.nodeType === "sync") return `/sync/${encodeURIComponent(link.syncTaskId)}`;
  return `/etl-jobs?jobId=${encodeURIComponent(link.jobId)}&tab=runs`;
}
