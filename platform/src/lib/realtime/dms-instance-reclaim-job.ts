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
// 【端点】删任务只撤复制任务:端点被复制任务引用时删不掉,而删复制任务是异步的(「删除中」会持续一阵)⇒ 不在删除请求里等。
//   本作业每一步先清扫该区的**孤儿端点** —— 标识是平台的形态(`bgp-src-` / `bgp-tgt-` + 任务短名)、任务表里已经没有
//   对应的任务行、也没有任何复制任务引用它 ⇒ 删;还被「删除中」的复制任务引用 ⇒ 下一步再看。停止态任务的端点留着
//   (任务行还在,重启要用);以前留下的孤儿端点在该区下一次回收时一并清掉。清扫结果进作业证据与审计。
// 🔴 不删任何复制任务:它们是用户对象。端点只删「任务行已经没了」的那一种;实例只收口「没有任何任务引用」这一种浪费。
// 🔴 每个区各有一台实例、各自一条作业:数「启动中的任务」按任务**绑定的区**算,别的区的启动不挡这个区的回收。
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
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
import { resolveDmsSiteOfTarget, type DmsSite } from "@/lib/realtime/dms-place";
import { deletePlatformEndpoint, dmsTaskShortOf, listPlatformEndpoints } from "@/lib/realtime/dms-service";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { writeAuditRecord } from "@/lib/audit";
import { sanitizeAwsErrorMessage } from "@/lib/exec-env/deploy-control";
import { notePlaceDecision } from "@/lib/place/context";

/** 决策记账里的作者名(观测清单按它归类)。 */
export const DMS_RECLAIM_VIA = "dmsInstanceReclaim";
/** 审计动作名 / 主体(系统作业,没有请求上下文)。 */
export const DMS_RECLAIM_AUDIT_ACTION = "realtime.instance.reclaimed";
/** 清掉孤儿端点的审计动作名。 */
export const DMS_ENDPOINT_SWEEP_AUDIT_ACTION = "realtime.endpoints.swept";
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

/** 任务表里与回收有关的两件事实(一次扫表得出)。 */
interface SyncTaskFacts {
  /** 全部任务行的 DMS 短名(端点标识里的那一段):端点的短名在这里面 ⇒ 它的任务行还在 */
  liveShorts: Set<string>;
  /** 绑定在本区、正在「启动中」的 DMS 任务数(编排随时会把任务挂到实例上 ⇒ 现在不能删实例) */
  provisioningHere: number;
}

/**
 * 扫一遍同步任务表。🔴 必须扫完才下结论:扫不完(翻页上限 / 读失败)就抛 —— 「没读到这条任务」不等于「这条任务不存在」,
 *   按不完整的清单去删端点会把还在用的端点删掉。
 * 「在不在本区」按任务绑定判(`bindingTargets`:`targets[]` → 存量 `targetId` → 都没有 = 主控区),不在查询条件里另写一份规则
 *   (2026-11 之前的条件只认顶层 `targetId`,而新任务只写 `targets[]` ⇒ 每个区都把所有启动中的任务算成自己的)。
 */
async function readSyncTaskFacts(targetId: string): Promise<SyncTaskFacts> {
  const liveShorts = new Set<string>();
  let provisioningHere = 0;
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; ; page++) {
    if (page >= 500) throw new Error("同步任务表超过 500 页仍未扫完 ⇒ 拒绝按不完整的清单下结论");
    const r: { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> } = await docClient.send(
      new ScanCommand({
        TableName: TABLES.SYNC_TASKS,
        ProjectionExpression: "taskId, channel, #s, targets, targetId",
        ExpressionAttributeNames: { "#s": "status" },
        ExclusiveStartKey: startKey,
      })
    );
    for (const row of r.Items ?? []) {
      const taskId = typeof row.taskId === "string" ? row.taskId : "";
      if (taskId) liveShorts.add(dmsTaskShortOf(taskId));
      if (row.channel === "dms" && row.status === "provisioning"
        && bindingTargets(row as { targets?: unknown; targetId?: unknown }).includes(targetId)) provisioningHere++;
    }
    startKey = r.LastEvaluatedKey;
    if (!startKey) break;
  }
  return { liveShorts, provisioningHere };
}

type DmsClient = Awaited<ReturnType<typeof dmsClientFor>>;

/** 作业证据里由清扫那一步写的键(每步重写)。 */
const SWEEP_EVIDENCE_KEYS = ["endpointsDeleted", "endpointsPending", "endpointsBlocked", "endpointSweepError"] as const;
function withoutSweepKeys(evidence: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...evidence };
  for (const k of SWEEP_EVIDENCE_KEYS) delete rest[k];
  return rest;
}

