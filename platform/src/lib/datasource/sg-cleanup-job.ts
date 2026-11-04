// 删数据源 / 建源失败清理后,平台自建安全组 `bgp-ds-*` 的**持久**清理作业(数据面作业 kind `sg-cleanup`)。
//
// 【为什么要有】建源后的连通性探测 / 「检测」「浏览表」的 Glue 发现作业 / 同步作业都会把网卡挂在这个组上,网卡释放实测要 5–15 分钟;
//   原来删不掉就在**进程内存里**定时重试 10 × 30 秒,耗尽即放弃且不留任何记录 ⇒ 组永久遗留(2026-10-28 CloudTrail 坐实
//   两个测试账号各 11 次 DependencyViolation 后再无尝试),ECS 滚动 / 重启时重试更是当场丢。
// 【做法】与删项目后回收凭证(`lib/exec-env/project-cred-reclaim.ts`)同一套机制:
//   · 入队 = 一次条件写(`createJob`),之后由泵推进;进程被杀不丢(状态全在 DDB,租约过期由任一副本接手);
//   · handler 一步只做一件事:按**网卡事实**决定 —— 该组还被网卡引用 ⇒ `wait` 30 秒;为 0 ⇒ DeleteSecurityGroup;
//   · 预算 30 分钟(按作业 createdAt 推算):到期仍被占用 ⇒ 终态 `failed`,原因写清「需人工」,停在作业清单里给人看
//     (系统设置「后台清理任务」卡 / `GET /api/admin/pending-cleanups`),不再静默消失;
//   · 幂等:(sg-cleanup, targetId, datasourceId, sgId) 按「代」`g1, g2…` —— 未终态 / 已成功 ⇒ 原样返回,已失败 ⇒ 开下一代。
// 🔴 入队放在删源路由**动任何资源之前**:入队失败 ⇒ 拒绝删除(源还在,可重试),绝不出现「源删了、组没人管」。
//   同步删组成功时,作业下一步查到组已不在(`gone`)⇒ 自行收口成功 —— 不需要路由回头改作业。
import type { JobHandler, StepContext, StepResult } from "@/lib/dataplane-jobs/handler";
import { createJob, getJob } from "@/lib/dataplane-jobs/store";
import { dataplaneJobId, isTerminalPhase, type DataplaneJobRow } from "@/lib/dataplane-jobs/model";
import { countNetworkInterfacesInSecurityGroup, deleteSecurityGroup } from "@/lib/aws/datasource-service";
import { sanitizeAwsErrorMessage } from "@/lib/exec-env/deploy-control";
// 清理步在泵的内部请求里跑,第一个数据面调用之前按作业落点记一笔决策(否则观测器把 ec2.Describe* 记成未归因)
import { notePlaceDecision } from "@/lib/place/context";

/** 决策记账里的作者名(观测清单按它归类)。 */
export const SG_CLEANUP_VIA = "datasourceSgCleanup";
/** 网卡还在时等多久再看(Glue 作业网卡释放通常 5–15 分钟,30 秒一看足够细)。 */
export const SG_CLEANUP_WAIT_MS = 30_000;
/** 从入队算起的总预算:到期仍被占用 ⇒ 终态失败、点名需人工。 */
export const SG_CLEANUP_BUDGET_MS = 30 * 60_000;
/** 每个 (target, datasource, sg) 最多几代作业。 */
const MAX_GENERATIONS = 20;
const PROGRESS_LABEL = "delete-platform-security-group";
const PROGRESS_TOTAL = 1;

/** 作业私有 state(入队时写死,handler 只读)。 */
export interface SgCleanupState {
  sgId: string;
  region: string;
  datasourceId: string;
}

export type SgCleanupOutcome = "deleted" | "gone" | "skipped-not-platform" | "needs-manual";

function stateOf(job: Readonly<DataplaneJobRow>): SgCleanupState | null {
  const s = (job.state ?? {}) as Partial<SgCleanupState>;
  if (typeof s.sgId !== "string" || !s.sgId || typeof s.region !== "string" || !s.region || typeof s.datasourceId !== "string" || !s.datasourceId) {
    return null;
  }
  return { sgId: s.sgId, region: s.region, datasourceId: s.datasourceId };
}

