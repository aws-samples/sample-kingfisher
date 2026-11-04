export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { guardResourceAccess } from "@/lib/projects/guard";
import { snapshotVersion } from "@/lib/versions/version-service";
import { pushSqlLineageToOpenMetadata } from "@/lib/openmetadata/om-push";
import { recordComputeLineage } from "@/lib/governance/lineage-service";

const USER_ID = "default-user";

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item: current } = await docClient.send(
    new GetCommand({ TableName: TABLES.REDSHIFT_TASKS, Key: { userId: USER_ID, taskId: params.id } })
  );
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const guard = await guardResourceAccess(req, current, "editor");
  if (guard instanceof NextResponse) return guard;

  const body = await req.json();
  delete body.userId;
  delete body.projectId;
  delete body.createdBy;
  delete body.createdBySub;
  const fields = Object.keys(body);
  if (fields.length === 0) return NextResponse.json({ error: "无更新字段" }, { status: 400 });
  const expr = fields.map((k, i) => `#f${i} = :v${i}`).join(", ");
  const names = Object.fromEntries(fields.map((k, i) => [`#f${i}`, k]));
  const values = Object.fromEntries(fields.map((k, i) => [`:v${i}`, body[k]]));

  const { Attributes } = await docClient.send(
    new UpdateCommand({
      TableName: TABLES.REDSHIFT_TASKS,
      Key: { userId: USER_ID, taskId: params.id },
      UpdateExpression: `SET ${expr}, #upd = :now`,
      ExpressionAttributeNames: { ...names, "#upd": "updatedAt" },
      ExpressionAttributeValues: { ...values, ":now": new Date().toISOString() },
      ReturnValues: "ALL_NEW",
    })
  );
  await snapshotVersion("redshift-task", params.id, Attributes as any, guard.identity.username, "保存").catch(() => {});
  // re-parse SQL → lineage on save (best-effort).
  const saved = Attributes as any;
  if (saved?.sql) {
    pushSqlLineageToOpenMetadata({
      sql: saved.sql,
      database: saved.database,
      pipeline: { resourceType: "redshift-task", id: params.id, name: saved.name },
    }).catch(() => {});
    recordComputeLineage({ sql: saved.sql, database: saved.database, taskId: params.id, engine: "redshift-task" }).catch(() => {});
  }
  return NextResponse.json(Attributes);
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.REDSHIFT_TASKS, Key: { userId: USER_ID, taskId: params.id } })
  );
  if (!Item) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const guard = await guardResourceAccess(req, Item, "editor");
  if (guard instanceof NextResponse) return guard;
  await docClient.send(
    new DeleteCommand({ TableName: TABLES.REDSHIFT_TASKS, Key: { userId: USER_ID, taskId: params.id } })
  );
  return NextResponse.json({ success: true });
}
