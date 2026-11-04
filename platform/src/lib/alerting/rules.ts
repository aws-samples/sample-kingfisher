// 模块 34 — 告警规则 CRUD(bgp-alert-rules)。单逻辑分区 pk="alertrule",ruleId(ULID)排序键。
// 低频低量配置数据:Query(pk) 列全部 + 内存按 projectId 过滤(同 bgp-metrics/bgp-diagnostics 约定)。
// 更新走乐观锁(version):并发改同一规则,一个成功一个 409(WS5 约定)。

import { PutCommand, GetCommand, QueryCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import {
  AlertRule,
  AlertScope,
  AlertCondition,
  Severity,
  SCOPE_TASK_TYPES,
  CONDITION_TYPES,
  SEVERITIES,
} from "./types";

const PK = "alertrule";

// 并发冲突(乐观锁)专用错误,route 层据此返回 409。
export class OptimisticLockError extends Error {
  constructor() {
    super("规则已被他人修改，请刷新后重试");
    this.name = "OptimisticLockError";
  }
}

// 规范化 + 校验作用域/条件/级别。抛出的 message 直接回前端。
function normalizeScope(input: any): AlertScope {
  const taskType = SCOPE_TASK_TYPES.includes(input?.taskType) ? input.taskType : "all";
  const taskId = input?.taskId ? String(input.taskId).trim() : undefined;
  return { taskType, ...(taskId ? { taskId } : {}) };
}

function normalizeCondition(input: any): AlertCondition {
  const type = CONDITION_TYPES.includes(input?.type) ? input.type : null;
  if (!type) throw new Error("condition.type 必须是 failure / timeout / success-rate / no-run");
  const cond: AlertCondition = { type };
  if (type === "timeout") {
    const m = Number(input?.thresholdMinutes);
    if (!Number.isFinite(m) || m <= 0) throw new Error("超时告警需要正的 thresholdMinutes(分钟)");
    cond.thresholdMinutes = m;
  }
  if (type === "success-rate") {
    const p = Number(input?.thresholdPercent);
    if (!Number.isFinite(p) || p < 0 || p > 100) throw new Error("成功率告警需要 0-100 的 thresholdPercent");
    cond.thresholdPercent = p;
    cond.windowMinutes = positiveWindow(input?.windowMinutes, 1440);
  }
  if (type === "no-run") {
    cond.windowMinutes = positiveWindow(input?.windowMinutes, 1440);
  }
  return cond;
}

function positiveWindow(v: any, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export async function listRules(projectId: string): Promise<AlertRule[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.ALERT_RULES,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": PK },
      ScanIndexForward: false, // 新规则在前(ruleId=ULID 时间序)
    })
  );
  return (Items as AlertRule[]).filter((r) => r.projectId === projectId);
}

export async function getRule(ruleId: string): Promise<AlertRule | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.ALERT_RULES, Key: { pk: PK, ruleId } })
  );
  return (Item as AlertRule) || null;
}

