// serverless 调度跑出来的 run 的任务日志(INTERACTION §2.2b / ACCEPTANCE):
//   台账 run 行(runtime 写,runId = Airflow dag_run.run_id)→ 该 target 的 workflow(台账 deployments[targetId].workflowArn)
//   → ListWorkflowRuns 里按**时间窗**对到服务侧 RunId(服务把 dag_id 重写成 ex_<uuid>,run_id 与服务 RunId 不同名,spike 坐实)
//   → ListTaskInstances 取 run_job 那条 → GetTaskInstance.LogStream → CloudWatch /aws/mwaa-serverless/<workflow 全名>/。
// 纯函数(regionOfWorkflowArn / pickRunForLedger / logGroupOf)单测钉;网络部分薄封装。
import { GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { logsClientFor } from "@/lib/exec-env/target-clients";
import { getTaskInstance, getWorkflowRun, listTaskInstances, listWorkflowRuns, workflowNameOf } from "./workflow-client";
// 台账 runId 的口径唯一作者(raw 段 = 服务侧 per-run dag_id)
import { rawRunIdOf } from "@/lib/monitor/run-key";
// ARN 切段 + 形态校验的唯一作者;文案留在本文件
import { regionOfArn } from "@/lib/aws/arn";

/** `arn:aws:airflow-serverless:<region>:<acct>:workflow/<name>-<suffix>` → region(第 4 段)。 */
export function regionOfWorkflowArn(arn: string): string {
  const region = regionOfArn(arn);
  if (!region) throw new Error(`workflowArn 里读不到 region:${arn}`);
  return region;
}

/** 服务的日志组命名(get-workflow 的 LoggingConfiguration.LogGroupName 实测形状,带尾斜杠)。 */
export function logGroupOf(workflowArn: string): string {
  return `/aws/mwaa-serverless/${workflowNameOf(workflowArn)}/`;
}

export interface RunSummaryLike {
  RunId?: string;
  RunDetailSummary?: { Status?: string; CreatedOn?: string | Date; StartedAt?: string | Date; EndedAt?: string | Date };
}

const ms = (v: string | Date | undefined): number | undefined => {
  if (v === undefined || v === null) return undefined;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : undefined;
};

/**
 * 台账 run 行 → 服务侧 RunId:取「窗口 [StartedAt − tol, EndedAt + tol] 含台账 finishedAt(缺则 startedAt)」的 run;多个命中取结束时间最近的。
 * 🔴 纯函数:台账时间 = runtime 在任务体内 _record 的时刻(≈ 任务结束),必落在该次 run 的窗口内;不同 run 因作业锁串行不重叠。
 */
export function pickRunForLedger(runs: RunSummaryLike[], ledger: { startedAt?: string; finishedAt?: string }, toleranceMs = 120_000): string | undefined {
  const t = ms(ledger.finishedAt) ?? ms(ledger.startedAt);
  if (t === undefined) return undefined;
  let best: { id: string; dist: number } | undefined;
  for (const r of runs) {
    const s = r.RunDetailSummary ?? {};
    const start = ms(s.StartedAt) ?? ms(s.CreatedOn);
    if (start === undefined || !r.RunId) continue;
    const end = ms(s.EndedAt) ?? Number.POSITIVE_INFINITY;
    if (t < start - toleranceMs || t > end + toleranceMs) continue;
    const dist = Number.isFinite(end) ? Math.abs(end - t) : Math.abs(t - start);
    if (!best || dist < best.dist) best = { id: r.RunId, dist };
  }
  return best?.id;
}

/**
 * 台账行 → 服务侧 RunId 的**精确**对法(不是时间窗猜)。
 *
 * 🔴 为什么能精确:台账 runId 的 raw 段就是**服务侧 per-run dag_id**(`ex_<uuid>`),
 * 而任务实例 id 实测形如 `<ex_uuid>_<task_id>_<attempt>` ⇒ 前缀一比就知道这个 run 是不是那一次。
 * 时间窗(`pickRunForLedger`)只作**兜底**:一次手动 + 一次 cron 落在同 2 分钟里时,窗口法会对错;
 * 而此前写下的存量台账行没有 `ex_` 段,只能靠窗口。
 * 探测按「时间上最近」排序,默认只探前 4 个(每探一次 = 一次 ListTaskInstances)。
 */
export function taskInstanceBelongsToRun(taskInstanceId: string, rawRunId: string): boolean {
  return !!rawRunId && String(taskInstanceId ?? "").startsWith(rawRunId + "_");
}

/** 按「与台账时间的距离」升序排 run(纯函数,单测钉)。 */
export function runsByProximity(runs: RunSummaryLike[], ledger: { startedAt?: string; finishedAt?: string }): string[] {
  const t = ms(ledger.finishedAt) ?? ms(ledger.startedAt);
  const scored: Array<{ id: string; dist: number }> = [];
  for (const r of runs) {
    if (!r.RunId) continue;
    const sd = r.RunDetailSummary ?? {};
    const start = ms(sd.StartedAt) ?? ms(sd.CreatedOn);
    const end = ms(sd.EndedAt);
    const ref = end ?? start;
    const dist = t === undefined || ref === undefined ? Number.MAX_SAFE_INTEGER : Math.abs(ref - t);
    scored.push({ id: r.RunId, dist });
  }
  return scored.sort((a, b) => a.dist - b.dist).map((x) => x.id);
}

export interface ResolvedServiceRun {
  runId?: string;
  /** 怎么对上的:`exact` = 任务实例前缀命中;`time-window` = 兜底;`none` = 对不上 */
  how: "exact" | "time-window" | "none";
}

export async function resolveServiceRunId(args: {
  region: string;
  workflowArn: string;
  ledger: { runId: string; startedAt?: string; finishedAt?: string };
  runs?: RunSummaryLike[];
  maxProbe?: number;
}): Promise<ResolvedServiceRun> {
  const runs = args.runs ?? ((await listWorkflowRuns(args.region, args.workflowArn)) as RunSummaryLike[]);
  const raw = rawRunIdOf(args.ledger.runId);
  if (raw && raw !== args.ledger.runId) {
    const ordered = runsByProximity(runs, args.ledger).slice(0, args.maxProbe ?? 4);
    for (const runId of ordered) {
      try {
        const tis = await listTaskInstances(args.region, args.workflowArn, runId);
        if ((tis.TaskInstances ?? []).some((x) => taskInstanceBelongsToRun(String(x.TaskInstanceId ?? ""), raw))) {
          return { runId, how: "exact" };
        }
      } catch {
        /* 探不动就换下一个候选 */
      }
    }
  }
  const fallback = pickRunForLedger(runs, args.ledger);
  return fallback ? { runId: fallback, how: "time-window" } : { how: "none" };
}

/** 服务侧任务状态 → 界面用的小写词表(🔴 `NONE` 实测 = **被 skip**,原样显示 none 会误导)。 */
export function mapTaskState(status: string | undefined): string {
  const v = String(status ?? "").toUpperCase();
  if (!v) return "no_status";
  if (v === "NONE") return "skipped";
  return v.toLowerCase();
}

export interface ServerlessNodeState {
  taskId: string;
  state: string;
  startDate: string | null;
  endDate: string | null;
  tryNumber: number;
  duration: number | null;
}

/**
 * 一次 run 的逐节点状态。
 * 🔴 只认 `GetTaskInstance`:`ListTaskInstances` **不返回 TaskId**(而 task_id 里可能带 `_`,
 * 按分隔符切 id 是错的),且旧尝试会停在非终态。
 * 🔴 被 skip 连带的下游**根本不出现**在列表里(实测)⇒ 返回的节点数**可以少于**图里的节点数,
 * 界面把缺的当 `no_status`(与经典同款),这不是 bug。
 */
export async function listServerlessNodeStates(args: {
  workflowArn: string;
  ledger: { runId: string; startedAt?: string; finishedAt?: string };
}): Promise<{ runId?: string; how: string; runType?: string; nodes: ServerlessNodeState[] }> {
  const region = regionOfWorkflowArn(args.workflowArn);
  const resolved = await resolveServiceRunId({ region, workflowArn: args.workflowArn, ledger: args.ledger });
  if (!resolved.runId) return { how: resolved.how, nodes: [] };
  let runType: string | undefined;
  try {
    runType = (await getWorkflowRun(region, args.workflowArn, resolved.runId)).RunType;
  } catch {
    runType = undefined; // 拿不到就不显示,绝不猜
  }
  const tis = await listTaskInstances(region, args.workflowArn, resolved.runId);
  const nodes: ServerlessNodeState[] = [];
  for (const ti of tis.TaskInstances ?? []) {
    if (!ti.TaskInstanceId) continue;
    try {
      const d = await getTaskInstance(region, args.workflowArn, resolved.runId, ti.TaskInstanceId);
      if (!d.TaskId) continue;
      nodes.push({
        taskId: d.TaskId,
        state: mapTaskState(d.Status),
        startDate: d.StartedAt ? new Date(d.StartedAt).toISOString() : null,
        endDate: d.EndedAt ? new Date(d.EndedAt).toISOString() : null,
        tryNumber: Number(d.AttemptNumber ?? 1) || 1,
        duration: d.DurationInSeconds ?? null,
      });
    } catch {
      /* 单个实例读不到就跳过它(不把整页打空) */
    }
  }
  // 同一 task 多次尝试 ⇒ 只留 AttemptNumber 最大的那条(旧尝试会停在非终态,留着会显示成「还在跑」)
  const best = new Map<string, ServerlessNodeState>();
  for (const n of nodes) {
    const prev = best.get(n.taskId);
    if (!prev || n.tryNumber >= prev.tryNumber) best.set(n.taskId, n);
  }
  return { runId: resolved.runId, how: resolved.how, runType, nodes: Array.from(best.values()) };
}

/** 一次 run 在**服务侧**的状态(reconcile-on-read 的真值源;台账只说「这次 run 开始了」)。 */
export async function readServerlessRunState(args: {
  workflowArn: string;
  ledger: { runId: string; startedAt?: string; finishedAt?: string };
}): Promise<{ runId?: string; how: string; state?: string; runType?: string; startedAt?: string; endedAt?: string }> {
  const region = regionOfWorkflowArn(args.workflowArn);
  const runs = (await listWorkflowRuns(region, args.workflowArn)) as RunSummaryLike[];
  const resolved = await resolveServiceRunId({ region, workflowArn: args.workflowArn, ledger: args.ledger, runs });
  if (!resolved.runId) return { how: resolved.how };
  const r = await getWorkflowRun(region, args.workflowArn, resolved.runId);
  const detail = (r as { RunDetail?: { RunState?: string; StartedOn?: string | Date; EndedAt?: string | Date } }).RunDetail ?? {};
  return {
    runId: resolved.runId,
    how: resolved.how,
    state: detail.RunState,
    runType: r.RunType,
    startedAt: detail.StartedOn ? new Date(detail.StartedOn).toISOString() : undefined,
    endedAt: detail.EndedAt ? new Date(detail.EndedAt).toISOString() : undefined,
  };
}

export interface ServerlessTaskLogs {
  logGroup: string;
  logStream?: string;
  workflowRunId?: string;
  taskStatus?: string;
  logs: string[];
  /** 服务侧 RunType(SCHEDULED / ON_DEMAND)—— **唯一真值源**。
   *  worker 侧分不出 cron 与手动(实测 run_id 同为常量、run_type 同为 DagRunType.SCHEDULED、conf 空、
   *  OverrideParameters 不进环境变量)⇒ 运行时不再往台账写 runType,改由这里按需向服务问。 */
  runType?: string;
}

/** 读 serverless run 的任务日志;找不到对应 run / 流时 logs 给出人话(不是空白)。 */
export async function readServerlessTaskLogs(args: {
  workflowArn: string;
  ledger: { runId: string; startedAt?: string; finishedAt?: string };
  limit?: number;
  /**
   * 要看哪个 task 的日志。单作业只有一个 task(`run_job`,缺省);多节点编排要指定节点的 task_id。
   */
  taskId?: string;
}): Promise<ServerlessTaskLogs> {
  const region = regionOfWorkflowArn(args.workflowArn);
  const logGroup = logGroupOf(args.workflowArn);
  const runs = (await listWorkflowRuns(region, args.workflowArn)) as RunSummaryLike[];
  // 先用**精确**对法(任务实例前缀 = 台账 runId 的 raw 段),
  //   对不上再退回时间窗(存量此前的行只能靠窗口)。
  const resolved = await resolveServiceRunId({ region, workflowArn: args.workflowArn, ledger: args.ledger, runs });
  const runId = resolved.runId;
  if (!runId) return { logGroup, logs: [`(在 workflow 最近 ${runs.length} 次运行里没有与该台账行匹配的 run;可在 CloudWatch ${logGroup} 按时间查看)`] };
  // 🔴 订正:触发来源要在**任何**返回路径上都带着 —— 原来它取在任务实例之后,
  //   于是「该 run 尚无任务实例」这条早返回不带 runType,页面上既没日志也不知道这次是定时还是手动。
  let runType: string | undefined;
  try {
    runType = (await getWorkflowRun(region, args.workflowArn, runId)).RunType;
  } catch {
    runType = undefined; // 拿不到就不显示,绝不猜
  }
  const tis = await listTaskInstances(region, args.workflowArn, runId);
  // 列表项没有 TaskId;实例 id 形如 ex_<uuid>_<task_id>_<attempt>(spike 实测)⇒ 按尾缀匹配我们唯一的任务 run_job
  const want = args.taskId || "run_job";
  const re = new RegExp(`_${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_(\\d+)$`);
  // 同一 task 多次尝试 ⇒ 取 AttemptNumber 最大的那条(旧尝试会停在非终态)
  const matched = (tis.TaskInstances ?? [])
    .filter((x) => re.test(String(x.TaskInstanceId ?? "")))
    .sort((a, b) => Number(re.exec(String(b.TaskInstanceId))?.[1] ?? 0) - Number(re.exec(String(a.TaskInstanceId))?.[1] ?? 0));
  const ti = matched[0] ?? (args.taskId ? undefined : (tis.TaskInstances ?? [])[0]);
  if (!ti?.TaskInstanceId) return { logGroup, workflowRunId: runId, runType, logs: ["(该 run 尚无任务实例;稍后再试)"] };
  const detail = await getTaskInstance(region, args.workflowArn, runId, ti.TaskInstanceId);
  const logStream = detail.LogStream;
  if (!logStream) return { logGroup, workflowRunId: runId, runType, taskStatus: detail.Status, logs: ["(任务实例尚未产生日志流;稍后再试)"] };
  const cwl = await logsClientFor(region);
  const out = await cwl.send(new GetLogEventsCommand({ logGroupName: logGroup, logStreamName: logStream, limit: args.limit ?? 500, startFromHead: true }));
  const logs = (out.events ?? []).map((e) => e.message ?? "").filter(Boolean);
  return { logGroup, logStream, workflowRunId: runId, runType, taskStatus: detail.Status, logs: logs.length ? logs : ["(日志流为空)"] };
}
