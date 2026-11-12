// DMS 复制实例的**持久**回收作业(数据面作业 kind `dms-instance-reclaim`)。
//
// 【为什么要有】复制实例 `bgp-dms` 由第一次「启动」实时同步任务时懒创建(实测 13 分钟),之后常驻按小时计费;
//   「停止」只停复制任务(保留 CDC 检查点,重启走 resume),「删除」才删复制任务 —— 而实例本身从来没人删:
//   所有任务都删掉之后它仍在计费,成本页只会建议「去控制台删」(2026-11-09 用户指南取证时登记的事实)。
// 【做法】与平台自建安全组的清理(`lib/datasource/sg-cleanup-job.ts`)同一套机制:
//   · 入队 = 删任务成功之后(或启动编排失败之后)一次条件写,之后由泵推进;进程被杀不丢;
//   · handler 一步只看**事实**:实例上还有复制任务(含停止态 —— 它们的 CDC 检查点就在那里)⇒ 收口为 `kept-in-use`,一个不碰;
//     有任务正在「启动中」⇒ 等;实例不是 available(creating / modifying / deleting)⇒ 等;
//     零任务 ⇒ 从入队起等一段空闲宽限(删了马上重建的人不必再等 13 分钟)⇒ DeleteReplicationInstance ⇒ 审计;
//   · 预算:入队后超预算仍回收不了 ⇒ 终态 `failed`,原因点名「需人工」,停在系统设置「后台清理任务」里给人看。
// 🔴 不删任何复制任务 / 端点:它们是用户对象;本作业只收口「没有任何任务引用的实例」这一种浪费。
import {
  DeleteReplicationInstanceCommand,
  DescribeReplicationInstancesCommand,
  DescribeReplicationTasksCommand,
} from "@aws-sdk/client-database-migration-service";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { JobHandler, StepContext, StepResult } from "@/lib/dataplane-jobs/handler";
import { createJob, listJobsByTarget } from "@/lib/dataplane-jobs/store";
import { isTerminalPhase, type DataplaneJobRow } from "@/lib/dataplane-jobs/model";
import { dmsClientFor } from "@/lib/exec-env/target-clients";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { writeAuditRecord } from "@/lib/audit";
import { sanitizeAwsErrorMessage } from "@/lib/exec-env/deploy-control";
import { notePlaceDecision } from "@/lib/place/context";

/** 决策记账里的作者名(观测清单按它归类)。 */
export const DMS_RECLAIM_VIA = "dmsInstanceReclaim";
/** 审计动作名 / 主体(系统作业,没有请求上下文)。 */
export const DMS_RECLAIM_AUDIT_ACTION = "realtime.instance.reclaimed";
export const DMS_RECLAIM_ACTOR = "system:dms-instance-reclaim";
/** 零任务之后再等多久才删:删掉最后一条任务又马上重建的人,不必再等 13 分钟重建实例。 */
export const DMS_INSTANCE_IDLE_GRACE_MS = 10 * 60_000;
/** 没到宽限 / 实例还在变更中 / 有任务正在启动时,多久再看一次。 */
export const DMS_RECLAIM_WAIT_MS = 60_000;
/** 从入队算起的总预算:到期仍回收不了 ⇒ 终态失败、点名需人工。 */
export const DMS_RECLAIM_BUDGET_MS = 90 * 60_000;
/** 删任务后入队的理由(进证据,给人看)。 */
export type DmsReclaimReason = "task-deleted" | "start-failed";

const PROGRESS_LABEL = "reclaim-idle-dms-replication-instance";
const PROGRESS_TOTAL = 1;

/** 作业私有 state(入队时写死,handler 只读)。 */
export interface DmsReclaimState {
  region: string;
  instanceId: string;
  reason: DmsReclaimReason;
}
export type DmsReclaimOutcome = "deleted" | "gone" | "kept-in-use" | "needs-manual";

function stateOf(job: Readonly<DataplaneJobRow>): DmsReclaimState | null {
  const s = (job.state ?? {}) as Partial<DmsReclaimState>;
  if (typeof s.region !== "string" || !s.region || typeof s.instanceId !== "string" || !s.instanceId) return null;
  const reason: DmsReclaimReason = s.reason === "start-failed" ? "start-failed" : "task-deleted";
  return { region: s.region, instanceId: s.instanceId, reason };
}

function isNotFound(e: unknown): boolean {
  const n = String((e as { name?: string })?.name ?? "");
  return n === "ResourceNotFoundFault" || n === "ResourceNotFoundException";
}

/** 该目标下是否还有 DMS 任务正在「启动中」(编排随时会把任务挂到实例上 ⇒ 现在不能删)。 */
async function countProvisioningDmsTasks(targetId: string): Promise<number> {
  let n = 0;
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < 20; page++) {
    const r: { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> } = await docClient.send(
      new ScanCommand({
        TableName: TABLES.SYNC_TASKS,
        FilterExpression: "channel = :dms AND #s = :prov AND (attribute_not_exists(targetId) OR targetId = :t)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":dms": "dms", ":prov": "provisioning", ":t": targetId },
        ProjectionExpression: "taskId",
        ExclusiveStartKey: startKey,
      })
    );
    n += r.Items?.length ?? 0;
    startKey = r.LastEvaluatedKey;
    if (!startKey) break;
  }
  return n;
}