export const sgCleanupJobHandler: JobHandler = {
  async step(ctx: StepContext): Promise<StepResult> {
    const job = ctx.job;
    const out = (next: StepResult["next"], evidence: Record<string, unknown> = job.evidence ?? {}, done = 0): StepResult => ({
      state: job.state ?? {},
      progress: { done, total: PROGRESS_TOTAL, label: PROGRESS_LABEL },
      evidence,
      next,
    });
    const st = stateOf(job);
    if (!st) {
      return out({ kind: "failed", reason: "清理作业缺 sgId / region / datasourceId ⇒ 不可恢复(入队方缺字段)" });
    }
    const base = { sgId: st.sgId, region: st.region, datasourceId: st.datasourceId };
    try {
      notePlaceDecision({ targetId: job.targetId, via: SG_CLEANUP_VIA });
      // ① 网卡事实:还有网卡引用这个组就不动手(DeleteSecurityGroup 必 DependencyViolation)
      const eniCount = await countNetworkInterfacesInSecurityGroup(st.sgId, st.region);
      const ageMs = ctx.now() - Date.parse(job.createdAt);
      if (eniCount > 0) {
        if (Number.isFinite(ageMs) && ageMs > SG_CLEANUP_BUDGET_MS) {
          return out(
            {
              kind: "failed",
              reason: `安全组 ${st.sgId}(${st.region})入队 ${Math.round(ageMs / 60_000)} 分钟后仍被 ${eniCount} 张网卡引用 ⇒ 需人工:确认网卡释放后删除该组`,
            },
            { ...base, eniCount, outcome: "needs-manual" satisfies SgCleanupOutcome }
          );
        }
        return out({ kind: "wait", delayMs: SG_CLEANUP_WAIT_MS }, { ...base, eniCount });
      }
      // ② 网卡为 0 ⇒ 删(归属判定在 deleteSecurityGroup 里:只删恰好等于本源平台组名的组)
      const r = await deleteSecurityGroup(st.sgId, st.region, st.datasourceId);
      switch (r) {
        case "deleted":
        case "gone":
        case "skipped-not-platform":
          return out({ kind: "succeeded" }, { ...base, eniCount: 0, outcome: r satisfies SgCleanupOutcome }, PROGRESS_TOTAL);
        case "failed-dependency":
          // Describe 与 Delete 之间又挂上了网卡(同一条连接的另一次作业)⇒ 当作还在占用,下一轮再看
          if (Number.isFinite(ageMs) && ageMs > SG_CLEANUP_BUDGET_MS) {
            return out(
              { kind: "failed", reason: `安全组 ${st.sgId}(${st.region})入队 ${Math.round(ageMs / 60_000)} 分钟后删除仍报 DependencyViolation ⇒ 需人工` },
              { ...base, outcome: "needs-manual" satisfies SgCleanupOutcome }
            );
          }
          return out({ kind: "wait", delayMs: SG_CLEANUP_WAIT_MS }, { ...base, lastDelete: "failed-dependency" });
        case "failed":
        default:
          return out({ kind: "retry", reason: `DeleteSecurityGroup ${st.sgId} 失败(非网卡占用)` });
      }
    } catch (e) {
      // Describe 读失败 / AccessDenied / 限流:可重试(runner 有界退避,到上限终态失败、停在清单里给人看)
      return out({ kind: "retry", reason: `清理安全组失败:${sanitizeAwsErrorMessage(String((e as Error)?.message ?? e))}` });
    }
  },
};

export interface SgCleanupEnqueueResult {
  jobId: string;
  created: boolean;
  phase: string;
}

/**
 * 给一个平台自建安全组登记一条持久清理作业(幂等,按代)。
 * 🔴 调用方在**动任何资源之前**调它;抛 ⇒ 调用方必须拒绝删除(源还在,可重试)。
 */
export async function enqueueSgCleanup(args: {
  sgId: string;
  region: string;
  targetId: string;
  datasourceId: string;
  createdBy: string;
  now?: number;
}): Promise<SgCleanupEnqueueResult> {
  const { sgId, region, targetId, datasourceId } = args;
  if (!sgId || !region || !targetId || !datasourceId) {
    throw new Error("enqueueSgCleanup: sgId / region / targetId / datasourceId 都必填");
  }
  const now = args.now ?? Date.now();
  let latest: DataplaneJobRow | null = null;
  let gen = 1;
  for (; gen <= MAX_GENERATIONS; gen++) {
    const row = await getJob(dataplaneJobId("sg-cleanup", targetId, datasourceId, `${sgId}:g${gen}`));
    if (!row) break;
    latest = row;
  }
  if (latest && (!isTerminalPhase(latest.phase) || latest.phase === "succeeded")) {
    return { jobId: latest.jobId, created: false, phase: latest.phase };
  }
  if (gen > MAX_GENERATIONS) {
    throw new Error(`安全组 ${sgId} 的清理作业已达 ${MAX_GENERATIONS} 代仍失败 ⇒ 拒绝再开(请先人工处理该组)`);
  }
  const state: SgCleanupState = { sgId, region, datasourceId };
  const r = await createJob({
    kind: "sg-cleanup",
    targetId,
    subject: datasourceId,
    idempotencyKey: `${sgId}:g${gen}`,
    createdBy: args.createdBy,
    state: { ...state },
    progress: { done: 0, total: PROGRESS_TOTAL, label: PROGRESS_LABEL },
    now,
  });
  return { jobId: r.job.jobId, created: r.created, phase: r.job.phase };
}
