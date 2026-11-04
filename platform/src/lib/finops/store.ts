// 模块 40 — FinOps 3 表读写(照 lib/incidents/store.ts 风格;表名走模块内 FINOPS_TABLES)。

import { GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@/lib/aws/dynamodb";
import { FINOPS_TABLES, WATERMARK_PK, COST_RUN_TTL_DAYS, COST_DAILY_PK_PREFIX } from "./constants";
import type { Budget, CostDailyRow, CostRunRow } from "./types";

// ── 水位(bgp-cost-daily 表内 meta item)──────────────────────

export async function getWatermark(sk: string): Promise<string | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: FINOPS_TABLES.COST_DAILY, Key: { pk: WATERMARK_PK, sk } })
  );
  return (Item?.value as string) ?? null;
}

export async function setWatermark(sk: string, value: string): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: FINOPS_TABLES.COST_DAILY,
      Item: { pk: WATERMARK_PK, sk, value, updatedAt: new Date().toISOString() },
    })
  );
}

// ── L1 服务日成本 ─────────────────────────────────────────────

// @kf-batch 50-WP6-cost-by-region —— 🔴 pk 前缀只认 `COST_DAILY_PK_PREFIX`(v2)。读写同一个作者,
// 旧分区 `cost#<month>` 不在任何读路径上 ⇒ 旧格式行**结构上**进不了合计(E-173),也无需删除。
export const costDailyPk = (month: string) => `${COST_DAILY_PK_PREFIX}${month}`; // month = yyyy-MM

export const costDailySk = (row: Pick<CostDailyRow, "date" | "service" | "region">) =>
  `${row.date}#${row.service}#${row.region}`;

export async function upsertCostDaily(row: Omit<CostDailyRow, "pk" | "sk">): Promise<void> {
  // 🔴 sk 带 region:同一天同一个服务在多个区各有一行;不带的话第二个区会**覆盖**第一个区(总额少算、无声)。
  // 🔴 fail-closed:region 空 ⇒ 拒写,绝不退回两段 sk(那正是旧分区里「账号级合计」的形状)。
  if (!row.region || !row.region.trim()) {
    throw new Error(`成本日行缺 region(${row.date} ${row.service}):v2 分区只收按区明细,拒绝写入`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
    throw new Error(`成本日行 date 非 yyyy-MM-dd:${row.date}`);
  }
  await docClient.send(
    new PutCommand({
      TableName: FINOPS_TABLES.COST_DAILY,
      Item: { ...row, pk: costDailyPk(row.date.slice(0, 7)), sk: costDailySk(row) },
    })
  );
}

export async function listCostDaily(month: string): Promise<CostDailyRow[]> {
  // 🔴 必须翻页:一个月 × 服务数 × 区数可以过 1MB(两区 × 40 个服务 × 31 天 ≈ 2.5k 行)。
  // 只读第一页 = 月末的天数静默丢失,大盘与 CE 对不上(E-170)。
  const out: CostDailyRow[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const { Items = [], LastEvaluatedKey } = await docClient.send(
      new QueryCommand({
        TableName: FINOPS_TABLES.COST_DAILY,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": costDailyPk(month) },
        ExclusiveStartKey: lastKey,
      })
    );
    out.push(...(Items as CostDailyRow[]));
    lastKey = LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return out;
}

// ── L3 run 级归因 ─────────────────────────────────────────────

export const costRunPk = (taskId: string) => `taskcost#${taskId}`;

// 条件写幂等:重复 sweep/backfill 对已记 run 直接跳过(返回 false)。
export async function putCostRunIfNew(row: Omit<CostRunRow, "pk" | "ttl">): Promise<boolean> {
  try {
    await docClient.send(
      new PutCommand({
        TableName: FINOPS_TABLES.COST_RUNS,
        Item: {
          ...row,
          pk: costRunPk(row.taskId),
          ttl: Math.floor(Date.now() / 1000) + COST_RUN_TTL_DAYS * 86400,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      })
    );
    return true;
  } catch (e: unknown) {
    if ((e as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

export async function listCostRuns(taskId: string, limit = 100): Promise<CostRunRow[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: FINOPS_TABLES.COST_RUNS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": costRunPk(taskId) },
      ScanIndexForward: false, // runId=ULID,倒序≈时间倒序
      Limit: limit,
    })
  );
  return Items as CostRunRow[];
}

// 排行聚合用:全表扫(低量表,TTL 180d 封顶;排行页非热路径)。
export async function scanAllCostRuns(): Promise<CostRunRow[]> {
  const out: CostRunRow[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const { Items = [], LastEvaluatedKey } = await docClient.send(
      new ScanCommand({ TableName: FINOPS_TABLES.COST_RUNS, ExclusiveStartKey: lastKey })
    );
    out.push(...(Items as CostRunRow[]));
    lastKey = LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return out;
}

// ── 预算 ──────────────────────────────────────────────────────

export const budgetPk = (projectId: string) => `budget#${projectId}`;

export async function listBudgets(projectId: string): Promise<Budget[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: FINOPS_TABLES.BUDGETS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": budgetPk(projectId) },
    })
  );
  return Items as Budget[];
}

export async function getBudget(projectId: string, budgetId: string): Promise<Budget | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: FINOPS_TABLES.BUDGETS, Key: { pk: budgetPk(projectId), sk: budgetId } })
  );
  return (Item as Budget) ?? null;
}

export async function putBudget(b: Budget): Promise<void> {
  await docClient.send(new PutCommand({ TableName: FINOPS_TABLES.BUDGETS, Item: b }));
}

// 乐观锁更新(version 不符 → ConditionalCheckFailedException 由调用方转 409)。
export async function updateBudget(b: Budget, expectVersion: number): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: FINOPS_TABLES.BUDGETS,
      Item: { ...b, version: expectVersion + 1, updatedAt: new Date().toISOString() },
      ConditionExpression: "version = :v",
      ExpressionAttributeValues: { ":v": expectVersion },
    })
  );
}

export async function deleteBudget(projectId: string, budgetId: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({ TableName: FINOPS_TABLES.BUDGETS, Key: { pk: budgetPk(projectId), sk: budgetId } })
  );
}

// 阈值告警去重标记(原子追加;每月每档只推一次)。
export async function markBudgetNotified(projectId: string, budgetId: string, mark: string): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: FINOPS_TABLES.BUDGETS,
      Key: { pk: budgetPk(projectId), sk: budgetId },
      UpdateExpression: "SET notifiedMarks = list_append(if_not_exists(notifiedMarks, :empty), :m)",
      ExpressionAttributeValues: { ":empty": [], ":m": [mark] },
    })
  );
}

export async function updateBudgetEval(
  projectId: string,
  budgetId: string,
  lastEval: Budget["lastEval"]
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: FINOPS_TABLES.BUDGETS,
      Key: { pk: budgetPk(projectId), sk: budgetId },
      UpdateExpression: "SET lastEval = :e, updatedAt = :t",
      ExpressionAttributeValues: { ":e": lastEval, ":t": new Date().toISOString() },
    })
  );
}
