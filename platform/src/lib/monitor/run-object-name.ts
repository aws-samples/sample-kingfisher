// 运行台账行里的 taskId 指向哪个资源对象、它现在叫什么 —— 唯一作者。
//
// 运行行从不写对象名(对象会改名;监控页、运维大屏、告警文案都在读时按 id 取现名)。
// 2026-11-11 真环境坐实:告警规则的事件文案从运行行取名字 ⇒ 消息里永远是裸 id;当时「id → 名字」另有三份各写各的
// (监控页五张表 / 运维大屏四张表 / SLA 绑定对象逐表试三张),少一张表的那一处就只能显示裸 id。
// 现在资源表清单只在这里:新增一种会写运行行的对象 = 在 RUN_OBJECT_TABLES 加一行,所有读名字的地方同时生效。

import { BatchGetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { logger } from "@/lib/observability/logger";

/** 五张资源表的分区键值(单租户分区;与各表的写者同一字面)。 */
const USER_ID = "default-user";

/** 运行行的 taskId 可能指向的资源表(闭合清单):对象种类 + 表名 + 主键里承载对象 id 的属性名。 */
export const RUN_OBJECT_TABLES = [
  { kind: "sync", table: TABLES.SYNC_TASKS, idAttr: "taskId" },
  { kind: "workflow", table: TABLES.WORKFLOWS, idAttr: "workflowId" },
  { kind: "etl", table: TABLES.ETL_JOBS, idAttr: "jobId" },
  { kind: "engine", table: TABLES.ENGINE_JOBS, idAttr: "jobId" },
  // 平台动作的调度对象(治理定时任务 / 问数卡片定时刷新)
  { kind: "action", table: TABLES.ACTION_SCHEDULES, idAttr: "taskId" },
] as const;

export type RunObjectKind = (typeof RUN_OBJECT_TABLES)[number]["kind"];

/** 某种对象在它那张表里的主键。 */
export function runObjectKey(kind: RunObjectKind, id: string): Record<string, string> {
  const spec = RUN_OBJECT_TABLES.find((t) => t.kind === kind)!;
  return { userId: USER_ID, [spec.idAttr]: id };
}

export interface RunObjectNameIndex {
  /** id → 现名(没有名字的对象不在里面;调用方自己决定回落成什么)。 */
  names: Record<string, string>;
  /** 每种对象有哪些 id(含没有名字的),供调用方分辨一条运行属于哪种对象。 */
  idsByKind: Record<RunObjectKind, Set<string>>;
}

const nameOfItem = (it: Record<string, unknown>): string => (typeof it.name === "string" ? it.name.trim() : "");

/** 一张表最多翻这么多页(每页至多 1 MB;只投影 id 与名字,够百万级对象)。 */
const MAX_SCAN_PAGES = 50;

/**
 * 全量名字表(列表类页面用):五张表各翻页扫全,只投影 id 与名字。
 * `filter` = 调用方的行过滤(监控页按项目过滤;平台聚合类不传)。
 * 某张表读失败 ⇒ 那张表的名字缺席、记一条告警日志,不让整个列表失败(名字是展示增强)。
 */
export async function scanRunObjectNames(
  filter?: { clause: string; values: Record<string, unknown> },
): Promise<RunObjectNameIndex> {
  const names: Record<string, string> = {};
  const idsByKind = Object.fromEntries(RUN_OBJECT_TABLES.map((t) => [t.kind, new Set<string>()])) as Record<RunObjectKind, Set<string>>;
  await Promise.all(
    RUN_OBJECT_TABLES.map(async ({ kind, table, idAttr }) => {
      try {
        let startKey: Record<string, unknown> | undefined;
        for (let page = 0; page < MAX_SCAN_PAGES; page++) {
          const res = await docClient.send(
            new ScanCommand({
              TableName: table,
              ProjectionExpression: `${idAttr}, #n`,
              ExpressionAttributeNames: { "#n": "name" },
              ...(filter ? { FilterExpression: filter.clause, ExpressionAttributeValues: filter.values } : {}),
              ExclusiveStartKey: startKey,
            }),
          );
          for (const it of (res.Items ?? []) as Record<string, unknown>[]) {
            const id = it[idAttr];
            if (typeof id !== "string" || !id) continue;
            idsByKind[kind].add(id);
            const name = nameOfItem(it);
            if (name) names[id] = name;
          }
          startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
          if (!startKey) break;
        }
      } catch (e) {
        logger.warn("run-object-name.scan.failed", { table, error: String((e as Error)?.message ?? e).slice(0, 200) });
      }
    }),
  );
  return { names, idsByKind };
}

/** 一次批量读最多 100 个键;五张表各问一遍 ⇒ 每批 20 个 id。 */
const IDS_PER_BATCH = Math.floor(100 / RUN_OBJECT_TABLES.length);
/** 批量读被限流退回的键最多再问几轮。 */
const UNPROCESSED_RETRIES = 3;

/**
 * 按 id 集合取现名(告警文案这类「只关心少数几个对象」的路径用):不知道 id 属于哪张表 ⇒ 五张表各问一遍,谁有就是谁。
 * 空集合 ⇒ 不发任何读。读失败 ⇒ 记告警日志、返回已取到的部分(调用方回落到 id;告警本身不能因为取不到名字而不发)。
 */
export async function runObjectNamesByIds(ids: Iterable<string>): Promise<Record<string, string>> {
  const distinct = Array.from(new Set(Array.from(ids).filter((id) => typeof id === "string" && id)));
  const names: Record<string, string> = {};
  for (let i = 0; i < distinct.length; i += IDS_PER_BATCH) {
    const batch = distinct.slice(i, i + IDS_PER_BATCH);
    let request: Record<string, { Keys: Record<string, unknown>[]; ProjectionExpression: string; ExpressionAttributeNames: Record<string, string> }> | undefined =
      Object.fromEntries(
        RUN_OBJECT_TABLES.map(({ kind, table, idAttr }) => [
          table,
          { Keys: batch.map((id) => runObjectKey(kind, id)), ProjectionExpression: `${idAttr}, #n`, ExpressionAttributeNames: { "#n": "name" } },
        ]),
      );
    try {
      for (let round = 0; request && round <= UNPROCESSED_RETRIES; round++) {
        const res = await docClient.send(new BatchGetCommand({ RequestItems: request }));
        for (const { table, idAttr } of RUN_OBJECT_TABLES) {
          for (const it of ((res.Responses ?? {})[table] ?? []) as Record<string, unknown>[]) {
            const id = it[idAttr];
            const name = nameOfItem(it);
            if (typeof id === "string" && id && name) names[id] = name;
          }
        }
        const left = res.UnprocessedKeys as typeof request | undefined;
        request = left && Object.keys(left).length ? left : undefined;
      }
      if (request) logger.warn("run-object-name.batch.unprocessed", { tables: Object.keys(request) });
    } catch (e) {
      logger.warn("run-object-name.batch.failed", { ids: batch.length, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }
  return names;
}
