// @kf-batch 50-WP9a-durable-jobs
// 🔴🔴 **permission canary**(WORK-PACKAGES WP-9 ④-3 / 施工序 3;50 SPEC §3.9b「进 isolated 的前置:canary 成功」)。
//
// ── 它取代了什么 ─────────────────────────────────────────────────────────────────
// P52.5a 的 `credential-state` 进 isolated 时只核「每个项目有 secret」,canary 那一半靠一句**逐字确认串**
// 「我已完成 canary 与跨项目负测」由操作者具名承担 —— 因为当时服务端**没有办法自证**。
// 本文件给出这个办法:每个 (target, project) 用**该项目自己的 secret** 在该区的库里真跑七条,读真结果判。
// 确认串保留(具名承担),但**不再替代判据**。
//
// ── 七条 ──────────────────────────────────────────────────────────────────────────
//   C-1 `current_user` = `user_proj_<id>`            正控制:证明真的是用项目身份连上的
//   C-2 读 `proj_<id>.bgp_canary` 成功                正控制:证明项目能读自己的东西
//   C-3 读 `bgp_canary_deny.bgp_canary` ⇒ denied      跨项目负测(deny schema 不授任何项目 ⇒ 单项目环境也能测)
//   C-4 读 `shared.bgp_canary` 成功                   全局知识只读可达
//   C-5 写 `shared.bgp_canary` ⇒ denied               shared 只读
//   C-6 在 `public` 建表 ⇒ denied                     新写入不再落 public(要先 revoke-public-create)
//   C-7 `current_schemas(false)` 首位 = `proj_<id>`   不带 schema 的建表落项目 schema
//
// ── 🔴 三条判定纪律(每一条都对着一种「假绿」)──────────────────────────────────────
//   ① 负向**只认** `permission denied`。连不上 / 语法错 / 表不存在 / 限流 都会让「操作失败」,
//      而它们说明不了权限 ⇒ 一律 `unverifiable`(不算过)。把任何失败都当「被拒」= 口令改坏了七条反而全绿。
//   ② 正控制(C-1 / C-2)不过 ⇒ 负向结果**作废**成 unverifiable:身份都没连对,它被拒什么都证明不了。
//   ③ 结果绑 `credentialEpoch` + 时间戳:epoch 一变(延期 / 轮换 / 推进)或超过 24h,旧结果就不能再当前置。
import { getTargetRaw } from "@/lib/exec-env/registry";
import { requireCredentialIsolationState } from "@/lib/exec-env/privileged-cred";
import { lookupProjectSecretArn } from "@/lib/exec-env/project-secret";
import { resolveTargetWarehouse } from "@/lib/exec-env/target-clients";
import { SHARED_SCHEMA, assertProjectId, projectDbUserName, projectSchema } from "@/lib/exec-env/project-schema";
import { CANARY_DENY_SCHEMA, CANARY_TABLE, canaryPublicProbeTable } from "@/lib/exec-env/canary-names";
import {
  settleAdminDdl,
  submitAdminDdl,
  redactSql,
  type AdminDdlSubmission,
  type AuthenticatedActor,
} from "@/lib/exec-env/admin-ddl-executor";
import { describeStatementState, firstScalar, submitStatements } from "@/lib/dataplane-jobs/statement";
import { pollWithin, type JobHandler, type StepContext, type StepResult } from "@/lib/dataplane-jobs/handler";
import { createJob, listJobsByTarget } from "@/lib/dataplane-jobs/store";
import { INLINE_POLL_BUDGET_MS, WAIT_POLL_MS } from "@/lib/dataplane-jobs/model";
import type { CanaryCheckEvidence, CanaryEvidence, CanaryOutcome } from "@/lib/dataplane-jobs/dto";

export type CanaryCheckId = CanaryCheckEvidence["id"];

/** canary 结果作为 isolated 前置的有效期(WP-9 ④-3:≤ 24h)。 */
export const CANARY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** canary 作业行的 TTL(证据可再生;30 天足够回看)。 */
const CANARY_JOB_TTL_SECONDS = 30 * 24 * 60 * 60;

interface CheckSpec {
  id: CanaryCheckId;
  /** control = 正控制(不过则整组负向作废);positive = 必须成功;negative = 必须 permission denied */
  role: "control" | "positive" | "negative";
  what: string;
  /** 一条 = 单语句;多条 = 一个 Batch(同一事务)—— C-6 要「建了立刻删」,不许把探针表留在 public 里 */
  sql: (projectId: string) => string | readonly string[];
  /** 需要读结果值的正向检查:返回 null = 通过,否则 = 不通过的说明 */
  expectValue?: (value: string, projectId: string) => string | null;
}

