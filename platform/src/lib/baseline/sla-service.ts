// SLA 定义 CRUD + 破线预测持久化 + 预测告警推送(复用通道)。
// 不改规则引擎:仅 import 其 dispatch/putEventIfNew/updateEventDelivery/getChannels。

import { PutCommand, GetCommand, QueryCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { dispatch } from "@/lib/alerting/notify";
import { putEventIfNew, updateEventDelivery } from "@/lib/alerting/events";
import { getChannels } from "@/lib/alerting/channels";
import type { SlaRow, SlaPrediction } from "./types";
// SLA 的区维**从绑定对象派生**,不让用户再填一次。
import { bindingTargets } from "@/lib/exec-env/data-plane-target";

const slaPk = (projectId: string) => `sla#${projectId}`;

const USER_ID = "default-user";

/**
 * 这条 SLA 管的对象(任务 / 工作流)跑在哪些区。
 *
 * 🔴 **派生而不是让用户填**:SLA 表单里再放一个「区」选择器,等于同一件事有两个真值源 ——
 * 任务后来被改成只在 usw2 跑,SLA 上那个区却还写着主控区,于是这条 SLA 挂在一个
 * **那个区根本不跑的任务**上:永远不破线,看起来一切正常。
 * 🔴 读不到绑定对象时回**空数组**而不是 `[home]`:回 home 会凭空断言「它在主控区跑」,
 * 而读侧 `bindingTargets` 的三级回落本来就会把无章的行算进主控区 —— 让唯一那份回落规则说话。
 */
async function targetsOfBinding(taskId?: string, workflowId?: string): Promise<string[]> {
  try {
    if (workflowId) {
      const { Item } = await docClient.send(
        new GetCommand({ TableName: TABLES.WORKFLOWS, Key: { userId: USER_ID, workflowId }, ProjectionExpression: "#t, targetId", ExpressionAttributeNames: { "#t": "targets" } })
      );
      return Item ? bindingTargets(Item as { targets?: unknown; targetId?: unknown }) : [];
    }
    if (taskId) {
      // 任务可能是同步 / 离线 / 引擎作业三张表之一 —— 逐张试(低频操作,一次建 SLA 才走)。
      for (const table of [TABLES.SYNC_TASKS, TABLES.ETL_JOBS, TABLES.ENGINE_JOBS]) {
        const key = table === TABLES.SYNC_TASKS ? { userId: USER_ID, taskId } : { userId: USER_ID, jobId: taskId };
        const { Item } = await docClient
          .send(new GetCommand({ TableName: table, Key: key, ProjectionExpression: "#t, targetId", ExpressionAttributeNames: { "#t": "targets" } }))
          .catch(() => ({ Item: undefined }));
        if (Item) return bindingTargets(Item as { targets?: unknown; targetId?: unknown });
      }
    }
  } catch { /* best-effort:读不到就回空,由读侧回落规则处理 */ }
  return [];
}

export async function listSlas(projectId: string): Promise<SlaRow[]> {
  const { Items = [] } = await docClient.send(new QueryCommand({
    TableName: TABLES.SLAS,
    KeyConditionExpression: "pk = :p",
    ExpressionAttributeValues: { ":p": slaPk(projectId) },
    ScanIndexForward: false,
  }));
  return Items as SlaRow[];
}

export async function getSla(projectId: string, slaId: string): Promise<SlaRow | null> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.SLAS, Key: { pk: slaPk(projectId), slaId } }));
  return (Item as SlaRow) || null;
}

export async function createSla(projectId: string, createdBy: string, body: any): Promise<SlaRow> {
  const target = body?.target || {};
  if (!target.taskId && !target.workflowId) throw new Error("SLA 需指定 taskId 或 workflowId");
  if (target.type === "relative" && !(target.offsetMinFromTrigger > 0)) throw new Error("相对 SLA 需正的 offsetMinFromTrigger");
  if (target.type === "absolute" && !/^\d{1,2}:\d{2}$/.test(String(target.clockTime || ""))) throw new Error("绝对 SLA 需 clockTime 如 02:00");
  const now = new Date().toISOString();
  const sla: SlaRow = {
    pk: slaPk(projectId),
    slaId: ulid(),
    projectId,
    name: String(body?.name || "SLA").slice(0, 120),
    enabled: body?.enabled !== false,
    version: 1,
    target: {
      taskId: target.taskId,
      workflowId: target.workflowId,
      scope: target.workflowId ? "workflow" : "task",
      type: target.type === "absolute" ? "absolute" : "relative",
      offsetMinFromTrigger: target.offsetMinFromTrigger,
      clockTime: target.clockTime,
      tz: target.tz,
    },
    warnLeadMin: Math.max(1, parseInt(body?.warnLeadMin, 10) || 30),
    channelIds: Array.isArray(body?.channelIds) ? body.channelIds : [],
    // 区维派生自绑定对象(见 targetsOfBinding 注释)
    targets: await targetsOfBinding(target.taskId, target.workflowId),
    createdAt: now,
    updatedAt: now,
    createdBy,
  };
  await docClient.send(new PutCommand({ TableName: TABLES.SLAS, Item: sla }));
  return sla;
}