/** 一步清扫的结果(都是端点标识)。 */
interface EndpointSweep {
  /** 本步删掉的(含「去删时已经没了」的) */
  deleted: string[];
  /** 还被「删除中」的复制任务引用,或 DMS 说仍在用 ⇒ 下一步再看 */
  pending: string[];
  /** 任务行没了,却还被一条没在删除的复制任务引用(那条复制任务本身是残留,本作业不删复制任务)⇒ 只报告 */
  blocked: string[];
}

/**
 * 清扫该区的孤儿端点。🔴 顺序是承重的:**先**列端点、**后**读任务表 —— 任务行总是先于它的端点存在,
 *   所以列表里的每个端点,要么读表时它的任务行在(保留),要么任务行确实已经删了(可清)。反过来读,刚建任务、
 *   刚建端点的那一瞬会被看成「端点在、行不在」。
 */
async function sweepOrphanEndpoints(site: DmsSite, dms: DmsClient, targetId: string): Promise<{ sweep: EndpointSweep; facts: SyncTaskFacts; deleteError?: unknown }> {
  const endpoints = await listPlatformEndpoints(site);
  const facts = await readSyncTaskFacts(targetId);
  const sweep: EndpointSweep = { deleted: [], pending: [], blocked: [] };
  const orphans = endpoints.filter((e) => !facts.liveShorts.has(e.taskShort));
  if (orphans.length === 0) return { sweep, facts };
  // 该区全部复制任务引用了哪些端点(含「删除中」的:它们删完之前端点删不掉)
  const refs = new Map<string, string[]>();
  let marker: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= 50) throw new Error(`DMS 复制任务清单超过 50 页仍未列完(${site.region})⇒ 拒绝按不完整的清单下结论`);
    const r = await dms.send(new DescribeReplicationTasksCommand({ WithoutSettings: true, Marker: marker, MaxRecords: 100 }))
      .catch((e) => { if (isNotFound(e)) return { ReplicationTasks: [], Marker: undefined }; throw e; });
    for (const t of r.ReplicationTasks ?? []) {
      for (const arn of [t.SourceEndpointArn, t.TargetEndpointArn]) {
        if (!arn) continue;
        refs.set(arn, [...(refs.get(arn) ?? []), String(t.Status ?? "")]);
      }
    }
    marker = r.Marker;
    if (!marker) break;
  }
  for (const e of orphans) {
    const statuses = refs.get(e.arn) ?? [];
    if (statuses.some((st) => st !== "deleting")) { sweep.blocked.push(e.id); continue; }
    if (statuses.length > 0) { sweep.pending.push(e.id); continue; }
    let r: Awaited<ReturnType<typeof deletePlatformEndpoint>>;
    try {
      r = await deletePlatformEndpoint(site, e.arn);
    } catch (err) {
      // 删到一半出错(限流 / 没权限):已经删掉的照样记账与审计,剩下的下一步再清
      return { sweep, facts, deleteError: err };
    }
    if (r === "in-use") sweep.pending.push(e.id);
    else sweep.deleted.push(e.id);
  }
  return { sweep, facts };
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
    const parsed = stateOf(job);
    if (!parsed) return out({ kind: "failed", reason: "回收作业缺 region / instanceId ⇒ 不可恢复(入队方缺字段)" });
    const st: DmsReclaimState = parsed;
    const base = { instanceId: st.instanceId, region: st.region, reason: st.reason };
    const ageMs = ctx.now() - Date.parse(job.createdAt);
    const overBudget = Number.isFinite(ageMs) && ageMs > DMS_RECLAIM_BUDGET_MS;
    const ageMin = Math.round(ageMs / 60_000);
    const prior = (job.evidence ?? {}) as Record<string, unknown>;
    const priorDeleted = Array.isArray(prior.endpointsDeleted) ? (prior.endpointsDeleted as unknown[]).map(String) : [];
    try {
      notePlaceDecision({ targetId: job.targetId, via: DMS_RECLAIM_VIA });
      // 落点与启动 / 下线同一个解析;入队时写下的区与实例名必须与它一致(不一致 = 入队方给错了,绝不拿着错的名字去删)
      const site = await resolveDmsSiteOfTarget(job.targetId);
      if (site.region !== st.region || site.instanceId !== st.instanceId) {
        return out({ kind: "failed", reason: `回收作业记的落点(${st.instanceId} · ${st.region})与执行环境 ${job.targetId} 的落点(${site.instanceId} · ${site.region})不一致 ⇒ 不可恢复` });
      }
      const dms = await dmsClientFor(site.region);
      // ⓪ 先清扫孤儿端点(与实例那一侧的结论互不相挡:清扫出错只记下来、下一步再试,实例照常按事实回收)
      let sweep: EndpointSweep = { deleted: [], pending: [], blocked: [] };
      let sweepError: string | undefined;
      let facts: SyncTaskFacts | undefined;
      try {
        const r = await sweepOrphanEndpoints(site, dms, job.targetId);
        sweep = r.sweep;
        facts = r.facts;
        if (r.deleteError) sweepError = sanitizeAwsErrorMessage(String((r.deleteError as Error)?.message ?? r.deleteError)).slice(0, 240);
      } catch (e) {
        sweepError = sanitizeAwsErrorMessage(String((e as Error)?.message ?? e)).slice(0, 240);
      }
      if (sweep.deleted.length > 0) {
        await writeAuditRecord(
          { actor: DMS_RECLAIM_ACTOR },
          DMS_ENDPOINT_SWEEP_AUDIT_ACTION,
          { resourceType: "dms-endpoint", resourceId: st.instanceId,
            detail: { region: st.region, targetId: job.targetId, endpoints: sweep.deleted, jobId: job.jobId } }
        ).catch(() => {});
      }
      const endpointEvidence = {
        endpointsDeleted: [...priorDeleted, ...sweep.deleted].slice(-100),
        ...(sweep.pending.length ? { endpointsPending: sweep.pending.slice(0, 20) } : {}),
        ...(sweep.blocked.length ? { endpointsBlocked: sweep.blocked.slice(0, 20) } : {}),
        ...(sweepError ? { endpointSweepError: sweepError } : {}),
      };
      const instance = await instanceStep(dms, facts);
      // 端点那几项每一步都按本步的事实重写(上一步的「待清 / 出错」不许原样带到这一步)
      const evidence = { ...withoutSweepKeys(instance.evidence ?? {}), ...endpointEvidence };
      // 实例那一侧已有结论,但端点还没清完(还被「删除中」的复制任务引用 / 这一步清扫出错)⇒ 作业先不收口,下一步接着清
      if (instance.next.kind === "succeeded" && (sweep.pending.length > 0 || sweepError)) {
        if (overBudget) {
          return { ...instance, evidence, progress: { done: 0, total: PROGRESS_TOTAL, label: PROGRESS_LABEL },
            next: { kind: "failed", reason: sweepError
              ? `入队 ${ageMin} 分钟后仍清不了该区的遗留端点(${sweepError})⇒ 需人工:到 DMS 控制台核对 bgp-src-* / bgp-tgt-* 端点`
              : `端点 ${sweep.pending.join(" / ")} 入队 ${ageMin} 分钟后仍被复制任务占用 ⇒ 需人工:到 DMS 控制台核对` } };
        }
        return { ...instance, evidence: { ...evidence, settledOutcome: (instance.evidence ?? {}).outcome, waitingFor: sweepError ? "endpoint-sweep-retry" : "endpoint-in-use" },
          progress: { done: 0, total: PROGRESS_TOTAL, label: PROGRESS_LABEL }, next: { kind: "wait", delayMs: DMS_RECLAIM_WAIT_MS } };
      }
      return { ...instance, evidence };
    } catch (e) {
      // Describe / Delete 读写失败、AccessDenied、限流:可重试(runner 有界退避,到上限终态失败、停在清单里给人看)
      return out({ kind: "retry", reason: `回收复制实例失败:${sanitizeAwsErrorMessage(String((e as Error)?.message ?? e))}` });
    }

    /** 实例那一侧:按事实走一步。结论一旦落定(上一步已收口、只是在等端点清完)就不再重判,原样带回。 */
    async function instanceStep(dms: DmsClient, facts: SyncTaskFacts | undefined): Promise<StepResult> {
      if (typeof prior.settledOutcome === "string" && prior.settledOutcome) {
        const rest = withoutSweepKeys(prior);
        delete rest.settledOutcome;
        delete rest.waitingFor;
        return out({ kind: "succeeded" }, { ...rest, outcome: prior.settledOutcome }, PROGRESS_TOTAL);
      }
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
      // ③ 本区有任务正在启动中:编排马上会把任务挂上来,现在删了它就撞 ResourceNotFound(清扫那一步没读成任务表就在这里再读)
      const provisioning = (facts ?? (await readSyncTaskFacts(job.targetId))).provisioningHere;
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
