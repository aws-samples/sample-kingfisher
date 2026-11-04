// 资源版本管理与回滚 (v1.5.0)
//
// Generic per-resource config versioning for the "configuration" resource types
// (workflow / etl-job / sync / redshift-task). Each save snapshots the resource's business
// config into bgp-resource-versions; rollback restores a chosen version's config (after
// snapshotting the current state first, so a rollback is itself reversible).
//
// Tenancy: resources keep the fixed userId="default-user" partition (module 13); the
// version row also carries projectId so RBAC checks at the API layer use the same model.

import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";

const PARTITION = "default-user";

export type ResourceType = "workflow" | "etl-job" | "sync" | "redshift-task" | "engine-job";

interface ResourceMeta {
  table: string;
  sk: string; // sort-key attribute name on the resource table
  label: string;
}

const RESOURCES: Record<ResourceType, ResourceMeta> = {
  workflow: { table: TABLES.WORKFLOWS, sk: "workflowId", label: "工作流" },
  "etl-job": { table: TABLES.ETL_JOBS, sk: "jobId", label: "作业" },
  sync: { table: TABLES.SYNC_TASKS, sk: "taskId", label: "同步任务" },
  "redshift-task": { table: TABLES.REDSHIFT_TASKS, sk: "taskId", label: "Redshift 任务" },
  // 补齐:离线多引擎(EMR Serverless 等)作业——与 etl-job 同为"离线计算"页作业,
  // 接入同一套版本/晋升/回滚。表 bgp-engine-jobs(pk=userId, sk=jobId),结构兼容通用服务。
  "engine-job": { table: TABLES.ENGINE_JOBS, sk: "jobId", label: "引擎作业" },
};

export function isResourceType(v: unknown): v is ResourceType {
  return typeof v === "string" && v in RESOURCES;
}

export function resourceLabel(type: ResourceType): string {
  return RESOURCES[type].label;
}

// Exposed for the promote/multi-env service (module 15): the table + sort-key for a type.
export function getResourceMeta(type: ResourceType): { table: string; sk: string; label: string } {
  return RESOURCES[type];
}

// Attributes that are NOT part of the versioned "config" (identity/tenancy/timestamps and
// the resource's own key). Everything else on the item is snapshotted and restored.
const META_FIELDS = new Set([
  "userId",
  "projectId",
  "createdBy",
  "createdBySub",
  "createdAt",
  "updatedAt",
  // 🔴 `deployments` 是**下发台账(运行态)**,不是可版本化的配置。放进快照会有两个后果:
  //   ① 回滚会把**旧的台账**整包写回资源行 ⇒ 台账说「这个版本已发到 us-west-2」,而实际没有
  //      —— 版本一致性矩阵最不能犯的错就是这种「假绿」;
  //   ② 晋升(用同一个 `getResourceConfig`)会把台账复制给目标环境的新资源,
  //      于是一个从没下发过的资源开局就带着一串 ok 记录。
  // 台账的真值源只有资源行本身,由 `recordDeployment`/`removeDeployment` 单口写。
  "deployments",
]);

export async function loadResource(type: ResourceType, id: string): Promise<Record<string, any> | null> {
  const m = RESOURCES[type];
  const { Item } = await docClient.send(
    new GetCommand({ TableName: m.table, Key: { userId: PARTITION, [m.sk]: id } })
  );
  return Item || null;
}

function extractConfig(type: ResourceType, item: Record<string, any>): Record<string, any> {
  const m = RESOURCES[type];
  const config: Record<string, any> = {};
  for (const k of Object.keys(item)) {
    if (k === m.sk || META_FIELDS.has(k)) continue;
    config[k] = item[k];
  }
  return config;
}

// Public alias for the promote/multi-env service: the resource's portable business config
// (everything except its key + identity/tenancy/timestamp metadata; env/lineageId ARE part
// of the item but are handled explicitly by the promote service, see below).
export function getResourceConfig(type: ResourceType, item: Record<string, any>): Record<string, any> {
  return extractConfig(type, item);
}

const pad = (n: number) => String(n).padStart(6, "0");