export async function createRule(
  input: {
    name?: string;
    scope?: any;
    condition?: any;
    severity?: string;
    channelIds?: string[];
    enrichWithDiagnosis?: boolean;
  },
  ctx: { projectId: string; createdBy: string }
): Promise<AlertRule> {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("缺少规则名称");
  const scope = normalizeScope(input.scope);
  const condition = normalizeCondition(input.condition);
  const severity: Severity = SEVERITIES.includes(input.severity as Severity) ? (input.severity as Severity) : "P2";
  const now = new Date().toISOString();
  const rule: AlertRule = {
    pk: PK,
    ruleId: ulid(),
    name,
    projectId: ctx.projectId,
    enabled: true,
    scope,
    condition,
    severity,
    channelIds: Array.isArray(input.channelIds) ? input.channelIds.filter(Boolean) : [],
    enrichWithDiagnosis: !!input.enrichWithDiagnosis,
    silenced: false,
    createdBy: ctx.createdBy,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  await docClient.send(new PutCommand({ TableName: TABLES.ALERT_RULES, Item: rule }));
  return rule;
}

// 部分更新 + 乐观锁。expectedVersion 由前端回传(从 GET 拿的);不匹配抛 OptimisticLockError。
export async function updateRule(
  ruleId: string,
  patch: {
    name?: string;
    scope?: any;
    condition?: any;
    severity?: string;
    channelIds?: string[];
    enrichWithDiagnosis?: boolean;
    enabled?: boolean;
    silenced?: boolean;
  },
  expectedVersion: number
): Promise<AlertRule> {
  const sets: string[] = ["updatedAt = :now", "version = :nextV"];
  const values: Record<string, unknown> = {
    ":now": new Date().toISOString(),
    ":curV": expectedVersion,
    ":nextV": expectedVersion + 1,
  };
  const names: Record<string, string> = {};
  if (patch.name !== undefined) {
    const n = String(patch.name).trim();
    if (!n) throw new Error("规则名称不能为空");
    sets.push("#nm = :nm"); values[":nm"] = n; names["#nm"] = "name";
  }
  // 序 43 B-92:scope / condition 都是 DynamoDB 保留字(和上面的 name 一样),裸写进 UpdateExpression 会被 DDB 400
  //   「Attribute name is a reserved keyword; reserved keyword: scope」⇒ 页面「编辑告警规则」保存必失败(行内启用 / 静默开关只发
  //   enabled / silenced 所以一直好着)。一律走 ExpressionAttributeNames 别名。
  if (patch.scope !== undefined) { sets.push("#sc = :sc"); values[":sc"] = normalizeScope(patch.scope); names["#sc"] = "scope"; }
  if (patch.condition !== undefined) { sets.push("#cd = :cd"); values[":cd"] = normalizeCondition(patch.condition); names["#cd"] = "condition"; }
  if (patch.severity !== undefined) {
    sets.push("severity = :sv");
    values[":sv"] = SEVERITIES.includes(patch.severity as Severity) ? patch.severity : "P2";
  }
  if (patch.channelIds !== undefined) {
    sets.push("channelIds = :ch");
    values[":ch"] = Array.isArray(patch.channelIds) ? patch.channelIds.filter(Boolean) : [];
  }
  if (patch.enrichWithDiagnosis !== undefined) { sets.push("enrichWithDiagnosis = :ew"); values[":ew"] = !!patch.enrichWithDiagnosis; }
  if (patch.enabled !== undefined) { sets.push("#en = :en"); values[":en"] = !!patch.enabled; names["#en"] = "enabled"; }
  if (patch.silenced !== undefined) { sets.push("silenced = :si"); values[":si"] = !!patch.silenced; }

  try {
    const { Attributes } = await docClient.send(
      new UpdateCommand({
        TableName: TABLES.ALERT_RULES,
        Key: { pk: PK, ruleId },
        UpdateExpression: "SET " + sets.join(", "),
        ConditionExpression: "version = :curV",
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      })
    );
    return Attributes as AlertRule;
  } catch (e: any) {
    if (e?.name === "ConditionalCheckFailedException") throw new OptimisticLockError();
    throw e;
  }
}

// 引擎更新水位:只推进 lastEvaluatedAt,不动 version(内部调用,非用户编辑,避免打乱乐观锁)。
export async function bumpWatermark(ruleId: string, at: string): Promise<void> {
  await docClient
    .send(
      new UpdateCommand({
        TableName: TABLES.ALERT_RULES,
        Key: { pk: PK, ruleId },
        UpdateExpression: "SET lastEvaluatedAt = :at",
        ExpressionAttributeValues: { ":at": at },
      })
    )
    .catch(() => {});
}

export async function deleteRule(ruleId: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLES.ALERT_RULES, Key: { pk: PK, ruleId } }));
}
