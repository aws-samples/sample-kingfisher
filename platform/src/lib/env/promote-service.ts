// 多环境晋升服务 (v1.6.0)
//
// Promote a config resource from one environment to another within the same project.
// Each environment holds an independent physical resource; the same logical resource is
// tied across environments by `lineageId`. Promoting copies the AUTHORED definition (script,
// DAG, cron, mapping, ...) but NOT env-specific runtime bindings (Glue job name, Airflow DAG
// id, last-run state) — those are (re)created when the promoted resource is published/run in
// its own environment, so e.g. prod never triggers dev's Glue job.
//
// Promotion into a protected environment (prod) goes through the module-13 approval flow
// (type "deploy"); see /api/promote and /api/approvals/[id].

import { ScanCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@/lib/aws/dynamodb";
import { ulid } from "ulid";
import {
  ResourceType,
  loadResource,
  getResourceMeta,
  getResourceConfig,
  snapshotVersion,
  currentDefinitionVersion,
} from "@/lib/versions/version-service";
import { DEFAULT_ENV, DEFAULT_PROJECT_ID, ENVS } from "@/lib/projects/constants";
import { listApprovals } from "@/lib/projects/project-service";

const PARTITION = "default-user";

// Env-specific runtime bindings + status that must NOT be carried across environments.
const PROMOTE_EXCLUDE = [
  "env",
  "lineageId",
  "status",
  "glueJobName",
  "airflowDagId",
  "glueJobRunId",
  "lastRunId",
  "lastRunStatus",
  "lastRunAt",
  "testResult",
  "downstreamFired",
  "scheduleEnabled",
  "promotedFrom",
  // 发布痕迹是**目标那份**自己的事实,再往下游发布时不许被带走
  "promotedAt",
  "promotedBy",
  "sourceId",
  "sourceVersion",
];

function portableConfig(type: ResourceType, source: Record<string, any>): Record<string, any> {
  const cfg = getResourceConfig(type, source);
  PROMOTE_EXCLUDE.forEach((k) => delete cfg[k]);
  return cfg;
}

// Find the resource that represents the same logical resource (lineageId) in `env` within a
// project. Low volume → Scan+filter, consistent with the list endpoints.
export async function findTargetByLineage(
  type: ResourceType,
  projectId: string,
  lineageId: string,
  env: string
): Promise<Record<string, any> | null> {
  const m = getResourceMeta(type);
  const { Items = [] } = await docClient.send(
    new ScanCommand({
      TableName: m.table,
      FilterExpression: "lineageId = :lid AND #env = :env AND projectId = :pid",
      ExpressionAttributeNames: { "#env": "env" },
      ExpressionAttributeValues: { ":lid": lineageId, ":env": env, ":pid": projectId },
    })
  );
  return (Items[0] as Record<string, any>) || null;
}

export interface PromoteResult {
  created: boolean;
  targetId: string;
  fromEnv: string;
  toEnv: string;
  lineageId: string;
  // 页面要告诉用户「发了哪一版、什么时候」
  promotedAt: string;
  sourceId: string;
  sourceVersion: number;
}

// Execute a promotion (already authorized / approved by the caller). Idempotent per
// (project, lineageId, toEnv): updates the existing target if present, else creates one.
export async function executePromote(
  type: ResourceType,
  sourceId: string,
  toEnv: string,
  actor: string
): Promise<PromoteResult> {
  const m = getResourceMeta(type);
  const source = await loadResource(type, sourceId);
  if (!source) throw new Error("源资源不存在");
  const fromEnv = source.env || DEFAULT_ENV;
  const projectId = source.projectId || DEFAULT_PROJECT_ID;
  if (toEnv === fromEnv) throw new Error("源环境与目标环境相同");

  // Anchor the lineage on the source's own id the first time it's promoted.
  let lineageId: string = source.lineageId;
  if (!lineageId) {
    lineageId = source[m.sk];
    await docClient.send(
      new UpdateCommand({
        TableName: m.table,
        Key: { userId: PARTITION, [m.sk]: sourceId },
        UpdateExpression: "SET lineageId = :l",
        ExpressionAttributeValues: { ":l": lineageId },
      })
    );
  }

  const config = portableConfig(type, source);
  const now = new Date().toISOString();
  // 发的是源资源的第几版(快照表是版本的唯一真值源;没快照过 = 0)
  const sourceVersion = await currentDefinitionVersion(type, sourceId).catch(() => 0);
  const trace = { promotedFrom: fromEnv, promotedAt: now, promotedBy: actor, sourceId, sourceVersion };
  const existing = await findTargetByLineage(type, projectId, lineageId, toEnv);

  if (existing) {
    const targetId: string = existing[m.sk];
    const fields = Object.keys(config);
    const expr = [
      ...fields.map((_, i) => `#f${i} = :v${i}`),
      "#upd = :now", "promotedFrom = :pf", "promotedAt = :pa", "promotedBy = :pb", "sourceId = :sid", "sourceVersion = :sv",
    ].join(", ");
    const names = Object.fromEntries(fields.map((k, i) => [`#f${i}`, k]));
    const values = Object.fromEntries(fields.map((k, i) => [`:v${i}`, config[k]]));
    await docClient.send(
      new UpdateCommand({
        TableName: m.table,
        Key: { userId: PARTITION, [m.sk]: targetId },
        UpdateExpression: `SET ${expr}`,
        ExpressionAttributeNames: { ...names, "#upd": "updatedAt" },
        ExpressionAttributeValues: { ...values, ":now": now, ":pf": fromEnv, ":pa": now, ":pb": actor, ":sid": sourceId, ":sv": sourceVersion },
      })
    );
    const updated = await loadResource(type, targetId);
    if (updated) await snapshotVersion(type, targetId, updated, actor, `晋升自 ${fromEnv}(v${sourceVersion})`).catch(() => {});
    return { created: false, targetId, fromEnv, toEnv, lineageId, promotedAt: now, sourceId, sourceVersion };
  }

  // Create a fresh target in the destination env.
  const targetId = ulid();
  const item: Record<string, any> = {
    ...config,
    userId: PARTITION,
    [m.sk]: targetId,
    projectId,
    env: toEnv,
    lineageId,
    status: "draft",
    ...trace,
    createdBy: actor,
    createdAt: now,
    updatedAt: now,
  };
  await docClient.send(new PutCommand({ TableName: m.table, Item: item }));
  await snapshotVersion(type, targetId, item, actor, `晋升自 ${fromEnv}(v${sourceVersion})`).catch(() => {});
  return { created: true, targetId, fromEnv, toEnv, lineageId, promotedAt: now, sourceId, sourceVersion };
}

// ─────────────────────────────────────────────────────────────────────────────
// 一份资源在三个环境里的发布状态(页面「各环境」一行的唯一数据源)。
//   以 lineageId 为枢纽逐环境找同源资源;再把本项目里 **待批准的 deploy 审批** 按 resourceId ∈ 本链所有 id 挂到目标环境上。
//   只读、不改任何行。
export interface LineageEnvRow {
  env: string;
  id: string | null;
  current: boolean;
  status?: string;
  name?: string;
  promotedFrom?: string;
  promotedAt?: string;
  promotedBy?: string;
  sourceVersion?: number;
  updatedAt?: string;
  pendingApproval: { approvalId: string; requestedBy: string; requestedAt: string } | null;
}

export interface LineageStatus {
  type: ResourceType;
  lineageId: string;
  projectId: string;
  current: { env: string; id: string };
  envs: LineageEnvRow[];
}

export async function lineageStatus(type: ResourceType, id: string): Promise<LineageStatus> {
  const m = getResourceMeta(type);
  const source = await loadResource(type, id);
  if (!source) throw new Error("资源不存在");
  const projectId: string = source.projectId || DEFAULT_PROJECT_ID;
  const curEnv: string = source.env || DEFAULT_ENV;
  const lineageId: string = source.lineageId || source[m.sk];

  const rows: LineageEnvRow[] = [];
  for (const env of ENVS) {
    const hit = env === curEnv ? source : await findTargetByLineage(type, projectId, lineageId, env);
    rows.push({
      env,
      id: hit ? String(hit[m.sk]) : null,
      current: env === curEnv,
      status: hit?.status,
      name: hit?.name,
      promotedFrom: hit?.promotedFrom,
      promotedAt: hit?.promotedAt,
      promotedBy: hit?.promotedBy,
      sourceVersion: typeof hit?.sourceVersion === "number" ? hit.sourceVersion : undefined,
      updatedAt: hit?.updatedAt,
      pendingApproval: null,
    });
  }
  const ids = new Set(rows.map((r) => r.id).filter(Boolean) as string[]);
  const pending = await listApprovals({ projectId, status: "pending" }).catch(() => []);
  for (const a of pending) {
    if (a.type !== "deploy") continue;
    const p = (a.payload || {}) as { resourceType?: string; resourceId?: string; toEnv?: string };
    if (p.resourceType !== type || !p.resourceId || !ids.has(p.resourceId)) continue;
    const row = rows.find((r) => r.env === p.toEnv);
    if (row && !row.pendingApproval) row.pendingApproval = { approvalId: a.approvalId, requestedBy: a.requestedBy, requestedAt: a.requestedAt };
  }
  return { type, lineageId, projectId, current: { env: curEnv, id }, envs: rows };
}
