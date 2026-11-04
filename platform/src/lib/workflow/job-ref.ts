// 离线作业节点「引用」的**纯函数作者**(浏览器与服务端都能 import:零 AWS / 零 DDB 依赖)。
//
// 【为什么单独一个文件】`jobRefOf` 原来长在 job-node-spec.ts 里,而那个文件 import 了 DynamoDB 文档客户端与两个 spec 作者
//   ⇒ 页面(节点详情弹窗要把运行里的节点点回作业)没法 import 它。把「节点上的引用怎么读」抽到这里,
//   job-node-spec / job-references / back-links 都从这一份读,解析规则(kind 闭合 + jobId 非空)只有一处。
import { JOB_NODE_KINDS, type JobNodeRef } from "@/types/workflow";

/** 节点里只读得到的那几样(dagDefinition.nodes[] 是 any[];这里收窄成读引用要的形状)。 */
export interface WorkflowNodeLike {
  id?: unknown;
  type?: unknown;
  data?: { label?: unknown; jobRef?: unknown; syncTaskId?: unknown; [k: string]: unknown } | null;
}

/** 节点上的作业引用(形态合法才返回;`kind` 必须在闭合清单里,jobId 非空)。 */
export function jobRefOf(node: WorkflowNodeLike): JobNodeRef | null {
  const ref = node?.data?.jobRef as { kind?: unknown; jobId?: unknown } | undefined;
  const kind = String(ref?.kind ?? "");
  const jobId = String(ref?.jobId ?? "").trim();
  if (!(JOB_NODE_KINDS as readonly string[]).includes(kind) || !jobId) return null;
  return { kind: kind as JobNodeRef["kind"], jobId };
}