// 🔴 导出它:版本一致性矩阵要拿"当前定义版本"与**下发台账里的版本**比,才能判"版本不齐"。
// 刻意**不在资源行上再存一份** `defVersion` —— 那会有两个真值源,而快照表本来就是权威。
// 🔴 A4:形参从 `string` 收紧成 `ResourceType`。
// 它是「下发产物里那个定义版本号」的唯一来源(dag-fanout / schedule-fanout / 一致性矩阵三处),
// 传错一个不在 RESOURCES 里的 kind 不会报错、只会**恒回 0** ⇒ 台账说「版本 0」而产物是新的(假绿)。
// 现有三个调用点传的都是合法字面量 ⇒ 零改动。
export async function currentDefinitionVersion(type: ResourceType, id: string): Promise<number> {
  return latestVersionNum(`${type}#${id}`);
}

async function latestVersionNum(pk: string): Promise<number> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.RESOURCE_VERSIONS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
      ScanIndexForward: false,
      Limit: 1,
    })
  );
  return Items.length ? Number(Items[0].versionNum || 0) : 0;
}

// Snapshot the resource's current config as the next version. Returns the new version number.
// Best-effort by design at the call sites (a failed snapshot must never fail the save), but
// this function itself awaits so version numbering stays consistent.
export async function snapshotVersion(
  type: ResourceType,
  id: string,
  item: Record<string, any>,
  actor: string,
  note = ""
): Promise<number> {
  const pk = `${type}#${id}`;
  const next = (await latestVersionNum(pk)) + 1;
  await docClient.send(
    new PutCommand({
      TableName: TABLES.RESOURCE_VERSIONS,
      Item: {
        pk,
        version: pad(next),
        versionNum: next,
        type,
        resourceId: id,
        projectId: item.projectId || null,
        name: item.name || "",
        config: extractConfig(type, item),
        versionedAt: new Date().toISOString(),
        versionedBy: actor,
        note,
      },
    })
  );
  return next;
}

export interface VersionMeta {
  version: number;
  versionedAt: string;
  versionedBy: string;
  note: string;
  name: string;
}

export async function listVersions(type: ResourceType, id: string): Promise<VersionMeta[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.RESOURCE_VERSIONS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `${type}#${id}` },
      ScanIndexForward: false, // newest first
    })
  );
  return Items.map((v) => ({
    version: Number(v.versionNum),
    versionedAt: v.versionedAt,
    versionedBy: v.versionedBy,
    note: v.note || "",
    name: v.name || "",
  }));
}

export async function getVersion(
  type: ResourceType,
  id: string,
  versionNum: number
): Promise<Record<string, any> | null> {
  const { Item } = await docClient.send(
    new GetCommand({
      TableName: TABLES.RESOURCE_VERSIONS,
      Key: { pk: `${type}#${id}`, version: pad(versionNum) },
    })
  );
  return Item || null;
}

// Roll the resource back to a chosen version's config. Snapshots the current state first
// (so the rollback can itself be undone), then overwrites the resource's config fields.
// Returns the updated resource, or null if the version/resource is missing.
export async function rollbackToVersion(
  type: ResourceType,
  id: string,
  versionNum: number,
  actor: string
): Promise<Record<string, any> | null> {
  const m = RESOURCES[type];
  const target = await getVersion(type, id, versionNum);
  if (!target) return null;
  const current = await loadResource(type, id);
  if (!current) return null;

  // Preserve the current state as a new version before overwriting.
  await snapshotVersion(type, id, current, actor, `回滚前自动快照（v${versionNum} 之前）`);

  const config: Record<string, any> = target.config || {};
  const fields = Object.keys(config);
  if (fields.length === 0) {
    // nothing to restore beyond timestamp
    await docClient.send(
      new UpdateCommand({
        TableName: m.table,
        Key: { userId: PARTITION, [m.sk]: id },
        UpdateExpression: "SET updatedAt = :now",
        ExpressionAttributeValues: { ":now": new Date().toISOString() },
      })
    );
  } else {
    const expr = fields.map((_, i) => `#f${i} = :v${i}`).join(", ");
    const names = Object.fromEntries(fields.map((k, i) => [`#f${i}`, k]));
    const values = Object.fromEntries(fields.map((k, i) => [`:v${i}`, config[k]]));
    await docClient.send(
      new UpdateCommand({
        TableName: m.table,
        Key: { userId: PARTITION, [m.sk]: id },
        UpdateExpression: `SET ${expr}, #upd = :now`,
        ExpressionAttributeNames: { ...names, "#upd": "updatedAt" },
        ExpressionAttributeValues: { ...values, ":now": new Date().toISOString() },
      })
    );
  }
  return loadResource(type, id);
}
