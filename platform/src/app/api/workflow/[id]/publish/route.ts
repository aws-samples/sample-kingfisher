export const dynamic = "force-dynamic";
// @kf-batch 50-WP13-mwaa-region
// @kf-batch 50-WP4quater-reads(工单 SC-3)—— 发布 / 解暂停都打**这个工作流自己那个区**的 Airflow
// @kf-batch 50-WP17-serverless-workflow —— 多节点编排现在**发得到** serverless;
// 真正无对应物的只有 `external` 节点(服务侧 sensor 被 operator 白名单拒 + run 没有 logical date)⇒ 400。
// 🔴 那两个错误类的 `instanceof` 判定已搬到 `schedulerRejectResponse`(单一作者),本文件不再直接引它们。
// 模块 55 / 序 50 第二批:发布主体(publishWorkflowDag 逐区发布 → 写 active → 等解挂 → 审计)在 lib/workflow/long-ops.ts(workflow-publish)。
//   serverless ensureWorkflow 重试最多 60s、经典 MWAA 解挂等调度器加载最多 3 分钟 ⇒ 超 45 秒由统一框架转 202,
//   页面右下「正在后台执行:发布工作流」;响应体保持历史的摊平形状(rawBody)。对象租约 `workflow:<id>`。
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { guardResourceAccess } from "@/lib/projects/guard";
import { getCorrelationId } from "@/lib/observability/logger";
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";

const USER_ID = "default-user";

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.WORKFLOWS, Key: { userId: USER_ID, workflowId: params.id } })
  );
  if (!Item) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const guard = await guardResourceAccess(req, Item, "editor");
  if (guard instanceof NextResponse) return guard;

  try {
    const result = await submitLongOp(
      { kind: "workflow-publish", params: { workflowId: params.id }, correlationId: getCorrelationId(req) },
      { req, identity: guard.identity },
    );
    return longOpResponse(req, result);
  } catch (err: any) {
    const lo = longOpErrorResponse(err);
    if (lo) return lo;
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
