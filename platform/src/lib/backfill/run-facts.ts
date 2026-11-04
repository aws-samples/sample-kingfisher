// (客户 2026-10-19 反馈 b,台账)
// 补数实例的「可观测事实」唯一作者:把实例行(bgp-backfill-instances)与它底层那条 run(bgp-task-runs)
// 的终态 / 错误 / 行数指标 / 日志定位键**合成一份**给页面;以及「成功但 0 行」的判定与提示。
//
// 【为什么单独一个文件】补数页此前只画状态色块:成功 / 失败各一个字,「成功但目标表没数据」在页面上与
// 「成功且写了 10 万行」长得一模一样,日志只能去任务监控页按运行找、两页之间没有跳转。写入行数 / 日志键
// 本来就在 run 行上(同步任务 `metrics.rowsWritten`,;Redshift 语句本批补 `metrics.rowsAffected`),
// 缺的是**把它们接到实例上**。这里是接缝的唯一作者:路由 / 页面只消费,不各自去读 run 表。
//
// 🔴 行数语义诚实化:
//   · `rowsWritten`(number):有机器可读的写入侧指标 —— 同步任务取 `metrics.rowsWritten`(写入侧),
//     Redshift SQL 作业 / 工作流 SQL 节点取 `metrics.rowsAffected`(Data API `ResultRows` 之和 = 受影响行数);
//   · `null`:这类运行**不产出**行数指标(EMR 作业、Glue PySpark 脚本作业等)⇒ 页面写「未上报」,不写 0,
//     「不知道」与「零」是两个事实(与 verify-script-quality-lesson 同一条铁律)。
//   · 「成功但 0 行」只在 `status=succeeded ∧ rowsWritten === 0` 时成立 ⇒ 页面标黄并给**候选原因**(不是结论)。
import { BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import type { BackfillInstanceRow } from "./types";

/** 行数来源(页面据此说清「这个数怎么来的」)。 */
export type RowsSource = "sync-metrics" | "redshift-affected" | "unknown";

export interface BackfillRunFacts {
  runTaskId: string;
  runId: string;
  /** 底层 run 的 taskType(sync / etl / workflow / emr-serverless …;run 行没有就空串) */
  taskType: string;
  status: string;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** 秒;run 行没有就 null */
  duration: number | null;
  /** 写入 / 受影响行数;null = 该类运行不产出行数指标 */
  rowsWritten: number | null;
  rowsRead: number | null;
  rowsSource: RowsSource;
  /** 日志定位键(有则页面给「本区 Glue 作业运行」直达) */
  glueJobName: string | null;
  glueJobRunId: string | null;
  statementId: string | null;
  /** run 行的章(实际执行区)。字段名刻意不叫 targetId:这不是落点入参,是 run 行上已盖的章的投影(落点棘轮只盯入参签名) */
  stampedTargetId: string | null;
}

export interface BackfillRowsSummary {
  /** 已知行数的实例的写入行数之和 */
  rowsWrittenTotal: number;
  /** 行数已知(成功且有指标)的实例数 */
  instancesWithRows: number;
  /** 成功但写入 0 行的实例数 */
  instancesZeroRows: number;
  /** 成功但该类运行不产出行数的实例数 */
  instancesUnknown: number;
}

const BATCH = 100; // DynamoDB BatchGetItem 上限

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/**
 * 把一条 run 行映射成事实(纯函数,可单测)。
 * 行数取法:① `metrics.rowsWritten`(同步任务,写入侧)② `metrics.rowsAffected`(Redshift 语句受影响行数)③ 都没有 ⇒ null。
 */
export function runFactsOf(run: Record<string, unknown>): BackfillRunFacts {
  const metrics = (run.metrics && typeof run.metrics === "object" ? run.metrics : {}) as Record<string, unknown>;
  const written = num(metrics.rowsWritten);
  const affected = num(metrics.rowsAffected);
  const rowsWritten = written !== null ? written : affected;
  const rowsSource: RowsSource = written !== null ? "sync-metrics" : affected !== null ? "redshift-affected" : "unknown";
  return {
    runTaskId: String(run.taskId ?? ""),
    runId: String(run.runId ?? ""),
    taskType: typeof run.taskType === "string" ? run.taskType : "",
    status: typeof run.status === "string" ? run.status : "",
    error: str(run.error),
    startedAt: str(run.startedAt),
    finishedAt: str(run.finishedAt),
    duration: num(run.duration),
    rowsWritten,
    rowsRead: num(metrics.rowsRead),
    rowsSource,
    glueJobName: str(run.glueJobName),
    glueJobRunId: str(run.glueJobRunId),
    statementId: str(run.statementId),
    stampedTargetId: str(run.targetId),
  };
}

/**
 * 批量读实例对应的 run 行(按 (runTaskId, runId) 去重,每批 ≤ 100;`UnprocessedKeys` 继续取,取不到就**抛**)。
 * 🔴 读失败一律抛,不回「空事实」:「读不到」与「这条 run 没有行数」是两个事实,合成一个值上层会说谎。
 */
export async function loadRunFacts(instances: readonly BackfillInstanceRow[]): Promise<Map<string, BackfillRunFacts>> {
  const keys = new Map<string, { taskId: string; runId: string }>();
  for (const inst of instances) {
    if (inst.runTaskId && inst.runId) keys.set(`${inst.runTaskId}#${inst.runId}`, { taskId: inst.runTaskId, runId: inst.runId });
  }
  const out = new Map<string, BackfillRunFacts>();
  const all = Array.from(keys.values()); // tsconfig target 不许直接展开 MapIterator
  for (let i = 0; i < all.length; i += BATCH) {
    let pending = all.slice(i, i + BATCH);
    for (let round = 0; round < 5 && pending.length; round++) {
      const res = await docClient.send(new BatchGetCommand({ RequestItems: { [TABLES.TASK_RUNS]: { Keys: pending } } }));
      for (const row of (res.Responses?.[TABLES.TASK_RUNS] ?? []) as Record<string, unknown>[]) {
        out.set(`${String(row.taskId)}#${String(row.runId)}`, runFactsOf(row));
      }
      pending = (res.UnprocessedKeys?.[TABLES.TASK_RUNS]?.Keys ?? []) as Array<{ taskId: string; runId: string }>;
    }
    if (pending.length) throw new Error(`backfill.loadRunFacts:${pending.length} 条 run 行连取 5 轮仍未取到,拒绝回一份残缺的事实`);
  }
  return out;
}

/** 实例 ⇒ 它的 run 事实(没有 run 定位键 / run 行不在 ⇒ undefined)。 */
export function factsForInstance(inst: BackfillInstanceRow, facts: Map<string, BackfillRunFacts>): BackfillRunFacts | undefined {
  if (!inst.runTaskId || !inst.runId) return undefined;
  return facts.get(`${inst.runTaskId}#${inst.runId}`);
}

/** 「成功但 0 行」—— 只认 succeeded ∧ 行数已知 ∧ 为 0。 */
export function isZeroRowSuccess(inst: Pick<BackfillInstanceRow, "status">, run: BackfillRunFacts | undefined): boolean {
  return inst.status === "succeeded" && !!run && run.rowsWritten === 0;
}

/**
 * 「成功但 0 行」的候选原因(**不是结论**:平台只知道写了 0 行,不知道源里为什么没有)。按目标类型给人能核对的方向。
 * 返回空数组 = 不是 0 行成功。
 */
export function zeroRowHints(inst: Pick<BackfillInstanceRow, "status" | "date" | "nodeType">, run: BackfillRunFacts | undefined): string[] {
  if (!isZeroRowSuccess(inst, run)) return [];
  const day = inst.date;
  const base = [
    `源表在业务日期 ${day} 的窗口里没有数据(按日期变量 / 分区过滤后为空)`,
    "任务的 WHERE / 过滤条件在这个日期没有命中任何行",
  ];
  if (run?.taskType === "sync" || inst.nodeType === "sync") {
    return [...base, "增量同步的水位已越过该日期(增量任务按业务日期补数不会回退水位;要回刷请用全量 + 日期变量)"];
  }
  return [...base, "SQL 的 INSERT / CTAS 本身就筛出了 0 行(先用「指定日期运行」或直查页按该日期手跑一次 SELECT 核对)"];
}

/** 计划级行数汇总(只统计 succeeded 实例;未知行数的单独计数,不混进总和)。 */
export function summarizeRows(instances: readonly BackfillInstanceRow[], facts: Map<string, BackfillRunFacts>): BackfillRowsSummary {
  const s: BackfillRowsSummary = { rowsWrittenTotal: 0, instancesWithRows: 0, instancesZeroRows: 0, instancesUnknown: 0 };
  for (const inst of instances) {
    if (inst.status !== "succeeded") continue;
    const run = factsForInstance(inst, facts);
    if (!run || run.rowsWritten === null) { s.instancesUnknown += 1; continue; }
    s.instancesWithRows += 1;
    s.rowsWrittenTotal += run.rowsWritten;
    if (run.rowsWritten === 0) s.instancesZeroRows += 1;
  }
  return s;
}
