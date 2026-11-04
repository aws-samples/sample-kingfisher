// 模块 43-A — 运维知识库存储层。bgp-incidents 单表两类 item 的读写:
//   · 归并 upsert 主档(条件建 + ADD occurrenceCount 幂等累加)
//   · 条件写发生记录(attribute_not_exists 幂等去重,键含 diagnosticId)
//   · 列表/详情查询(Query by pk,内存分类过滤)
//   · 修复手册乐观锁更新(照 sla-service:version 比对 → 409)
// 纯数据访问,不含业务编排(编排在 record.ts / reconcile.ts / health.ts)。

import { PutCommand, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import type { IncidentMaster, IncidentOccurrence, IncidentResolution } from "./types";

const OCC_TTL_DAYS = 180;

export const incidentPk = (projectId: string) => `incident#${projectId}`;
export const sigSk = (signature: string) => `sig#${signature}`;
export const occSk = (signature: string, diagnosticId: string) => `occ#${signature}#${diagnosticId}`;

// 归并 upsert 主档:不存在则建(occurrenceCount=1),存在则 occurrenceCount+=1 + 更新 lastSeenAt/
// affectedTasks(去重追加)/rootCauseSummary/engine/title。用单条 UpdateItem 做到幂等的"建或并"。
export async function upsertMaster(input: {
  projectId: string;
  signature: string;
  engine: string;
  title: string;
  taskName: string;
  occurredAt: string;
  rootCauseSummary?: string;
  // @kf-batch 50-WP4quater-reads(工单 SC-20)—— 这次发生在哪个区(从 run 行的章读来;取不到就 undefined)
  targetId?: string;
}): Promise<void> {
  const pk = incidentPk(input.projectId);
  const sk = sigSk(input.signature);
  const now = new Date().toISOString();

  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.INCIDENTS,
      Key: { pk, sk },
      // ADD occurrenceCount :one → 不存在则初始化为 1,存在则 +1(原子,天然幂等累加)。
      // affectedTasks 用 list_append,末尾去重由读侧或此处条件保证。这里为简单+确定性,读当前后合并去重。
      UpdateExpression: [
        "SET projectId = :pid, signature = :sig, engine = :eng, title = :title,",
        "    lastSeenAt = :now, updatedAt = :now,",
        "    firstSeenAt = if_not_exists(firstSeenAt, :now),",
        "    createdAt = if_not_exists(createdAt, :now),",
        "    #status = if_not_exists(#status, :unresolved),",
        "    #version = if_not_exists(#version, :zero),",
        "    rootCauseSummary = :rc,",
        "    affectedTasks = :tasks,",
        // @kf-batch 50-WP4quater-reads —— 这类故障发生过的区集合(与 affectedTasks 同一次读写合并)
        "    #targets = :targets",
        "ADD occurrenceCount :one",
      ].join(" "),
      ExpressionAttributeNames: { "#status": "status", "#version": "version", "#targets": "targets" },
      ExpressionAttributeValues: {
        ":pid": input.projectId,
        ":sig": input.signature,
        ":eng": input.engine,
        ":title": input.title,
        ":now": input.occurredAt || now,
        ":unresolved": "unresolved",
        ":zero": 0,
        ":one": 1,
        ":rc": input.rootCauseSummary || "",
        ...(await mergeMerged(pk, sk, input.taskName, input.targetId)),
      },
    })
  );
}

// 读当前 affectedTasks + targets,各自合并去重(上限 50,防膨胀)。与 upsert 同事务窗口内的小竞态可接受
// (低频写:诊断完成才触发),最终一致即可。
//
// @kf-batch 50-WP4quater-reads(工单 SC-20)—— 🔴 两个集合**必须在同一次 Get 里读**:
// 拆成两次读会多一个往返,而且两次读之间若有并发写,合出来的 affectedTasks 与 targets 会来自
// 不同的快照(任务名列表与区列表对不上)。
async function mergeMerged(
  pk: string,
  sk: string,
  taskName: string,
  targetId?: string
): Promise<{ ":tasks": string[]; ":targets": string[] }> {
  const cur = await docClient
    .send(new GetCommand({ TableName: TABLES.INCIDENTS, Key: { pk, sk }, ProjectionExpression: "affectedTasks, #targets", ExpressionAttributeNames: { "#targets": "targets" } }))
    .catch(() => ({ Item: undefined as any }));
  const tasks: string[] = Array.isArray(cur.Item?.affectedTasks) ? cur.Item!.affectedTasks : [];
  const name = (taskName || "").trim();
  const nextTasks = !name || tasks.includes(name) ? tasks.slice(0, 50) : [...tasks, name].slice(0, 50);

  const targets: string[] = Array.isArray(cur.Item?.targets) ? cur.Item!.targets.filter((x: unknown) => typeof x === "string") : [];
  const tid = (targetId || "").trim();
  const nextTargets = !tid || targets.includes(tid) ? targets.slice(0, 50) : [...targets, tid].slice(0, 50);

  return { ":tasks": nextTasks, ":targets": nextTargets };
}