/** 标识符编码(与模板同一规则:双引号 + 内部双引号翻倍;名字本身已过 SSOT)。 */
function q(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`canary 拒绝非法标识符:${JSON.stringify(name)}`);
  return `"${name.replace(/"/g, '""')}"`;
}

/** 解析 `current_schemas(false)` 的结果(Data API 回的是 `{a,b,c}` 形态的文本)。 */
export function firstSchemaOf(value: string): string {
  const inner = String(value).trim().replace(/^\{/, "").replace(/\}$/, "");
  const first = inner.split(",")[0] ?? "";
  return first.trim().replace(/^"(.*)"$/, "$1");
}

/** 七条的定义 —— **唯一作者**(顺序即执行序;C-1 / C-2 先跑,正控制先于一切)。 */
export const CANARY_CHECKS: readonly CheckSpec[] = [
  {
    id: "C-1",
    role: "control",
    what: "current_user 必须是该项目的登录用户",
    sql: () => "SELECT current_user",
    expectValue: (v, pid) => {
      const want = projectDbUserName(pid);
      return v.trim().toLowerCase() === want.toLowerCase() ? null : `current_user = ${v.trim()},期望 ${want}`;
    },
  },
  {
    id: "C-2",
    role: "control",
    what: "读本项目的探针表必须成功",
    sql: (pid) => `SELECT count(*) FROM ${q(projectSchema(pid))}.${q(CANARY_TABLE)}`,
  },
  {
    id: "C-3",
    role: "negative",
    what: "读不授任何项目的探针表必须 permission denied(跨项目负测)",
    sql: () => `SELECT count(*) FROM ${q(CANARY_DENY_SCHEMA)}.${q(CANARY_TABLE)}`,
  },
  {
    id: "C-4",
    role: "positive",
    what: "读 shared 的探针表必须成功",
    sql: () => `SELECT count(*) FROM ${q(SHARED_SCHEMA)}.${q(CANARY_TABLE)}`,
  },
  {
    id: "C-5",
    role: "negative",
    what: "往 shared 写必须 permission denied(shared 只读)",
    sql: () => `INSERT INTO ${q(SHARED_SCHEMA)}.${q(CANARY_TABLE)} (probe) VALUES (1)`,
  },
  {
    id: "C-6",
    role: "negative",
    what: "在 public 建表必须 permission denied",
    // @kf-batch 50-WP9a-canary-c6-residue(2026-10-11 真环境:撤权前 C-6 真建成了 ⇒ 表留在 public,
    //   之后每一轮都撞 already exists ⇒ C-6 永久 unverifiable,isolated 前置永远过不了 —— 判据自己造的残留把自己堵死)。
    // ⇒ 一个事务里:先删本项目上次可能留下的同名探针(属主就是本项目登录,删得掉)→ 建 → 立刻删。
    //   建被拒 ⇒ 整个事务回滚,错误就是那句 permission denied(结论不变);建成 ⇒ 当场删掉,不留残留(结论 = 隔离有洞)。
    sql: (pid) => {
      const t = `${q("public")}.${q(canaryPublicProbeTable(pid))}`;
      return [`DROP TABLE IF EXISTS ${t}`, `CREATE TABLE ${t} (probe INTEGER)`, `DROP TABLE ${t}`];
    },
  },
  {
    id: "C-7",
    role: "positive",
    what: "search_path 首位必须是该项目的 schema",
    sql: () => "SELECT current_schemas(false)",
    expectValue: (v, pid) => {
      const first = firstSchemaOf(v);
      const want = projectSchema(pid);
      return first === want ? null : `current_schemas 首位 = ${first || "(空)"},期望 ${want}`;
    },
  },
];

const PERMISSION_DENIED_RE = /permission denied/i;
const ALREADY_EXISTS_RE = /already exists/i;

/** 一条检查的原始观测。 */
export type CanaryObservation = { ok: true; value?: string } | { ok: false; error: string };

/**
 * 单条判定(纯函数)。🔴 见文件头三条纪律 ①。
 */
