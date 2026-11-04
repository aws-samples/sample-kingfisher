// @kf-batch 50-WP15-airflow-serverless(T-12)
// **台账行键的唯一作者**:`bgp-task-runs` 的 `(taskId, runId)` 在多 region 下怎么才不碰撞。
//
// ── 为什么必须有这一刀(真环境 2026-09-07 坐实)──────────────────────────────────
// 50 SPEC §1.2 早写明「复合 runId 存在的唯一理由 = 同 cron 两 target 的 `scheduled__<logical_date>` 完全相同」,
// 但四个**调度器侧**写入方(serverless 运行时 / legacy ETL DAG / legacy EMR DAG / legacy workflow DAG)一直写 raw run_id。
// 后果不是报错,是**静默覆盖**:同一作业绑 home + usw2_a,两区各自跑完各写一行 ⇒ 同键 ⇒ **后写的盖掉先写的**。
// 实测(sls 第六轮):两区 workflow 都 SUCCESS、两区 CTAS 都真跑,而 `bgp-task-runs` 只剩 1 行 `targetId=tgt_usw2_a`
// ⇒ 「一个区的成功盖掉另一个区的记录」,在跨法域场景下等于**审计缺失**;若一区失败一区成功,看板还会假绿。
//
// ── 唯一性口径(不变量) ────────────────────────────────────────────────────────
// **一行 = 一次 (作业 × target × 运行)**。实现按 runId 的来源分两种落法(同一不变量,不是两套口径):
//   · **平台侧发起**(手动运行 / API):runId = `ulid()`,**本身就唯一** ⇒ 不复合(改了会打断按 (taskId, runId) 轮询的调用方)。
//   · **调度器侧发起**:raw id 是**确定性**的,必须复合成 `<raw>#<targetId>`:
//       - 经典 MWAA:raw = Airflow `run_id`(`scheduled__<logical_date>`,每次 cron 不同)⇒ 复合后跨 target 唯一。
//       - MWAA Serverless:🔴 Airflow `run_id` **退化成常量**(实测两次不同 run 都是 `scheduled__2026-09-07T00:00:00+00:00`,
//         且手动 StartWorkflowRun 与 cron 触发**完全无法在 worker 侧区分**)⇒ raw 取**服务侧 per-run 唯一的 dag_id**
//         (`AIRFLOW_CTX_DAG_ID` = `ex_<uuid>`,每次 run 都不同),否则多次 cron 仍会互相覆盖。
// 另写 `taskTargetKey = <taskId>#<targetId>`:50 SPEC §1.2 定案 GSI `byTaskTarget` 的分区键,现在先落数据(稀疏索引可后建)。
//
// 🔴 **别把复合 runId 再拼进其它 `#` 分隔键的中间段**(SPEC §1.2 X2):告警去重键 `run#<runId>`、incidents `occ#<sig>#<...>`
//   都以 `#` 分段;复合后段数可变,任何 `split("#")[1]` 式解析会拿到 raw ⇒ 两 target 并进同一去重键 = 跨 target 告警互相压制。
//   现状:这两处只把 runId 放在**末段**、且没有反向解析,复合后反而让两个 target 各有自己的去重键(是修好,不是弄坏)。

/** 台账 runId / taskTargetKey 的分段符(SPEC §1.2)。 */
export const RUN_KEY_SEPARATOR = "#";

/** 调度器侧 raw run 标识 → 台账 runId(跨 target 唯一)。 */
export function composeRunId(rawRunId: string, targetId: string): string {
  const raw = String(rawRunId ?? "").trim();
  const t = String(targetId ?? "").trim();
  if (!raw) throw new Error("composeRunId:raw run 标识为空(调度器侧一定给得出;为空说明上游取错了字段)");
  if (!t) throw new Error("composeRunId:targetId 为空 —— 台账行没有 target 就无法按区归因,拒绝写");
  return `${raw}${RUN_KEY_SEPARATOR}${t}`;
}

/** GSI `byTaskTarget` 的分区键。 */
export function composeTaskTargetKey(taskId: string, targetId: string): string {
  const id = String(taskId ?? "").trim();
  const t = String(targetId ?? "").trim();
  if (!id || !t) throw new Error("composeTaskTargetKey:taskId / targetId 都必填");
  return `${id}${RUN_KEY_SEPARATOR}${t}`;
}

/** 从台账 runId 取回 raw 段(只给排障看;**不要**用它做业务判断 —— raw 在 serverless 下不唯一)。 */
export function rawRunIdOf(runId: string): string {
  const s = String(runId ?? "");
  const i = s.lastIndexOf(RUN_KEY_SEPARATOR);
  return i < 0 ? s : s.slice(0, i);
}

/**
 * 注入生成式 DAG(Python 字面量)的复合键片段 —— 让四个调度器侧写入方**共用同一份表达式**,不各写一遍。
 * `rawExpr` 是 Python 表达式(如 `run_id`);`targetId` 是本份产物绑定的 target(生成时已知的字面值)。
 */
export function pyRunKeyFields(args: { taskIdExpr: string; rawExpr: string; targetId: string }): string {
  const { taskIdExpr, rawExpr, targetId } = args;
  if (!targetId) throw new Error("pyRunKeyFields:targetId 必填(台账行必须能按区归因)");
  const t = JSON.stringify(targetId);
  return `"runId": ${rawExpr} + "${RUN_KEY_SEPARATOR}" + ${t}, "taskTargetKey": ${taskIdExpr} + "${RUN_KEY_SEPARATOR}" + ${t}`;
}