export async function updateSla(projectId: string, slaId: string, body: any): Promise<SlaRow> {
  const cur = await getSla(projectId, slaId);
  if (!cur) throw new Error("SLA 不存在");
  const expectedVersion = parseInt(body?.version, 10);
  if (Number.isFinite(expectedVersion) && expectedVersion !== cur.version) {
    const err: any = new Error("版本冲突,请刷新后重试"); err.code = "CONFLICT"; throw err;
  }
  const next: SlaRow = {
    ...cur,
    name: body?.name !== undefined ? String(body.name).slice(0, 120) : cur.name,
    enabled: body?.enabled !== undefined ? !!body.enabled : cur.enabled,
    warnLeadMin: body?.warnLeadMin !== undefined ? Math.max(1, parseInt(body.warnLeadMin, 10) || cur.warnLeadMin) : cur.warnLeadMin,
    channelIds: Array.isArray(body?.channelIds) ? body.channelIds : cur.channelIds,
    target: body?.target ? { ...cur.target, ...body.target, scope: (body.target.workflowId || cur.target.workflowId) ? "workflow" : "task" } : cur.target,
    // 🔴 改了绑定对象就**重新派生**区维:不重新派生 = 区维停在旧对象上,而那正是「SLA 挂在
    // 一个那个区不跑的任务上」的产生方式。绑定没动时沿用旧值(避免每次改名都多一次读)。
    targets: body?.target
      ? await targetsOfBinding(body.target.taskId ?? cur.target.taskId, body.target.workflowId ?? cur.target.workflowId)
      : cur.targets,
    version: cur.version + 1,
    updatedAt: new Date().toISOString(),
  };
  await docClient.send(new UpdateCommand({
    TableName: TABLES.SLAS,
    Key: { pk: slaPk(projectId), slaId },
    UpdateExpression: "SET #n = :n, enabled = :e, warnLeadMin = :w, channelIds = :c, #t = :tg, #tgts = :tgts, version = :nv, updatedAt = :u",
    ConditionExpression: "version = :cv",
    ExpressionAttributeNames: { "#n": "name", "#t": "target", "#tgts": "targets" },
    ExpressionAttributeValues: {
      ":n": next.name, ":e": next.enabled, ":w": next.warnLeadMin, ":c": next.channelIds,
      ":tg": next.target, ":tgts": next.targets ?? [], ":nv": next.version, ":cv": cur.version, ":u": next.updatedAt,
    },
  }));
  return next;
}

export async function deleteSla(projectId: string, slaId: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLES.SLAS, Key: { pk: slaPk(projectId), slaId } }));
}

// 保存最近一次预测态到 SLA 行(供 risk-board 只读展示)。
export async function saveLastPrediction(projectId: string, slaId: string, prediction: SlaPrediction): Promise<void> {
  await docClient.send(new UpdateCommand({
    TableName: TABLES.SLAS,
    Key: { pk: slaPk(projectId), slaId },
    UpdateExpression: "SET lastPrediction = :p, updatedAt = :u",
    ExpressionAttributeValues: { ":p": prediction, ":u": new Date().toISOString() },
  })).catch(() => {});
}

/** 多窗口确认历史最多保留几次(短窗 2 / 长窗占比按它算;再长只是旧运行的噪声)。 */
export const BREACH_HISTORY_MAX = 12;

// 保存某次运行的破线预测历史(后台泵每轮预测后追加一位;换 run 从头记)。
export async function saveBreachHistory(projectId: string, slaId: string, runId: string, flags: boolean[]): Promise<void> {
  await docClient.send(new UpdateCommand({
    TableName: TABLES.SLAS,
    Key: { pk: slaPk(projectId), slaId },
    UpdateExpression: "SET breachHistory = :h",
    ExpressionAttributeValues: { ":h": { runId, flags: flags.slice(-BREACH_HISTORY_MAX) } },
  })).catch(() => {});
}

// 推送"预测破线"告警(复用通道 + 事件幂等去重)。dedupeKey=sla#<slaId>#<runId>#predicted:
// 同一 (slaId, runId) 只推一次;不同语义(固定 timeout 规则)dedupeKey 不同,互不覆盖。
export async function pushBreachAlert(sla: SlaRow, prediction: SlaPrediction, extra: { node?: string }): Promise<{ pushed: boolean; status?: string }> {
  const dedupeKey = `sla#${sla.slaId}#${prediction.runId}#predicted`;
  const etaLocal = new Date(prediction.etaAt).toISOString().slice(11, 16);
  const slaLocal = new Date(prediction.slaAt).toISOString().slice(11, 16);
  const message = `工作流「${sla.name}」预计 ${etaLocal} 完成,SLA ${slaLocal},大概率破线(余量 ${prediction.marginMin} 分钟)${extra.node ? `,当前卡在 ${extra.node}` : ""}。`;
  // trigger 用既有 AlertEvent.trigger 字段(taskId/taskName/runId/taskType/metricValue),
  // 不扩展其类型(红线:不改)。SLA 语义(etaAt/slaAt/卡点)已进 message 成品串。
  const event = await putEventIfNew({
    ruleId: `sla#${sla.slaId}`,
    ruleName: `SLA预测破线:${sla.name}`,
    severity: "P1",
    projectId: sla.projectId,
    dedupeKey,
    message,
    trigger: { taskId: sla.slaId, taskName: sla.name, runId: prediction.runId, taskType: "sla-breach-predicted", metricValue: prediction.marginMin },
  });
  if (!event) return { pushed: false }; // 已推过(幂等)
  const channels = sla.channelIds.length ? await getChannels(sla.channelIds) : [];
  const { status, results } = await dispatch(channels, {
    title: `[P1] SLA 预测破线:${sla.name}`,
    severity: "P1",
    ruleName: event.ruleName,
    message,
    trigger: event.trigger as Record<string, unknown>,
  });
  await updateEventDelivery(event.ruleId, event.sk, status, results);
  return { pushed: true, status };
}
