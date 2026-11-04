// 数据面长作业表的**唯一写通道**(④-1:lease + runToken + revision 的 CAS fencing)。
//
// ── 三个条件写,各挡一类事故 ─────────────────────────────────────────────────────
//   createJob  `attribute_not_exists(jobId)`      —— 确定性 id + 这一条 ⇒ 重复入队只有一条。
//   claimJob   `未终态 ∧ revision = :r ∧ 租约空或已过期` —— 两个泵 / 两个副本同时抢,只有一个 revision++ 成功。
//   commitJob  `runToken = :rt ∧ revision = :rev` —— 🔴 **僵尸写不回**:租约过期后被别人抢走的旧持有者,
//              哪怕它的语句执行完了、带着「我做完了」回来,也写不进任何东西(runToken 已换、revision 已涨)。
// 🔴 这三条之外**不许**再有写这张表的地方(新增写点 = 绕过 fencing)。`dataplane-jobs-assembly.test.ts`
//    里有一条判据扫本目录之外的 `DATAPLANE_JOBS` 写命令。
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient } from "@/lib/aws/dynamodb";
import { DATAPLANE_JOBS_TABLE, DUE_SHARD, GSI_BY_TARGET, TERMINAL_PHASES, type JobKind, type JobPhase } from "@/lib/dataplane-jobs/schema";
import {
  JOB_LEASE_MS,
  dataplaneJobId,
  isDataplaneJobId,
  type DataplaneJobRow,
  type JobProgress,
} from "@/lib/dataplane-jobs/model";

function isCcf(e: unknown): boolean {
  return (e as { name?: string })?.name === "ConditionalCheckFailedException";
}

/** 写回被拒:本持有者的租约已被别人接手(runToken / revision 已变)。调用方必须**立即停手**,不许再产生副作用。 */
export class StaleJobFence extends Error {
  constructor(readonly jobId: string) {
    super(`作业 ${jobId} 的写回被拒:租约已被另一个推进者接手(runToken / revision 已变)—— 本次结果作废,不得重试写回`);
    this.name = "StaleJobFence";
  }
}

export interface CreateJobInput {
  kind: JobKind;
  targetId: string;
  projectId?: string;
  /** 参与 jobId 计算的主体(projectId 或 fqn) */
  subject: string;
  idempotencyKey: string;
  createdBy: string;
  state: Record<string, unknown>;
  progress: JobProgress;
  now: number;
  /** 只给可再生的证据类作业设(epoch 秒) */
  ttlEpochSeconds?: number;
}

/**
 * 入队。同一件事(同 kind / target / subject / 幂等键)只会有一条:已存在就把那一条读回来。
 * @returns created=false ⇒ 返回的是**已有的**那一条(调用方据此回「已在队列中」,不是新建)
 */
export async function createJob(input: CreateJobInput): Promise<{ created: boolean; job: DataplaneJobRow }> {
  const jobId = dataplaneJobId(input.kind, input.targetId, input.subject, input.idempotencyKey);
  const at = new Date(input.now).toISOString();
  const row: DataplaneJobRow = {
    jobId,
    kind: input.kind,
    targetId: input.targetId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    idempotencyKey: input.idempotencyKey,
    phase: "queued",
    state: input.state,
    progress: input.progress,
    evidence: {},
    attempts: 0,
    revision: 0,
    dueShard: DUE_SHARD,
    nextRunAt: input.now,
    createdAt: at,
    updatedAt: at,
    createdBy: input.createdBy,
    ...(input.ttlEpochSeconds ? { ttl: input.ttlEpochSeconds } : {}),
  };
  try {
    await docClient.send(
      new PutCommand({
        TableName: DATAPLANE_JOBS_TABLE(),
        Item: row,
        ConditionExpression: "attribute_not_exists(jobId)",
      })
    );
    return { created: true, job: row };
  } catch (e) {
    if (!isCcf(e)) throw e;
    const existing = await getJob(jobId);
    if (!existing) {
      // 条件写说「已存在」而强一致读说「不存在」:只能是刚被删(本表不删)或表不一致 —— 不许当成功
      throw new Error(`作业 ${jobId} 入队冲突却读不到已有行 ⇒ 拒绝当成功`);
    }
    return { created: false, job: existing };
  }
}

