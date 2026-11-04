// @kf-batch 50-project-delete-orphans
// 删项目空间之后,**回收**该项目在各执行区的 per-project 凭证 secret(`bgp/project/<targetSlug>/<projectId>`)。
//
// 【为什么要有】真环境清理 128 个夹具项目时发现:项目删了,WP-9a 给它供给的凭证 secret 还留在每个执行区 ——
//   · 它是**系统代管**的东西(人没建过、页面上也看不见),所以不能像用户资源那样「阻断删除 + 让人去删」;
//   · 它是一份**仍然可用的数据库口令**(登录用户还在那个区的数仓里),留着 = 一个没有主人的有效凭证。
// ⇒ 删项目由产品**自动回收**,不让人处置。
//
// 【为什么做成数据面作业(WP-9a 的 `bgp-dataplane-jobs`),而不是在 DELETE 请求里原地删】
//   · 跨区:每个执行区一次 Secrets Manager 调用,与供给同一个「跨区 504」风险面 —— WP-9a 正是为此把供给作业化的;
//   · 失败要**有人看得见、能自动重试**:原地删失败时项目已经没了,再没有入口重试(只能写一条审计然后祈祷);
//     作业失败按 runner 的有界退避重试,终态失败停在该执行环境的作业清单里(`/api/admin/exec-envs/<t>/jobs`);
//   · 进程被杀不丢:入队是一次条件写,之后由泵推进;
//   · 在途作业会挡住「删除执行环境」(WP-30 的 `countActiveJobs`)—— 不会出现环境先没了、回收无处可做。
//
// 【入队在删项目**之前**,handler 等项目真的没了才动手】(顺序是这一层的承重)
//   · 入队失败 ⇒ 路由**拒绝删除**(项目还在,可以重试)—— 绝不出现「项目删了、回收作业一条都没入队」;
//   · handler 第一件事是确认项目**已不存在**:还在 ⇒ `wait`(删除请求可能还没走完);
//     超过宽限期还在 ⇒ `failed`(删除没有完成)—— 🔴 **绝不回收一个在用项目的凭证**。
//
// 【不做的事(如实登记)】
//   · 不删 `bgp-dataplane-jobs` 里该项目的供给 / canary 作业行:那张表**不删行**(store 是唯一写通道,
//     它们是凭证生命周期的证据),项目删了它们不会再被推进(供给步骤的交叉验证会拒掉不存在的项目)。
//   · 不 DROP 该区数仓里的 `user_proj_*` / `role_proj_*` / `proj_*` schema:那是破坏性 DDL,
//     走审批单(`drop-project-schema`),不随删项目自动执行。口令副本删掉后登录用户已无人可用。
import { getTargetRaw, listTargetsRaw } from "@/lib/exec-env/registry";
import { getProject } from "@/lib/projects/project-service";
import { assertProjectId } from "@/lib/exec-env/project-schema";
import { deleteProjectSecret } from "@/lib/exec-env/project-secret";
import { sanitizeAwsErrorMessage } from "@/lib/exec-env/deploy-control";
import type { JobHandler, StepContext, StepResult } from "@/lib/dataplane-jobs/handler";
import { createJob, getJob } from "@/lib/dataplane-jobs/store";
import { dataplaneJobId, isTerminalPhase, type DataplaneJobRow } from "@/lib/dataplane-jobs/model";
// @kf-batch 50-WP31-place-first-class 序 31 二刀 ⑤:回收步在泵的内部请求里跑(`/api/internal/dataplane-jobs/step`),
//   删该区 secret 之前按作业落点记一笔决策 —— 否则观测器把 `secretsmanager.DeleteSecret` 记成未归因(测试账号 4 次)。
import { notePlaceDecision } from "@/lib/place/context";

/** 决策记账里的作者名(观测清单按它归类)。 */
export const PROJECT_CRED_RECLAIM_VIA = "projectCredReclaim";

/** 项目还在时等多久再看(删除请求通常几百毫秒内走完)。 */
export const RECLAIM_WAIT_MS = 30_000;
/** 入队后项目仍然存在的宽限期:超过 ⇒ 判定「删除没有完成」⇒ 终态失败(不回收在用项目的凭证)。 */
export const RECLAIM_PROJECT_GONE_GRACE_MS = 60 * 60_000;
/** 每个 (target, project) 最多几代回收作业(防止无界地找下一代 id)。 */
const MAX_RECLAIM_GENERATIONS = 20;

const PROGRESS_TOTAL = 1;

