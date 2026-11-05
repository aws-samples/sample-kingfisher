// 2026-11-04 —— 「这个作业还有没有在途运行」的**唯一作者** + 删作业时的 409 拒因 + 轮询器「作业定义已不存在」的收口口径。
//
// 【缺陷原形(2026-11-03 p72 首跑,…3772 b395eecb)】离线计算 Glue 作业「立即运行」提交成功(run 行 running、Glue JobRun 已起)后
//   20 秒内页面「删除」⇒ `DELETE /api/etl-jobs/[id]` 不核在途运行 ⇒ 200 删成、Glue 作业定义随删(deleteGlueJobs)⇒
//   `pollGlueRun` 对 GetJobRun 的 EntityNotFoundException 一律 catch 继续轮询 ⇒ run 行**永远「运行中」**(任务监控孤儿),
//   而列表对账要读已删的作业行 ⇒ 永不收口。EMR 引擎作业删除路由同一个洞(`engine-job` 租约只盖提交段)。
//   同类:长操作对象租约 · 删源前核引用。工程纪律「删对象不留孤儿」/「状态只许来自真正的结论」。
// 【根治三件事】
//   ① 删前核在途:`jobInflight()` = task-runs 里该 taskId **未终态**的 run 行(词表单一作者 `isTerminalRunStatus`,fail-closed;
//      所有载体开跑即落 running 行:TS 提交段在 StartJobRun 后立刻写,两套 Python 执行体2026-11-04 起 `_record_start` —— 更早发布的 DAG 要重发才有)
//      ∪ 作业行上**刚续租过**的运行锁(只盖 TS 提交段抢到锁、run 行还没写出来的那几秒;Python 持有者不续租,不靠它)。
//      任一非空 ⇒ `jobRunInProgressResponse` 409 `JOB_RUN_IN_PROGRESS`,逐条列 runId 指路,作业行 / Glue 定义 / application / 调度产物一个都不动。
//      删行本身是条件写(`jobRowDeleteInput`:每把作业级锁都不存在或没人刚续租),把「核完到删之间刚好有一次运行抢到锁」的窄窗交给 DDB 原子地判。
//   ② 轮询器收口:GetJobRun 说实体不存在(只认 SDK 错误名)⇒ 再问一次定义本体(Glue GetJob / EMR GetApplication);定义真没了 ⇒ 当场把 run 行写
//      `failed`(error = `JOB_DEFINITION_GONE_ERROR.*`,原话给用户看)并释放锁,不再空转 40 / 60 分钟留孤儿。瞬时错误照旧有界重试。
//      续租失败时由 run-lock 原子分辨「行已删」与「被接管」:行已删 ⇒ 继续跟踪到终态(不再续租),不再静默停。
//   ③ 作业行回写一律 `attribute_exists` 条件写(job-service / emr run-record / persistApplicationId / 两套 Python):作业行已删就丢弃,绝不 upsert 出幽灵行;
//      作业行锁只许落在存在的行上(`requireRowExists`),行不在 ⇒ `JobRowMissing`(运行路由 409「作业已被删除」,补数 / 定时不再排队 45–60 分钟)。
// 【为什么锁只认「刚续租过」】轮询耗尽后 `keepRunLockForReconcile` 刻意保持持锁(P0-6:后端状态未知),可以挂 90 分钟;
//   那时 run 行(经对账)才是权威 —— 一把没人再续租的锁不该挡住删除。活着的 TS 持有者每 60 秒续一次,两个间隔内没续 = 没人看着。
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-response";
import { listRunsByTask } from "@/lib/monitor/run-records";
import { isTerminalRunStatus } from "@/lib/monitor/run-groups";
import { heldJobRunLocks, noLiveJobLockCondition } from "@/lib/etl/run-lock";
import { bindingTargets } from "@/lib/exec-env/data-plane-target";

const USER_ID = "default-user";

export const JOB_RUN_IN_PROGRESS_CODE = "JOB_RUN_IN_PROGRESS" as const;