export const dmsInstanceReclaimJobHandler: JobHandler = {
  async step(ctx: StepContext): Promise<StepResult> {
    const job = ctx.job;
    const out = (next: StepResult["next"], evidence: Record<string, unknown> = job.evidence ?? {}, done = 0): StepResult => ({
      state: job.state ?? {},
      progress: { done, total: PROGRESS_TOTAL, label: PROGRESS_LABEL },
      evidence,
      next,
    });
    const st = stateOf(job);
    if (!st) return out({ kind: "failed", reason: "回收作业缺 region / instanceId ⇒ 不可恢复(入队方缺字段)" });
    const base = { instanceId: st.instanceId, region: st.region, reason: st.reason };
    const ageMs = ctx.now() - Date.parse(job.createdAt);
    const overBudget = Number.isFinite(ageMs) && ageMs > DMS_RECLAIM_BUDGET_MS;
    const ageMin = Math.round(ageMs / 60_000);
    try {
      notePlaceDecision({ targetId: job.targetId, via: DMS_RECLAIM_VIA });
      const dms = await dmsClientFor(st.region);
      // ① 实例还在吗(DMS 按 filter 查不到是**抛** ResourceNotFoundFault,不是空数组)
      let inst: { ReplicationInstanceArn?: string; ReplicationInstanceStatus?: string; ReplicationInstanceClass?: string } | undefined;
      try {
        const r = await dms.send(new DescribeReplicationInstancesCommand({
          Filters: [{ Name: "replication-instance-id", Values: [st.instanceId] }],
        }));
        inst = r.ReplicationInstances?.[0];
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      if (!inst?.ReplicationInstanceArn) {
        return out({ kind: "succeeded" }, { ...base, outcome: "gone" satisfies DmsReclaimOutcome }, PROGRESS_TOTAL);
      }
      const arn = inst.ReplicationInstanceArn;
      // ② 实例上还有复制任务(含 stopped:CDC 检查点在那里)⇒ 不是浪费,收口为「在用」,一个不碰
      const tasks = await dms.send(new DescribeReplicationTasksCommand({
        WithoutSettings: true,
        Filters: [{ Name: "replication-instance-arn", Values: [arn] }],
      })).then((r) => r.ReplicationTasks ?? []).catch((e) => { if (isNotFound(e)) return []; throw e; });
      //    🔴 「正在删除中」的任务不算在用:DeleteReplicationTask 是异步的,删完后 Describe 还会把它列出来一阵子(status=deleting)。
      //    真环境删任务后 9 秒入队的作业就撞过这一下 —— 把刚删掉的任务数成「仍有 1 条」,实例被判「在用」永远留下。
      const inUse = tasks.filter((t) => String(t.Status ?? "") !== "deleting");
      if (inUse.length > 0) {
        return out(
          { kind: "succeeded" },
          { ...base, tasks: inUse.length, outcome: "kept-in-use" satisfies DmsReclaimOutcome,
            note: `实例上仍有 ${inUse.length} 条复制任务(含停止态,保留 CDC 检查点)⇒ 不回收` },
          PROGRESS_TOTAL
        );
      }
      if (tasks.length > 0) {
        if (overBudget) return out({ kind: "failed", reason: `复制任务 ${ageMin} 分钟仍在删除中 ⇒ 超预算,需人工核对 DMS` }, { ...base, deleting: tasks.length, outcome: "needs-manual" satisfies DmsReclaimOutcome });
        return out({ kind: "wait", delayMs: DMS_RECLAIM_WAIT_MS }, { ...base, tasks: 0, deleting: tasks.length, waitingFor: "task-deleting" });
      }
      // ③ 有任务正在启动中:编排马上会把任务挂上来,现在删了它就撞 ResourceNotFound
      const provisioning = await countProvisioningDmsTasks(job.targetId);
      if (provisioning > 0) {
        if (overBudget) {
          return out({ kind: "failed", reason: `复制实例 ${st.instanceId}(${st.region})入队 ${ageMin} 分钟后仍有 ${provisioning} 条任务停在「启动中」⇒ 需人工:确认这些任务的启动是否已失败` },
            { ...base, provisioning, outcome: "needs-manual" satisfies DmsReclaimOutcome });
        }
        return out({ kind: "wait", delayMs: DMS_RECLAIM_WAIT_MS }, { ...base, provisioning, waitingFor: "provisioning-task" });
      }
      // ④ 实例不是 available(creating / modifying / deleting)⇒ 等它到稳态再说
      const status = String(inst.ReplicationInstanceStatus ?? "unknown");
      if (status !== "available") {
        if (status === "deleting") {
          return out({ kind: "wait", delayMs: DMS_RECLAIM_WAIT_MS }, { ...base, instanceStatus: status, waitingFor: "deleting" });
        }
        if (overBudget) {
          return out({ kind: "failed", reason: `复制实例 ${st.instanceId}(${st.region})入队 ${ageMin} 分钟后仍处于 ${status} ⇒ 需人工:到 DMS 控制台确认实例状态` },
            { ...base, instanceStatus: status, outcome: "needs-manual" satisfies DmsReclaimOutcome });
        }
        return out({ kind: "wait", delayMs: DMS_RECLAIM_WAIT_MS }, { ...base, instanceStatus: status, waitingFor: "instance-available" });
      }
      // ⑤ 零任务但还没过空闲宽限 ⇒ 等(证据里写清预计回收时刻,页面能看见)
      if (Number.isFinite(ageMs) && ageMs < DMS_INSTANCE_IDLE_GRACE_MS) {
        const reclaimAt = new Date(Date.parse(job.createdAt) + DMS_INSTANCE_IDLE_GRACE_MS).toISOString();
        return out(
          { kind: "wait", delayMs: Math.max(1_000, Math.min(DMS_RECLAIM_WAIT_MS, DMS_INSTANCE_IDLE_GRACE_MS - ageMs)) },
          { ...base, tasks: 0, instanceStatus: status, waitingFor: "idle-grace", reclaimAt }
        );
      }
      // ⑥ 删
      try {
        await dms.send(new DeleteReplicationInstanceCommand({ ReplicationInstanceArn: arn }));
      } catch (e) {
        if (isNotFound(e)) return out({ kind: "succeeded" }, { ...base, outcome: "gone" satisfies DmsReclaimOutcome }, PROGRESS_TOTAL);
        // Describe 与 Delete 之间又挂上了任务 / 实例进入变更态 ⇒ 当作还在用,下一轮再看事实
        if (String((e as { name?: string })?.name ?? "") === "InvalidResourceStateFault") {
          return out({ kind: "wait", delayMs: DMS_RECLAIM_WAIT_MS }, { ...base, lastDelete: "invalid-resource-state" });
        }
        throw e;
      }
      const idleMin = Math.round(ageMs / 60_000);
      await writeAuditRecord(
        { actor: DMS_RECLAIM_ACTOR },
        DMS_RECLAIM_AUDIT_ACTION,
        { resourceType: "dms-instance", resourceId: st.instanceId,
          detail: { region: st.region, targetId: job.targetId, instanceClass: inst.ReplicationInstanceClass ?? null, idleMin, reason: st.reason, jobId: job.jobId } }
      ).catch(() => {});
      return out(
        { kind: "succeeded" },
        { ...base, tasks: 0, instanceClass: inst.ReplicationInstanceClass ?? null, idleMin, outcome: "deleted" satisfies DmsReclaimOutcome },
        PROGRESS_TOTAL
      );
    } catch (e) {
      // Describe / Delete 读写失败、AccessDenied、限流:可重试(runner 有界退避,到上限终态失败、停在清单里给人看)
      return out({ kind: "retry", reason: `回收复制实例失败:${sanitizeAwsErrorMessage(String((e as Error)?.message ?? e))}` });
    }
  },
};

export interface DmsReclaimEnqueueResult {
  jobId: string;
  created: boolean;
  phase: string;
}

/**
 * 给一台复制实例登记一条持久回收作业(幂等:同实例已有未终态作业 ⇒ 原样返回;终态了 ⇒ 开新的一条,
 * 因为实例会被下一次「启动」重新建出来、之后又需要回收)。
 */
export async function enqueueDmsInstanceReclaim(args: {
  targetId: string;
  region: string;
  instanceId: string;
  reason: DmsReclaimReason;
  createdBy: string;
  now?: number;
}): Promise<DmsReclaimEnqueueResult> {
  const { targetId, region, instanceId, reason } = args;
  if (!targetId || !region || !instanceId) throw new Error("enqueueDmsInstanceReclaim: targetId / region / instanceId 都必填");
  const now = args.now ?? Date.now();
  const existing = await listJobsByTarget(targetId, { kind: "dms-instance-reclaim", maxItems: 200 });
  const inflight = existing.find((j) => !isTerminalPhase(j.phase) && (j.state as Partial<DmsReclaimState> | undefined)?.instanceId === instanceId);
  if (inflight) return { jobId: inflight.jobId, created: false, phase: inflight.phase };
  const state: DmsReclaimState = { region, instanceId, reason };
  const r = await createJob({
    kind: "dms-instance-reclaim",
    targetId,
    subject: instanceId,
    idempotencyKey: new Date(now).toISOString(),
    createdBy: args.createdBy,
    state: { ...state },
    progress: { done: 0, total: PROGRESS_TOTAL, label: PROGRESS_LABEL },
    now,
  });
  return { jobId: r.job.jobId, created: r.created, phase: r.job.phase };
}
