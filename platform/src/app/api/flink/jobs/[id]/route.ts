export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand, DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
// 执行角色 ARN 形态 / 保存期预检的唯一作者
import { roleArnShapeRejection } from "@/lib/execution-role/resolve";
import { preflightCustomRoleForTargets } from "@/lib/execution-role/preflight";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { normalizeFlinkSql, flinkJobTarget } from "@/lib/realtime/flink-service";
import { guardCode } from "@/lib/cookbook";
import { getCorrelationId } from "@/lib/observability/logger";
// 删除主体(requestFlinkDeletion 等 MSAF 停稳 → 销毁 → 删行 / 已受理 202)在 lib/realtime/long-ops.ts(flink-delete);
//   对象租约 `flink:<jobId>`:启动 / 停止 / 删除进行中,PUT 编辑 ⇒ 409「正在进行中」。
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";
import { resourceBusyResponse } from "@/lib/long-ops/guard";
import { resourceKey } from "@/lib/long-ops/kinds";

const USER_ID = "default-user";

// 仅这些状态允许编辑作业定义(SQL/网络/资源);运行中不可改(须先停止)。
const EDITABLE_STATUS = ["draft", "stopped", "error", "deleted"];

async function getJob(id: string) {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.FLINK_JOBS, Key: { userId: USER_ID, jobId: id } }));
  return Item;
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const job = await getJob(params.id);
  if (!job) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const ctx = await guardResourceAccess(req, job, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  return apiOk(job);
}

// PUT /api/flink/jobs/[id] — 编辑作业定义(SQL/网络/资源)。仅 draft/stopped/error/deleted 可编辑;
// 运行中(running/starting)须先停止。修复:此前作业发布后前端只读,无法改 SQL/网络。
export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const job = await getJob(params.id);
  if (!job) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const ctx = await guardResourceAccess(req, job, "editor");
  if (ctx instanceof NextResponse) return ctx;
  // 对象租约:这个作业的启动 / 停止 / 删除还在进行 ⇒ 409,不改定义
  const busy = await resourceBusyResponse([resourceKey("flink", params.id)]);
  if (busy) return busy;

  if (!EDITABLE_STATUS.includes(String(job.status))) {
    return apiError(`作业当前状态为「${job.status}」,运行中不可编辑;请先停止作业再修改。`, 409, { code: "CONFLICT" });
  }

  let body: any;
  try { body = await req.json(); } catch { return apiError("请求体无效", 400, { code: "VALIDATION_FAILED" }); }

  // 执行角色 ARN 归一(可选):提供了才校验;空串=清空回退平台默认(转 null 参与白名单更新)。
  if (body.executionRoleArn !== undefined) {
    const v = String(body.executionRoleArn || "").trim();
    const shapeReject = v ? roleArnShapeRejection(v) : null;
    if (shapeReject) return apiError(shapeReject, 400, { code: "VALIDATION_FAILED" });
    body.executionRoleArn = v || null;
    // 改成自定义角色 ⇒ 按作业落点预检(信任 kinesisanalytics + 引擎基线),缺 ⇒ 400 指路、不落库
    if (v) {
      const pfRes = await preflightCustomRoleForTargets({ engine: "flink", customRoleArn: v, targets: [flinkJobTarget(job)] });
      if (pfRes) return pfRes;
    }
  }

  // 🔴 SQL 保存前规范化(与启动注入路径同源,保证 DDB/页面/MSAF 三处一致)——
  //    ① normalizeFlinkSql:压平累进缩进/删空行注释(页面 Monaco 编辑会逐行累进缩进,存库会越来越乱);
  //    ② guardCode(flink):跑方言 guard 的机械纠正(如去除末尾编辑器残留的孤立右括号 —— 否则
  //       runner 按 ; 切分会切出独立语句 ')' → Calcite `Encountered ")"` → 启动即崩)。
  //    只清理格式/结构残留,不改变任何真实语句语义。这样用户下次打开编辑器看到的即干净版。
  if (typeof body.sql === "string" && body.sql.trim()) {
    body.sql = guardCode("flink", normalizeFlinkSql(body.sql));
  }

  // 白名单可改字段(不动 jobId/appName/状态/审计字段)。
  const sets: string[] = ["updatedAt = :now"];
  const names: Record<string, string> = {};
  const values: Record<string, any> = { ":now": new Date().toISOString() };
  const allow: Array<[string, string]> = [
    ["name", "name"], ["sql", "sql"], ["sinkType", "sinkType"], ["sinkDatasourceId", "sinkDatasourceId"],
    ["sourceType", "sourceType"], ["sourceDatasourceId", "sourceDatasourceId"], ["connectorIds", "connectorIds"],
    ["vpcSubnets", "vpcSubnets"], ["vpcSecurityGroups", "vpcSecurityGroups"],
    ["parallelism", "parallelism"], ["parallelismPerKPU", "parallelismPerKPU"], ["autoScalingEnabled", "autoScalingEnabled"],
    ["checkpointingEnabled", "checkpointingEnabled"], ["checkpointIntervalMs", "checkpointIntervalMs"], ["minPauseBetweenCheckpointsMs", "minPauseBetweenCheckpointsMs"],
    ["logLevel", "logLevel"], ["metricsLevel", "metricsLevel"], ["snapshotsEnabled", "snapshotsEnabled"], ["runtimeProperties", "runtimeProperties"],
    ["executionRoleArn", "executionRoleArn"],
  ];
  for (const [key, attr] of allow) {
    if (body[key] !== undefined) {
      names[`#${attr}`] = attr;
      values[`:${attr}`] = body[key];
      sets.push(`#${attr} = :${attr}`);
    }
  }
  if (sets.length === 1) return apiError("没有可更新的字段", 400, { code: "VALIDATION_FAILED" });

  await docClient.send(new UpdateCommand({
    TableName: TABLES.FLINK_JOBS, Key: { userId: USER_ID, jobId: params.id },
    UpdateExpression: `SET ${sets.join(", ")}`,
    ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
    ExpressionAttributeValues: values,
  }));
  recordAudit(req, "flink.update", { resourceType: "flink", resourceId: params.id, detail: { name: body.name || job.name } }).catch(() => {});
  return apiOk({ jobId: params.id, updated: true });
}

// DELETE /api/flink/jobs/[id] — 删除作业:真正销毁 MSAF 应用(+删日志组)再删记录(长操作 flink-delete)。
// 用户拍板:只有删除才销毁后台 Flink 应用;停止仅暂停保留。
// 🔴🔴 销毁失败**不许删记录**:执行体 502 并保留行;还在停 ⇒ 202 已受理,后台停稳后销毁并删行。
export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const job = await getJob(params.id);
  if (!job) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const ctx = await guardResourceAccess(req, job, "editor");
  if (ctx instanceof NextResponse) return ctx;
  try {
    const result = await submitLongOp(
      { kind: "flink-delete", params: { jobId: params.id, targetId: flinkJobTarget(job) }, correlationId: getCorrelationId(req) },
      { req, identity: ctx.identity },
    );
    return longOpResponse(req, result);
  } catch (e: any) {
    const lo = longOpErrorResponse(e);
    if (lo) return lo;
    return apiError(e.message, 500);
  }
}