export interface InflightRun {
  runId: string;
  status: string;
  startedAt?: string;
  /** run 行的落点章(唯一写通道盖的,恒有;P50 之前的存量行没有章 ⇒ 空串,文案里不显示) */
  targetId: string;
  taskType?: string;
}

export interface LiveRunLock {
  targetId: string;
  expiresAt: number;
  renewedAgoMs: number;
}

export interface JobInflight {
  /** task-runs 里仍未终态的 run(按 startedAt 升序) */
  runs: InflightRun[];
  /** 作业行上仍被活着的持有者续租着的运行锁(run 行还没写出来的提交窗) */
  locks: LiveRunLock[];
}

/** 删作业的两条路:离线计算(ETL,Glue / Redshift)与引擎作业(EMR)。只影响 409 文案里的「怎么停」指路 —— ETL 页没有单条运行的停止入口,不许承诺。 */
export type JobDeleteKind = "etl" | "engine";

/**
 * 读该作业的在途运行。`jobRow` 传已读到的作业行(DELETE 路由手里已有,不再读第二次);传 null 只看 run 行。
 * 🔴 读失败一律抛(`listRunsByTask` 的口径):「读不到」≠「没有」,删除路由据此 500,而不是放行。
 */
export async function jobInflight(jobId: string, jobRow: Record<string, unknown> | null | undefined, now = Date.now()): Promise<JobInflight> {
  const id = String(jobId ?? "").trim();
  if (!id) return { runs: [], locks: [] };
  const rows = await listRunsByTask(id);
  const runs: InflightRun[] = rows
    .filter((r) => !isTerminalRunStatus(r.status))
    .map((r) => ({
      runId: String(r.runId ?? ""),
      status: typeof r.status === "string" ? r.status : String(r.status ?? ""),
      ...(typeof r.startedAt === "string" ? { startedAt: r.startedAt } : {}),
      targetId: typeof r.targetId === "string" ? r.targetId : "",
      ...(typeof r.taskType === "string" ? { taskType: r.taskType } : {}),
    }))
    .sort((a, b) => String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")) || a.runId.localeCompare(b.runId));
  const locks: LiveRunLock[] = heldJobRunLocks(jobRow, now)
    .filter((l) => l.recentlyRenewed)
    .map((l) => ({ targetId: l.targetId, expiresAt: l.expiresAt, renewedAgoMs: l.renewedAgoMs }));
  return { runs, locks };
}

export function hasInflight(x: JobInflight): boolean {
  return x.runs.length > 0 || x.locks.length > 0;
}

/** run 状态的用户用词(词表单一作者是 RUN_CHILD_STATUSES / RUN_INFLIGHT_STATUSES;终态行到不了这里,词表外的值原样给出) */
function runStatusLabel(status: string): string {
  if (status === "running") return "运行中";
  if (status === "timeout-pending") return "已到调度器软限、等待对账";
  return status || "状态缺失";
}

/** `timeout-pending`(B2):用户要的出路不是「等」而是「让平台对账」—— 对账在读作业列表时发生,所以指到列表刷新。 */
function softLimitHint(kind: JobDeleteKind): string {
  const where = kind === "engine" ? "引擎作业列表" : "离线计算页的作业列表";
  return `其中「已到调度器软限、等待对账」的运行是调度器等了 50 分钟后放手的,后端可能仍在跑:请先刷新一次${where}(平台会按后端真实状态对账收口),收口后再删除。`;
}

/**
 * 删作业被拒的响应(409 `JOB_RUN_IN_PROGRESS`;页面经 deleteJson 把 message 原话给用户看)。
 *   有在途 run 行:`这个作业仍有 N 条运行未结束:「<runId>」(运行中 · <targetId> · <startedAt> 开始)、… —— 已拒绝删除。请等待这些运行结束后再删除[(或先在运行历史里「停止」它们)];现在删掉会让它们的运行记录永远停在「运行中」,也无法再被跟踪。[softLimitHint]`
 *   只有刚续租的锁 / 删行条件写被拒(提交窗,run 行还没写出来):`这个作业正在提交一次运行 —— 已拒绝删除。请稍候几秒后重试。`(锁的内部细节只进 detail.locks)
 *   detail = { runs:[{ runId, status, startedAt, targetId }], locks:[{ targetId, expiresAt, renewedAgoMs }] }
 */
export function jobRunInProgressResponse(x: JobInflight, kind: JobDeleteKind): NextResponse {
  const { runs, locks } = x;
  let message: string;
  if (runs.length) {
    const items = runs
      .map((r) => `「${r.runId}」(${runStatusLabel(r.status)}${r.targetId ? ` · ${r.targetId}` : ""}${r.startedAt ? ` · ${r.startedAt} 开始` : ""})`)
      .join("、");
    const stopHint = kind === "engine" ? "(或先在运行历史里「停止」它们)" : "";
    message =
      `这个作业仍有 ${runs.length} 条运行未结束:${items} —— 已拒绝删除。` +
      `请等待这些运行结束后再删除${stopHint};现在删掉会让它们的运行记录永远停在「运行中」,也无法再被跟踪。` +
      (runs.some((r) => r.status === "timeout-pending") ? softLimitHint(kind) : "");
  } else {
    message = "这个作业正在提交一次运行 —— 已拒绝删除。请稍候几秒后重试。";
  }
  return apiError(message, 409, {
    code: JOB_RUN_IN_PROGRESS_CODE,
    detail: {
      runs: runs.map((r) => ({ runId: r.runId, status: r.status, startedAt: r.startedAt, targetId: r.targetId })),
      locks: locks.map((l) => ({ targetId: l.targetId, expiresAt: l.expiresAt, renewedAgoMs: l.renewedAgoMs })),
    },
  });
}

// ── ② 轮询器收口口径:作业定义本体已不存在 ⇒ run 按失败收口(error 原话;两个轮询器与判据共用这一份) ──

export const JOB_DEFINITION_GONE_ERROR = {
  /** Glue:GetJobRun 与 GetJob 都说 EntityNotFound */
  glue: "Glue 作业定义已不存在,运行无法继续跟踪;状态按失败收口(作业可能已被删除)",
  /** EMR Serverless:GetJobRun 说 ResourceNotFound 且 GetApplication 说不存在 / 已 TERMINATED */
  emr: "EMR application 已不存在,运行无法继续跟踪;状态按失败收口(作业可能已被删除)",
} as const;

/** EMR Serverless SDK 的「没有这个资源」(与 target-clients 里 Secrets / Glue 的口径一致:只认这个名字,别的错一律当瞬时)。 */
export function isEmrResourceNotFound(e: unknown): boolean {
  return (e as { name?: string } | null | undefined)?.name === "ResourceNotFoundException";
}

/**
 * Glue SDK 的「实体不存在」—— 🔴 **只认错误名**(S2)。`lib/aws/glue-job-upsert.isGlueEntityNotFound` 还接受 /not found/i 的 message,
 * 那是建作业路径「拿不到就建」的宽口径;这里是**收口 run 的依据**,把别的错误(如 `Connection not found`)判成「定义已删」会写错终态。
 */
export function isGlueEntityNotFoundByName(e: unknown): boolean {
  return (e as { name?: string } | null | undefined)?.name === "EntityNotFoundException";
}

// ── ①′ 删行的条件写(S1):DeleteItem 输入由这里唯一拼出,路由只 `new DeleteCommand(jobRowDeleteInput(…))` ──

/**
 * 删作业行的 DeleteItem 输入:主键 + 「每把作业级锁都不存在或最近没人续租」的条件(单一作者 run-lock.noLiveJobLockCondition;
 * 锁属性集合 = home ∪ 该作业绑定的各区 ∪ 行上已有的作业级锁属性)。条件不满足 ⇒ ConditionalCheckFailedException,什么都没删,
 * 路由按在途 409 回(重读作业行即能看到刚抢上的那把锁)。
 */
export function jobRowDeleteInput(table: string, jobId: string, row: Record<string, unknown> | null | undefined, now = Date.now()) {
  return {
    TableName: table,
    Key: { userId: USER_ID, jobId },
    ...noLiveJobLockCondition(row, bindingTargets(row as { targets?: unknown; targetId?: unknown } | null | undefined), now),
  };
}
