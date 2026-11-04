export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { stripTransientNodeData } from "@/lib/workflow/node-data-transient";
import { hasTargetsPatch, requestedTargets } from "@/lib/place/resolve";
import { GetCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { recordAudit } from "@/lib/audit";
import { guardResourceAccess } from "@/lib/projects/guard";
import { snapshotVersion } from "@/lib/versions/version-service";
import { getCorrelationId } from "@/lib/observability/logger";
// 删除主体(先逐区收走 DAG 再删行,unpublishWorkflowDag 单一作者)在 lib/workflow/long-ops.ts(workflow-delete);
//   对象租约 `workflow:<id>`:发布 / 下线 / 触发 / 删除进行中,PUT 编辑 ⇒ 409「正在进行中」。
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";
import { resourceBusyResponse } from "@/lib/long-ops/guard";
import { resourceKey } from "@/lib/long-ops/kinds";
// 改绑定也要过同一道校验(不从 ...body 裸抄)
import { isValidTargetId, HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { requireMwaaForTargets, MwaaNotInstalled, mwaaErrorResponse } from "@/lib/scheduler/mwaa-endpoint";

const USER_ID = "default-user";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.WORKFLOWS, Key: { userId: USER_ID, workflowId: params.id } })
  );
  if (!Item) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const guard = await guardResourceAccess(req, Item, "viewer");
  if (guard instanceof NextResponse) return guard;
  return NextResponse.json(Item);
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item: current } = await docClient.send(
    new GetCommand({ TableName: TABLES.WORKFLOWS, Key: { userId: USER_ID, workflowId: params.id } })
  );
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const guard = await guardResourceAccess(req, current, "editor");
  if (guard instanceof NextResponse) return guard;
  // 对象租约:这条编排的发布 / 下线 / 触发 / 删除还在进行 ⇒ 409,不改定义
  const busy = await resourceBusyResponse([resourceKey("workflow", params.id)]);
  if (busy) return busy;

  const body = await req.json();
  // Tenancy attributes are immutable from this endpoint.
  delete body.userId;
  delete body.projectId;
  delete body.createdBy;
  delete body.createdBySub;
  // 🔴 `targets`(绑定)是权威字段,**不许从 ...body 裸抄**:PUT 原来直接把它写进 DDB ⇒ 可以改成
  //    任意字符串、或改到一个**没装调度组件**的区(那之后发布/触发都会在运行期才炸,且指不到根因)。
  if (hasTargetsPatch(body)) {
    // 解析走唯一作者(空 / 非法 ⇒ 400;本路由沿用自己的错误信封)
    let want: string[];
    try {
      want = requestedTargets(body, "修改编排绑定");
    } catch (e) {
      return NextResponse.json({ error: `targets 不能为空且必须合法(编排至少绑一个执行区):${(e as Error).message}`, code: "VALIDATION_FAILED" }, { status: 400 });
    }
    const nonHome = want.filter((t) => t !== HOME_TARGET_ID);
    if (nonHome.length) {
      try {
        await requireMwaaForTargets(nonHome);
      } catch (e) {
        if (e instanceof MwaaNotInstalled) return mwaaErrorResponse(e);
        throw e;
      }
    }
    body.targets = want;
    delete body.targetId; // 只保留一个真值源(PUT 不许带裸 targetId 绕过校验写进库)
  }
  // 节点 data 里的编辑期派生字段(jobMissing)不落库 —— 权威只有 jobRef,派生值在画布上算、不进定义(唯一作者 node-data-transient.ts)
  if (body.dagDefinition !== undefined) body.dagDefinition = stripTransientNodeData(body.dagDefinition);
  const fields = Object.keys(body);
  if (fields.length === 0) return NextResponse.json({ error: "无更新字段" }, { status: 400 });
  const expr = fields.map((k, i) => `#f${i} = :v${i}`).join(", ");
  const names = Object.fromEntries(fields.map((k, i) => [`#f${i}`, k]));
  const values = Object.fromEntries(fields.map((k, i) => [`:v${i}`, body[k]]));

  const { Attributes } = await docClient.send(
    new UpdateCommand({
      TableName: TABLES.WORKFLOWS,
      Key: { userId: USER_ID, workflowId: params.id },
      UpdateExpression: `SET ${expr}, #upd = :now`,
      ExpressionAttributeNames: { ...names, "#upd": "updatedAt" },
      ExpressionAttributeValues: { ...values, ":now": new Date().toISOString() },
      ReturnValues: "ALL_NEW",
    })
  );
  await snapshotVersion("workflow", params.id, Attributes as any, guard.identity.username, "保存").catch(() => {});
  return NextResponse.json(Attributes);
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.WORKFLOWS, Key: { userId: USER_ID, workflowId: params.id } })
  );
  if (!Item) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const guard = await guardResourceAccess(req, Item, "editor");
  if (guard instanceof NextResponse) return guard;
  // 🔴 **先收走 DAG,再删记录**;逐区都撤干净才删行(撤不下来 ⇒ 502 保留记录)—— 主体在执行体 workflow-delete。
  try {
    const result = await submitLongOp(
      { kind: "workflow-delete", params: { workflowId: params.id }, correlationId: getCorrelationId(req) },
      { req, identity: guard.identity },
    );
    return longOpResponse(req, result);
  } catch (e: any) {
    const lo = longOpErrorResponse(e);
    if (lo) return lo;
    return NextResponse.json(
      { success: false, error: { code: "DAG_CLEANUP_FAILED", message: `删不掉该工作流在执行区的 DAG 文件(${String(e?.message || e).slice(0, 200)});记录保留,请重试` } },
      { status: 502 }
    );
  }
}