export function classifyCheck(spec: CheckSpec, obs: CanaryObservation, projectId: string): CanaryCheckEvidence {
  const err = obs.ok ? "" : redactSql(obs.error).slice(0, 200);
  if (spec.role === "negative") {
    if (obs.ok) {
      const residue = spec.id === "C-6" ? `(在 public 建出了 ${canaryPublicProbeTable(projectId)},同一事务里已删掉)` : "";
      return { id: spec.id, outcome: "fail", detail: `本应被拒却执行成功 —— 隔离有洞${residue}` };
    }
    if (PERMISSION_DENIED_RE.test(obs.error)) return { id: spec.id, outcome: "pass", detail: "被拒(permission denied),符合预期" };
    if (spec.id === "C-6" && ALREADY_EXISTS_RE.test(obs.error)) {
      return {
        id: spec.id,
        outcome: "unverifiable",
        detail: `public 里已有上次残留的 ${canaryPublicProbeTable(projectId)} ⇒ 这次无法判定能否建表(残留本身说明曾经建成过)`,
      };
    }
    return { id: spec.id, outcome: "unverifiable", detail: `失败但不是 permission denied ⇒ 说明不了权限:${err}` };
  }
  // control / positive
  if (!obs.ok) {
    if (PERMISSION_DENIED_RE.test(obs.error)) return { id: spec.id, outcome: "fail", detail: `被拒:${err}` };
    return { id: spec.id, outcome: "unverifiable", detail: `执行失败(不是权限结论):${err}` };
  }
  if (spec.expectValue) {
    if (obs.value === undefined) return { id: spec.id, outcome: "unverifiable", detail: "执行成功但读不到结果值" };
    const bad = spec.expectValue(obs.value, projectId);
    if (bad) return { id: spec.id, outcome: "fail", detail: bad };
  }
  return { id: spec.id, outcome: "pass", detail: "符合预期" };
}

/**
 * 整组判定(纯函数)。🔴 见文件头纪律 ②:正控制不过 ⇒ 负向结果作废成 unverifiable。
 * verdict:任何一条 fail ⇒ fail;否则任何一条 unverifiable(或条数不全)⇒ unverifiable;七条全 pass ⇒ pass。
 */
export function evaluateCanary(raw: readonly CanaryCheckEvidence[]): { verdict: CanaryOutcome; checks: CanaryCheckEvidence[] } {
  const controlsOk = ["C-1", "C-2"].every((id) => raw.find((c) => c.id === id)?.outcome === "pass");
  const checks = raw.map((c) => {
    const spec = CANARY_CHECKS.find((s) => s.id === c.id);
    if (!controlsOk && spec?.role === "negative" && c.outcome === "pass") {
      return { ...c, outcome: "unverifiable" as const, detail: `正控制(C-1 / C-2)未通过 ⇒ 这条「被拒」证明不了权限:${c.detail}` };
    }
    return c;
  });
  const complete = CANARY_CHECKS.every((s) => checks.some((c) => c.id === s.id));
  if (checks.some((c) => c.outcome === "fail")) return { verdict: "fail", checks };
  if (!complete || checks.some((c) => c.outcome === "unverifiable")) return { verdict: "unverifiable", checks };
  return { verdict: "pass", checks };
}

// ──────────────────────────────────────────────────────────────────────────────
// 作业 handler(准备探针 → 逐条真跑 → 判定)
// ──────────────────────────────────────────────────────────────────────────────

interface CanaryState {
  phase: "prepare" | "checks";
  runAs: AuthenticatedActor;
  epochAtStart?: number;
  /** 建探针的 admin 语句(两段式提交凭据) */
  pending?: AdminDdlSubmission;
  idx: number;
  /** 当前这条检查已提交的 statementId(用项目身份提交的,不经 admin 执行器) */
  checkPending?: string;
  results: CanaryCheckEvidence[];
}

function canaryStateOf(raw: Record<string, unknown>): CanaryState {
  const s = raw as unknown as CanaryState;
  if (!s || (s.phase !== "prepare" && s.phase !== "checks") || !s.runAs || typeof s.runAs.actor !== "string") {
    throw new Error("canary 作业的 state 形态不对 ⇒ 拒绝推进");
  }
  return { ...s, idx: Number(s.idx ?? 0), results: Array.isArray(s.results) ? s.results : [] };
}

const TOTAL_UNITS = CANARY_CHECKS.length + 1; // 准备探针 + 七条

function canaryProgress(s: CanaryState) {
  const done = s.phase === "prepare" ? 0 : 1 + s.idx;
  const label = s.phase === "prepare" ? "create-canary-probes" : CANARY_CHECKS[s.idx]?.id ?? "evaluate";
  return { done: Math.min(done, TOTAL_UNITS), total: TOTAL_UNITS, label };
}