/** 强一致读一条作业(抢占前的前态必须是新鲜的)。 */
export async function getJob(jobId: string): Promise<DataplaneJobRow | null> {
  if (!isDataplaneJobId(jobId)) return null;
  const r = await docClient.send(
    new GetCommand({ TableName: DATAPLANE_JOBS_TABLE(), Key: { jobId }, ConsistentRead: true })
  );
  return (r.Item as DataplaneJobRow | undefined) ?? null;
}

/** 持有者凭证:写回必须原样带回。🔴 只在服务端内存里流转,永不进响应。 */
export interface JobFence {
  jobId: string;
  runToken: string;
  revision: number;
}

export type ClaimResult =
  | { kind: "claimed"; job: DataplaneJobRow; fence: JobFence }
  | { kind: "missing" }
  | { kind: "terminal"; job: DataplaneJobRow }
  | { kind: "busy" }
  | { kind: "not-due"; job: DataplaneJobRow };

/**
 * 抢占一条作业(④-1:抢占 = `lease 过期 ∧ revision = :r`)。
 *
 * 🔴 `respectSchedule`:泵来推进时必须到期才抢(`nextRunAt <= now`);页面「立即推进」可以跳过等待
 *    (人明确要求现在就看一眼),但**租约与 revision 条件一条不少** —— 跳过的只是退避,不是互斥。
 */
export async function claimJob(
  jobId: string,
  now: number,
  opts: { respectSchedule: boolean }
): Promise<ClaimResult> {
  const job = await getJob(jobId);
  if (!job) return { kind: "missing" };
  if (TERMINAL_PHASES.has(job.phase)) return { kind: "terminal", job };
  if (job.lease && job.lease.expiresAt >= now) return { kind: "busy" };
  if (opts.respectSchedule && job.nextRunAt > now) return { kind: "not-due", job };

  const runToken = ulid();
  const revision = job.revision + 1;
  const lease = { token: runToken, expiresAt: now + JOB_LEASE_MS };
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: DATAPLANE_JOBS_TABLE(),
        Key: { jobId },
        UpdateExpression: "SET #lease = :lease, #rt = :rt, #rev = :next, #ph = :running, #nra = :nra, #ua = :ua",
        ConditionExpression:
          "attribute_exists(#due) AND #rev = :r AND (attribute_not_exists(#lease) OR #lease.#exp < :now)",
        ExpressionAttributeNames: {
          "#lease": "lease",
          "#exp": "expiresAt",
          "#rt": "runToken",
          "#rev": "revision",
          "#ph": "phase",
          "#nra": "nextRunAt",
          "#ua": "updatedAt",
          "#due": "dueShard",
        },
        ExpressionAttributeValues: {
          ":lease": lease,
          ":rt": runToken,
          ":next": revision,
          ":r": job.revision,
          ":running": "running",
          // 🔴 持有期间把到期时间推到租约之后:泵不会反复取到它;持有者猝死 ⇒ 租约一过它自动重新到期
          ":nra": lease.expiresAt,
          ":ua": new Date(now).toISOString(),
          ":now": now,
        },
      })
    );
  } catch (e) {
    if (isCcf(e)) return { kind: "busy" };
    throw e;
  }
  return {
    kind: "claimed",
    job: { ...job, runToken, revision, lease, phase: "running", nextRunAt: lease.expiresAt },
    fence: { jobId, runToken, revision },
  };
}

export interface JobPatch {
  phase: JobPhase;
  state: Record<string, unknown>;
  progress: JobProgress;
  evidence: Record<string, unknown>;
  /** null = 清掉 */
  lastError: string | null;
  attempts: number;
  /** 下次可推进时间;终态时忽略 */
  nextRunAt: number;
}

/**
 * 写回(带 fence)。成功即 revision++ 并返回新 fence。
 *  · `release=false`:中途存档 + **续租**(长步骤每推进一小步就存一次 —— 猝死时最多重做一小步);
 *  · `release=true` :本轮结束,交还租约;终态时同时摘掉稀疏 GSI 分区键。
 * 🔴 条件不成立 ⇒ 抛 `StaleJobFence`,调用方必须立刻停手。
 */
