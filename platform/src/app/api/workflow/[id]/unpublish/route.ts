export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { guardResourceAccess } from "@/lib/projects/guard";
import { getCorrelationId } from "@/lib/observability/logger";
// @kf-batch 50-WP17-serverless-workflow
// 🔴 原来这里直接调 `offlineDag(dagId)` —— **不传 target ⇒ 恒打主控区**:工作流绑在别的区时,
//    pause 与删 DAG 文件都作用在 home(静默 no-op),那个区的 DAG 继续按 cron 跑(与段 `scq` A2-3 同病)。
//    现在统一走 `unpublishWorkflowDag`(它按落点解析端点,并且经典 / serverless 两种都能撤)。
// 模块 55 / 序 50 第二批:下线主体(unpublishWorkflowDag 逐区撤 → 台账清每个撤下来的区 → 审计)在 lib/workflow/long-ops.ts(workflow-unpublish)。
//   serverless deleteWorkflow 要等在跑的 run 停完(最多 2 分钟)⇒ 超 45 秒由统一框架转 202;响应体保持摊平形状(rawBody)。
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";

const USER_ID = "default-user";

// 下线(发布的逆操作):pause DAG + 删 S3 DAG 文件 + 状态回 draft、关调度。
// 之前平台只有"发布",要撤下调度得手动登 MWAA 删 DAG——此端点补齐闭环。
// 幂等:未发布(无 airflowDagId)按已下线处理;DAG 文件不存在不报错。
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
      { kind: "workflow-unpublish", params: { workflowId: params.id }, correlationId: getCorrelationId(req) },
      { req, identity: guard.identity },
    );
    return longOpResponse(req, result);
  } catch (err: any) {
    const lo = longOpErrorResponse(err);
    if (lo) return lo;
    // 🔴 撤不下来就**不许**把记录改成 draft(状态必须与「调度还在那儿」一致 —— T-14 的教训)
    return NextResponse.json({ error: `下线失败: ${err.message}`, code: "DAG_CLEANUP_FAILED" }, { status: 502 });
  }
}