export const canaryJobHandler: JobHandler = {
  async step(ctx: StepContext): Promise<StepResult> {
    const job = ctx.job;
    const projectId = assertProjectId(job.projectId);
    const s = canaryStateOf(job.state);
    const out = (next: StepResult["next"], st: CanaryState = s, evidence: CanaryEvidence = { checks: st.results }): StepResult => ({
      state: st as unknown as Record<string, unknown>,
      progress: canaryProgress(st),
      evidence: evidence as unknown as Record<string, unknown>,
      next,
    });
    const target = await getTargetRaw(job.targetId);
    if (!target) return out({ kind: "failed", reason: `执行目标 ${job.targetId} 不存在` });
    const iso = requireCredentialIsolationState(target);

    if (s.phase === "prepare") {
      if (!s.pending) {
        const arn = await lookupProjectSecretArn(target, projectId);
        if (!arn) {
          // 没有项目凭证 ⇒ 七条一条都跑不了;这是一个**结论**(unverifiable),不是作业失败
          return out({ kind: "succeeded" }, s, {
            verdict: "unverifiable",
            credentialEpoch: iso.epoch,
            at: new Date(ctx.now()).toISOString(),
            checks: [],
            reason: "该项目在此执行环境还没有 per-project 凭证 ⇒ 无法用它自己的身份跑 canary(先供给)",
          });
        }
        const pending = await submitAdminDdl(s.runAs, { operation: "create-canary-probes", targetId: job.targetId, projectId });
        return out({ kind: "continue" }, { ...s, pending, epochAtStart: iso.epoch });
      }
      const pending = s.pending;
      const r = await pollWithin(() => settleAdminDdl(pending), ctx, INLINE_POLL_BUDGET_MS);
      if (r.state === "running") return out({ kind: "wait", delayMs: WAIT_POLL_MS });
      const next: CanaryState = { ...s, phase: r.state === "succeeded" ? "checks" : "prepare", idx: 0 };
      delete next.pending;
      if (r.state === "failed") return out({ kind: "retry", reason: `建 canary 探针失败:${r.error}` }, next);
      return out({ kind: "continue" }, next);
    }

    // ── checks ──
    if (s.idx >= CANARY_CHECKS.length) {
      const { verdict, checks } = evaluateCanary(s.results);
      // 🔴 纪律 ③:跑的过程中 epoch 变了(延期 / 轮换 / 推进),这组结果对应的是**旧**凭证世代 ⇒ 不能当前置
      const epochMoved = typeof s.epochAtStart === "number" && s.epochAtStart !== iso.epoch;
      return out({ kind: "succeeded" }, s, {
        verdict: epochMoved ? "unverifiable" : verdict,
        credentialEpoch: s.epochAtStart ?? iso.epoch,
        at: new Date(ctx.now()).toISOString(),
        checks,
        ...(epochMoved ? { reason: `运行期间凭证世代从 ${s.epochAtStart} 变成 ${iso.epoch} ⇒ 结果作废,请重跑` } : {}),
      });
    }
    const spec = CANARY_CHECKS[s.idx];
    const record = (obs: CanaryObservation): StepResult => {
      const st: CanaryState = { ...s, idx: s.idx + 1, results: [...s.results, classifyCheck(spec, obs, projectId)] };
      delete st.checkPending;
      return out({ kind: "continue" }, st);
    };
    const warehouse = resolveTargetWarehouse(target);
    if (s.checkPending) {
      const id = s.checkPending;
      const st = await pollWithin(() => describeStatementState(warehouse.region, id), ctx, INLINE_POLL_BUDGET_MS);
      if (st.state === "running") return out({ kind: "wait", delayMs: WAIT_POLL_MS });
      if (st.state === "failed") return record({ ok: false, error: st.error });
      if (spec.expectValue) {
        try {
          return record({ ok: true, value: await firstScalar(warehouse.region, id) });
        } catch (e) {
          return record({ ok: true }); // 读不到值 ⇒ classify 判 unverifiable
        }
      }
      return record({ ok: true });
    }
    // 🔴 每条都重新按名找该项目的 secret(不把 ARN 存进作业行):凭证中途被删 ⇒ 这一条如实记 unverifiable
    const arn = await lookupProjectSecretArn(target, projectId);
    if (!arn) return record({ ok: false, error: "执行期间该项目的 per-project 凭证不见了" });
    try {
      const statementId = await submitStatements({
        place: { region: warehouse.region, workgroup: warehouse.workgroup, database: warehouse.database },
        sqls: ([] as string[]).concat(spec.sql(projectId)),
        secretArn: arn,
      });
      return out({ kind: "continue" }, { ...s, checkPending: statementId });
    } catch (e) {
      // 提交就被拒(如 secret 读不到):说明不了库内权限 ⇒ 记 unverifiable,不当 pass 也不当 fail
      return record({ ok: false, error: `提交失败:${String((e as Error)?.message ?? e)}` });
    }
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// 入队 + 读最新结果 + isolated 前置判据
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 入队一次 canary。幂等键 = `e<epoch>:m<分钟桶>` ⇒ 同一分钟内重复点只跑一次;epoch 变了必然是新的一次。
 */
export async function enqueueCanaryJob(
  targetId: string,
  projectId: string,
  opts: { runAs: AuthenticatedActor; credentialEpoch: number; now?: number }
): Promise<{ jobId: string; created: boolean; phase: string }> {
  const pid = assertProjectId(projectId);
  const now = opts.now ?? Date.now();
  const state: CanaryState = { phase: "prepare", runAs: opts.runAs, idx: 0, results: [] };
  const r = await createJob({
    kind: "canary",
    targetId,
    projectId: pid,
    subject: pid,
    idempotencyKey: `e${opts.credentialEpoch}:m${Math.floor(now / 60_000)}`,
    createdBy: opts.runAs.actor,
    state: state as unknown as Record<string, unknown>,
    progress: { done: 0, total: TOTAL_UNITS, label: "create-canary-probes" },
    now,
    ttlEpochSeconds: Math.floor(now / 1000) + CANARY_JOB_TTL_SECONDS,
  });
  return { jobId: r.job.jobId, created: r.created, phase: r.job.phase };
}

export interface LatestCanary extends CanaryEvidence {
  jobId: string;
  projectId: string;
}

/**
 * 每个项目**最近一次判定完成**的 canary(作业 succeeded 才有判定;作业失败 = 没跑完,不算结果)。
 */
export async function latestCanaryByProject(targetId: string): Promise<Map<string, LatestCanary>> {
  const rows = await listJobsByTarget(targetId, { kind: "canary", maxItems: 2000 });
  const sorted = [...rows].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const out = new Map<string, LatestCanary>();
  for (const r of sorted) {
    if (r.phase !== "succeeded" || !r.projectId || out.has(r.projectId)) continue;
    out.set(r.projectId, { ...(r.evidence as CanaryEvidence), jobId: r.jobId, projectId: r.projectId });
  }
  return out;
}

export interface CanaryPrerequisite {
  ok: boolean;
  /** 不满足的项目与原因(点名;CN-4) */
  failing: Array<{ projectId: string; why: string }>;
}

/**
 * isolated 前置之一:在用项目**最新** canary 全 pass ∧ epoch 与当前一致 ∧ ≤ 24h。
 * 🔴 任何一项拿不准都算不满足(没有结果 / 时间解析不了 / epoch 缺失)。
 */
export function canaryPrerequisite(
  projects: readonly string[],
  latest: ReadonlyMap<string, LatestCanary>,
  currentEpoch: number,
  now: number
): CanaryPrerequisite {
  const failing: CanaryPrerequisite["failing"] = [];
  for (const p of projects) {
    const c = latest.get(p);
    if (!c) {
      failing.push({ projectId: p, why: "没有判定完成的 canary 结果" });
      continue;
    }
    if (c.verdict !== "pass") {
      const bad = (c.checks ?? []).filter((x) => x.outcome !== "pass").map((x) => `${x.id}=${x.outcome}`);
      failing.push({ projectId: p, why: `最新 canary = ${c.verdict ?? "未知"}${bad.length ? `(${bad.join(", ")})` : ""}${c.reason ? `:${c.reason}` : ""}` });
      continue;
    }
    if (c.credentialEpoch !== currentEpoch) {
      failing.push({ projectId: p, why: `最新 canary 绑定的凭证世代是 ${String(c.credentialEpoch)},当前是 ${currentEpoch} ⇒ 须重跑` });
      continue;
    }
    const at = Date.parse(String(c.at ?? ""));
    if (!Number.isFinite(at) || now - at > CANARY_MAX_AGE_MS || at - now > 5 * 60_000) {
      failing.push({ projectId: p, why: `最新 canary 的时间 ${String(c.at)} 超过 24 小时或无法解析 ⇒ 须重跑` });
    }
  }
  return { ok: failing.length === 0, failing };
}