export async function commitJob(
  fence: JobFence,
  patch: JobPatch,
  opts: { release: boolean; now: number }
): Promise<JobFence> {
  const terminal = TERMINAL_PHASES.has(patch.phase);
  const names: Record<string, string> = {
    "#rt": "runToken",
    "#rev": "revision",
    "#ph": "phase",
    "#st": "state",
    "#pg": "progress",
    "#ev": "evidence",
    "#at": "attempts",
    "#ua": "updatedAt",
    "#lease": "lease",
  };
  const values: Record<string, unknown> = {
    ":rt": fence.runToken,
    ":rev": fence.revision,
    ":next": fence.revision + 1,
    ":ph": patch.phase,
    ":st": patch.state,
    ":pg": patch.progress,
    ":ev": patch.evidence,
    ":at": patch.attempts,
    ":ua": new Date(opts.now).toISOString(),
  };
  const sets = ["#rev = :next", "#ph = :ph", "#st = :st", "#pg = :pg", "#ev = :ev", "#at = :at", "#ua = :ua"];
  const removes: string[] = [];
  if (patch.lastError === null) {
    names["#le"] = "lastError";
    removes.push("#le");
  } else {
    names["#le"] = "lastError";
    values[":le"] = patch.lastError;
    sets.push("#le = :le");
  }
  if (opts.release) {
    removes.push("#lease");
  } else {
    // 续租:还在干活,别让别人以为我死了
    values[":lease"] = { token: fence.runToken, expiresAt: opts.now + JOB_LEASE_MS };
    sets.push("#lease = :lease");
  }
  names["#nra"] = "nextRunAt";
  if (terminal) {
    names["#due"] = "dueShard";
    removes.push("#due");
    values[":nra"] = 0;
  } else {
    values[":nra"] = opts.release ? patch.nextRunAt : opts.now + JOB_LEASE_MS;
  }
  sets.push("#nra = :nra");
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: DATAPLANE_JOBS_TABLE(),
        Key: { jobId: fence.jobId },
        UpdateExpression: `SET ${sets.join(", ")}${removes.length ? ` REMOVE ${removes.join(", ")}` : ""}`,
        ConditionExpression: "#rt = :rt AND #rev = :rev",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
  } catch (e) {
    if (isCcf(e)) throw new StaleJobFence(fence.jobId);
    throw e;
  }
  return { ...fence, revision: fence.revision + 1 };
}

/**
 * 某个执行环境下的作业(新的在前)。🔴 必须翻页:单页返回 = 静默漏作业,
 * 而漏掉的恰好可能是「最新那次 canary」⇒ 前置判据读到旧结果。
 */
export async function listJobsByTarget(
  targetId: string,
  opts: { kind?: JobKind; maxItems?: number } = {}
): Promise<DataplaneJobRow[]> {
  const out: DataplaneJobRow[] = [];
  const cap = Math.max(1, Math.min(opts.maxItems ?? 500, 5000));
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < 100 && out.length < cap; page++) {
    const r: { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> } = await docClient.send(
      new QueryCommand({
        TableName: DATAPLANE_JOBS_TABLE(),
        IndexName: GSI_BY_TARGET,
        KeyConditionExpression: "#t = :t",
        ExpressionAttributeNames: { "#t": "targetId", ...(opts.kind ? { "#k": "kind" } : {}) },
        ExpressionAttributeValues: { ":t": targetId, ...(opts.kind ? { ":k": opts.kind } : {}) },
        ...(opts.kind ? { FilterExpression: "#k = :k" } : {}),
        ScanIndexForward: false,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      })
    );
    for (const it of r.Items ?? []) out.push(it as unknown as DataplaneJobRow);
    startKey = r.LastEvaluatedKey;
    if (!startKey) break;
  }
  return out.slice(0, cap);
}

/**
 * 该执行环境上**未终态**的作业数(删除预检要读它:有在途作业的环境不许直接删)。
 * 🔴 数不清就抛,不回 0 —— 「数不清」当成「没有」就是放行删除。
 */
export async function countActiveJobs(targetId: string): Promise<number> {
  let n = 0;
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < 100; page++) {
    const r: { Count?: number; LastEvaluatedKey?: Record<string, unknown> } = await docClient.send(
      new QueryCommand({
        TableName: DATAPLANE_JOBS_TABLE(),
        IndexName: GSI_BY_TARGET,
        KeyConditionExpression: "#t = :t",
        FilterExpression: "attribute_exists(#due)",
        ExpressionAttributeNames: { "#t": "targetId", "#due": "dueShard" },
        ExpressionAttributeValues: { ":t": targetId },
        Select: "COUNT",
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      })
    );
    n += r.Count ?? 0;
    startKey = r.LastEvaluatedKey;
    if (!startKey) return n;
  }
  throw new Error(`countActiveJobs(${targetId}):翻页超过上限仍未到表尾 ⇒ 数不清,拒绝回一个可能偏小的数`);
}
