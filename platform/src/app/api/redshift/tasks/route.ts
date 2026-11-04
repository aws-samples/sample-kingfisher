export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { requireProject, projectFilter, getActiveEnv, envFilter } from "@/lib/projects/guard";
// 保存的 SQL 查询任务要有落点章。
// 🔴 原来行上只有 `workgroupName`,没有区维:在 us-west-2 存的查询,回到主控区照样列出来,
// 点开一跑就打到主控区的工作组 —— 那个工作组里根本没有这张表,报错是「relation does not exist」,
// 看起来像数据问题(2026-09-10 问数那条真 bug 就是这个形状,只是发生在容器侧)。
import { readScope, scopeFilter } from "@/lib/exec-env/scope";
// 后一半:点名必须是**已注册且装好**的执行环境(不存在 ⇒ 409,不再写孤儿记录 / 回降级结果)
import { requestedRegisteredPlace } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { snapshotVersion } from "@/lib/versions/version-service";
import { pushSqlLineageToOpenMetadata } from "@/lib/openmetadata/om-push";
import { recordComputeLineage } from "@/lib/governance/lineage-service";
import { ulid } from "ulid";

const USER_ID = "default-user";

export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const pf = projectFilter(ctx.projectId);
  const ef = envFilter(getActiveEnv(req));
  // 🔴 `readScope` 回 null(未传 `?scope=` / 全局)⇒ `sf` 为 null ⇒ 表达式与改动前逐字节相同(回滚点)。
  const scope = readScope(req);
  const sf = scope ? scopeFilter(scope, "redshiftTask") : null;
  const { Items = [] } = await docClient.send(
    new ScanCommand({
      TableName: TABLES.REDSHIFT_TASKS,
      FilterExpression: `userId = :uid AND ${pf.clause} AND ${ef.clause}${sf ? ` AND ${sf.clause}` : ""}`,
      ExpressionAttributeNames: { "#env": "env", ...(sf ? sf.names : {}) },
      ExpressionAttributeValues: { ":uid": USER_ID, ...pf.values, ...ef.values, ...(sf ? sf.values : {}) },
    })
  );
  return NextResponse.json(Items);
}

export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json();
  const now = new Date().toISOString();
  // 🔴 落点章**不从 `...body` 里裸抄**:那等于让前端随便写一个字符串进权威字段。
  // 🔴 新建必须点名(缺 / 非法 ⇒ 400)。原来不合法就**不盖章**
  //    ⇒ 读侧把无章行归主控区 ⇒ 漏传的保存查询静默变成主控区的。
  let bodyTarget: string;
  try {
    bodyTarget = (await requestedRegisteredPlace(body?.targetId, "保存直查任务")).targetId;
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    throw e;
  }
  const item = {
    ...body,
    targetId: bodyTarget,
    userId: USER_ID,
    taskId: ulid(),
    projectId: ctx.projectId,
    env: getActiveEnv(req),
    createdBy: ctx.identity.username,
    createdBySub: ctx.identity.sub,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
  await docClient.send(new PutCommand({ TableName: TABLES.REDSHIFT_TASKS, Item: item }));
  await snapshotVersion("redshift-task", item.taskId, item, ctx.identity.username, "创建").catch(() => {});
  // auto-parse SQL → table-level lineage in OpenMetadata (best-effort).
  if (item.sql) {
    pushSqlLineageToOpenMetadata({
      sql: item.sql,
      database: item.database,
      pipeline: { resourceType: "redshift-task", id: item.taskId, name: item.name },
    }).catch(() => {});
    recordComputeLineage({ sql: item.sql, database: item.database, taskId: item.taskId, engine: "redshift-task" }).catch(() => {});
  }
  return NextResponse.json(item, { status: 201 });
}