export const reclaimJobHandler: JobHandler = {
  async step(ctx: StepContext): Promise<StepResult> {
    const job = ctx.job;
    const out = (next: StepResult["next"], evidence: Record<string, unknown> = job.evidence ?? {}, done = 0): StepResult => ({
      state: job.state ?? {},
      progress: { done, total: PROGRESS_TOTAL, label: "delete-project-secret" },
      evidence,
      next,
    });
    let projectId: string;
    try {
      projectId = assertProjectId(job.projectId);
    } catch (e) {
      return out({ kind: "failed", reason: `回收作业缺合法 projectId ⇒ 不可恢复:${sanitizeAwsErrorMessage(String((e as Error)?.message ?? e))}` });
    }
    try {
      // ① 项目必须**已经不在**:入队发生在删项目之前,这里等它真的删掉
      if (await getProject(projectId)) {
        const age = ctx.now() - Date.parse(job.createdAt);
        if (Number.isFinite(age) && age > RECLAIM_PROJECT_GONE_GRACE_MS) {
          return out({
            kind: "failed",
            reason: `项目 ${projectId} 在入队 ${Math.round(age / 60_000)} 分钟后仍然存在(删项目没有完成?)—— 拒绝回收在用项目的凭证`,
          });
        }
        return out({ kind: "wait", delayMs: RECLAIM_WAIT_MS });
      }
      // ② 落点:只认注册表里的那一行(region 派生与查找 / 供给同一个作者);作业的 targetId 就是这一步的落点 ⇒ 记账在第一个数据面调用之前
      notePlaceDecision({ targetId: job.targetId, via: PROJECT_CRED_RECLAIM_VIA });
      const t = await getTargetRaw(job.targetId);
      if (!t) {
        return out({
          kind: "failed",
          reason: `执行环境 ${job.targetId} 已不在注册表 ⇒ 无法定位该区,凭证 secret 需人工核对(名字由 projectSecretName 派生)`,
        });
      }
      // ③ 🔴 B-48(序 36 真环境):已删除、且**从没装出数仓**的执行环境(例:被组织 SCP 拦死的区注册后弃置)——
      //   供给的两个作者(project-cred-supply / admin-ddl-executor)都要先经 resolveTargetWarehouse 拿到数仓落点,
      //   没有 redshiftWorkgroup 就建不出 secret ⇒ 这里**可证明**没有东西要回收。原来照样去删 ⇒ 每删一个项目
      //   就给那个死环境留一条重试 6 次后失败的作业。只认「deleted + 无数仓」:在用环境缺资源是异常,照旧重试给人看。
      //   (home 永不可删 —— decommission / broker / buildspec 三道拒 ⇒ 这条分支到不了 home)
      if (t.status === "deleted" && !hasWarehouseResource(t)) {
        return out(
          { kind: "succeeded" },
          { region: t.region, outcome: "never-supplied", reason: "执行环境已删除且从未装出数仓(无 redshiftWorkgroup)⇒ 供给不可能发生过" },
          PROGRESS_TOTAL
        );
      }
      const r = await deleteProjectSecret(t, projectId);
      return out({ kind: "succeeded" }, { secretName: r.secretName, region: r.region, outcome: r.outcome }, PROGRESS_TOTAL);
    } catch (e) {
      // 读失败 / AccessDenied / 限流:可重试(runner 有界退避,到上限终态失败、停在作业清单里给人看)
      return out({ kind: "retry", reason: `回收凭证失败:${sanitizeAwsErrorMessage(String((e as Error)?.message ?? e))}` });
    }
  },
};

function hasWarehouseResource(t: { resources?: unknown }): boolean {
  const wg = ((t.resources ?? {}) as Record<string, unknown>).redshiftWorkgroup;
  return typeof wg === "string" && wg.trim().length > 0;
}

export interface ReclaimEnqueueResult {
  jobs: Array<{ targetId: string; jobId: string; created: boolean; phase: string }>;
  /** 入队失败的执行区 —— 🔴 非空时调用方**必须**拒绝删项目(否则那个区的凭证就永远没人回收) */
  failures: Array<{ targetId: string; error: string }>;
}

/**
 * 给「该项目 × 注册表里的**每个**执行环境」各入队一条回收作业(含主控区)。
 *
 * 🔴 不预先判断「哪个区真有 secret」:那要逐区 Describe(跨区、可能失败),而判断错了就是漏回收;
 *    每区一条、handler 里删 —— `absent` 是 Secrets Manager 明确回的「没有」,不是猜的。
 * 幂等(与供给作业同形):每 (target, project) 按「代」`g1, g2…` 找最新一代 ——
 *   未终态 / 已成功 ⇒ 原样返回(双击删除 / 重放只有一条);已失败 ⇒ 开下一代(删项目重试时重新回收)。
 * 🔴 读注册表失败 ⇒ **抛**(调用方拒绝删除);单个区入队失败 ⇒ 进 `failures`,其余照常。
 */
export async function enqueueProjectCredReclaim(
  projectId: string,
  opts: { createdBy: string; now?: number }
): Promise<ReclaimEnqueueResult> {
  const pid = assertProjectId(projectId);
  const now = opts.now ?? Date.now();
  const out: ReclaimEnqueueResult = { jobs: [], failures: [] };
  for (const t of await listTargetsRaw()) {
    try {
      let latest: DataplaneJobRow | null = null;
      let gen = 1;
      for (; gen <= MAX_RECLAIM_GENERATIONS; gen++) {
        const row = await getJob(dataplaneJobId("reclaim", t.targetId, pid, `g${gen}`));
        if (!row) break;
        latest = row;
      }
      if (latest && (!isTerminalPhase(latest.phase) || latest.phase === "succeeded")) {
        out.jobs.push({ targetId: t.targetId, jobId: latest.jobId, created: false, phase: latest.phase });
        continue;
      }
      if (gen > MAX_RECLAIM_GENERATIONS) {
        throw new Error(`回收作业已达 ${MAX_RECLAIM_GENERATIONS} 代仍失败 ⇒ 拒绝再开(请先排查该区为什么反复失败)`);
      }
      const r = await createJob({
        kind: "reclaim",
        targetId: t.targetId,
        projectId: pid,
        subject: pid,
        idempotencyKey: `g${gen}`,
        createdBy: opts.createdBy,
        state: {},
        progress: { done: 0, total: PROGRESS_TOTAL, label: "delete-project-secret" },
        now,
      });
      out.jobs.push({ targetId: t.targetId, jobId: r.job.jobId, created: r.created, phase: r.job.phase });
    } catch (e) {
      out.failures.push({ targetId: t.targetId, error: sanitizeAwsErrorMessage(String((e as Error)?.message ?? e)) });
    }
  }
  return out;
}