// 条件写发生记录(幂等):同一 diagnosticId 只写一次。返回是否新写(false = 已存在,跳过)。
export async function putOccurrenceIfNew(occ: Omit<IncidentOccurrence, "ttl">): Promise<boolean> {
  const ttl = Math.floor(Date.now() / 1000) + OCC_TTL_DAYS * 24 * 3600;
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLES.INCIDENTS,
        Item: { ...occ, ttl } as IncidentOccurrence,
        ConditionExpression: "attribute_not_exists(sk)",
      })
    );
    return true;
  } catch (e: any) {
    if (e?.name === "ConditionalCheckFailedException") return false; // 已沉淀过,幂等跳过
    throw e;
  }
}

// 列一个项目的所有主档(按 signature 归并的故障类别)。Query pk,过滤 sig# 前缀。
export async function listMasters(projectId: string): Promise<IncidentMaster[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.INCIDENTS,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :sig)",
      ExpressionAttributeValues: { ":pk": incidentPk(projectId), ":sig": "sig#" },
    })
  );
  return Items as IncidentMaster[];
}

export async function getMaster(projectId: string, signature: string): Promise<IncidentMaster | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.INCIDENTS, Key: { pk: incidentPk(projectId), sk: sigSk(signature) } })
  );
  return (Item as IncidentMaster) || null;
}

// 一类故障的发生时间线(按 diagnosticId=ULID 逆序 → 最近在前)。
export async function listOccurrences(projectId: string, signature: string, limit = 100): Promise<IncidentOccurrence[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.INCIDENTS,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :occ)",
      ExpressionAttributeValues: { ":pk": incidentPk(projectId), ":occ": `occ#${signature}#` },
      ScanIndexForward: false,
      Limit: limit,
    })
  );
  return Items as IncidentOccurrence[];
}

// 维护"已验证修复手册" + 标记 verified(乐观锁 version)。冲突抛 { code: "CONFLICT" }。
export async function updateResolution(
  projectId: string,
  signature: string,
  body: { markdown?: string; verified?: boolean; fixKind?: string; backfillHint?: any; status?: string; expectedVersion?: number; actor: string }
): Promise<IncidentMaster> {
  const cur = await getMaster(projectId, signature);
  if (!cur) {
    const err: any = new Error("故障类别不存在");
    err.code = "NOT_FOUND";
    throw err;
  }
  if (Number.isFinite(body.expectedVersion) && body.expectedVersion !== cur.version) {
    const err: any = new Error("版本冲突,请刷新后重试");
    err.code = "CONFLICT";
    throw err;
  }
  const now = new Date().toISOString();
  const verified = body.verified === true;
  const resolution: IncidentResolution = {
    markdown: body.markdown !== undefined ? String(body.markdown).slice(0, 20000) : cur.resolution?.markdown || "",
    verified,
    verifiedBy: verified ? body.actor : cur.resolution?.verifiedBy,
    verifiedAt: verified ? now : cur.resolution?.verifiedAt,
    fixKind: (body.fixKind as any) || cur.resolution?.fixKind,
    backfillHint: body.backfillHint || cur.resolution?.backfillHint,
  };
  // 状态:显式传优先;否则 verified → resolved-verified,取消 verified → 回 unresolved(保留 silenced 除非显式改)。
  const status =
    body.status && ["unresolved", "resolved-verified", "silenced"].includes(body.status)
      ? body.status
      : verified
      ? "resolved-verified"
      : cur.status === "resolved-verified"
      ? "unresolved"
      : cur.status;

  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.INCIDENTS,
      Key: { pk: incidentPk(projectId), sk: sigSk(signature) },
      UpdateExpression: "SET resolution = :r, #status = :s, #version = :nv, updatedAt = :u",
      ConditionExpression: "#version = :cv",
      ExpressionAttributeNames: { "#status": "status", "#version": "version", "#targets": "targets" },
      ExpressionAttributeValues: { ":r": resolution, ":s": status, ":nv": cur.version + 1, ":cv": cur.version, ":u": now },
    })
  ).catch((e: any) => {
    if (e?.name === "ConditionalCheckFailedException") {
      const err: any = new Error("版本冲突,请刷新后重试");
      err.code = "CONFLICT";
      throw err;
    }
    throw e;
  });
  return { ...cur, resolution, status: status as any, version: cur.version + 1, updatedAt: now };
}

// 抑制该类故障(已知无害/待排期)。silenceUntil 到期后 UI 视为重新活跃。
export async function silenceIncident(projectId: string, signature: string, silenceUntil: string): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.INCIDENTS,
      Key: { pk: incidentPk(projectId), sk: sigSk(signature) },
      UpdateExpression: "SET #status = :s, silenceUntil = :u, updatedAt = :now ADD #version :one",
      ConditionExpression: "attribute_exists(sk)",
      ExpressionAttributeNames: { "#status": "status", "#version": "version", "#targets": "targets" },
      ExpressionAttributeValues: { ":s": "silenced", ":u": silenceUntil, ":now": new Date().toISOString(), ":one": 1 },
    })
  );
}
