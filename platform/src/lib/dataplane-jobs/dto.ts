// @kf-batch 50-WP9a-durable-jobs
// 作业的**对外形态**(WORK-PACKAGES WP-9 ④-1 的第三模式:DTO 允许列表)。
//
// 🔴 **允许列表,不是删除列表**:一条一条**拷**允许的字段,而不是 `{...row}` 再 `delete row.lease`。
//    删除列表的写法会在下一次有人往行上加字段(比如 9b 加个 `backupManifestKey`)时**默认透出**;
//    允许列表的写法下新字段默认不出去,要出去必须有人在这里显式加一行(并过单测)。
// 🔴 永不进响应:`lease` / `runToken` / `revision` / `state`(含已提交的 statementId 与审计 id)/ `idempotencyKey` / `ttl`。
//    单测 `dataplane-jobs-assembly.test.ts` 用一行**塞满所有内部字段**的行过 DTO,断言 JSON 里一个都找不到。
import type { JobKind, JobPhase } from "@/lib/dataplane-jobs/schema";
import type { DataplaneJobRow } from "@/lib/dataplane-jobs/model";

/** 供给作业的证据(每一步的结果;不含任何口令 / ARN / 审计 id)。 */
export interface SupplyEvidence {
  steps: Array<{ step: string; ok: boolean; note?: string }>;
  /** per-project secret 的**名字**(派生自 SSOT,不是 ARN) */
  secretName?: string;
  secretCreated?: boolean;
}

/** canary 七条之一的结果。 */
export type CanaryOutcome = "pass" | "fail" | "unverifiable";
export interface CanaryCheckEvidence {
  id: "C-1" | "C-2" | "C-3" | "C-4" | "C-5" | "C-6" | "C-7";
  outcome: CanaryOutcome;
  /** 人话说明(已脱敏;不含 SQL 原文) */
  detail: string;
}
export interface CanaryEvidence {
  verdict?: CanaryOutcome;
  /** 结果绑定的凭证世代(进 isolated 的前置要求 = 当前 epoch) */
  credentialEpoch?: number;
  /** 判定完成时间(ISO;前置要求 ≤ 24h) */
  at?: string;
  checks?: CanaryCheckEvidence[];
  /** 整组不可判的原因(如:该项目没有 per-project 凭证) */
  reason?: string;
}

/**
 * @kf-batch 50-project-delete-orphans
 * 凭证回收作业的证据:删的是**哪个名字**、在**哪个区**、结论是什么(不含 ARN / 口令)。
 * `outcome`:`deleted` 本次删掉了 · `absent` 确认本来就没有(该区从没给这个项目供给过)。
 */
export interface ReclaimEvidence {
  secretName?: string;
  region?: string;
  outcome?: "deleted" | "absent";
}

/** 序 58 B-130:平台自建安全组清理作业的证据(sgId / 区 / 最近一次看到的网卡数 / 收口结论)。 */
export interface SgCleanupEvidence {
  sgId?: string;
  region?: string;
  datasourceId?: string;
  eniCount?: number;
  outcome?: "deleted" | "gone" | "skipped-not-platform" | "needs-manual";
}
const SG_CLEANUP_OUTCOMES = new Set(["deleted", "gone", "skipped-not-platform", "needs-manual"]);

interface PublicJobBase {
  jobId: string;
  targetId: string;
  projectId?: string;
  phase: JobPhase;
  progress: { done: number; total: number; label?: string };
  lastError?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export type PublicJob =
  | (PublicJobBase & { kind: "supply"; evidence: SupplyEvidence })
  | (PublicJobBase & { kind: "canary"; evidence: CanaryEvidence })
  | (PublicJobBase & { kind: "reclaim"; evidence: ReclaimEvidence })
  | (PublicJobBase & { kind: "sg-cleanup"; evidence: SgCleanupEvidence });

const CANARY_IDS = new Set(["C-1", "C-2", "C-3", "C-4", "C-5", "C-6", "C-7"]);
const OUTCOMES = new Set(["pass", "fail", "unverifiable"]);

function str(v: unknown, max = 500): string | undefined {
  return typeof v === "string" ? v.slice(0, max) : undefined;
}

function supplyEvidenceOf(ev: Record<string, unknown>): SupplyEvidence {
  const steps = Array.isArray(ev.steps) ? ev.steps : [];
  return {
    steps: steps.slice(0, 50).map((s) => {
      const o = (s ?? {}) as Record<string, unknown>;
      return { step: str(o.step, 64) ?? "?", ok: o.ok === true, ...(str(o.note, 200) ? { note: str(o.note, 200) } : {}) };
    }),
    ...(str(ev.secretName, 256) ? { secretName: str(ev.secretName, 256) } : {}),
    ...(typeof ev.secretCreated === "boolean" ? { secretCreated: ev.secretCreated } : {}),
  };
}

function canaryEvidenceOf(ev: Record<string, unknown>): CanaryEvidence {
  const checks = Array.isArray(ev.checks) ? ev.checks : [];
  return {
    ...(typeof ev.verdict === "string" && OUTCOMES.has(ev.verdict) ? { verdict: ev.verdict as CanaryOutcome } : {}),
    ...(typeof ev.credentialEpoch === "number" ? { credentialEpoch: ev.credentialEpoch } : {}),
    ...(str(ev.at, 40) ? { at: str(ev.at, 40) } : {}),
    ...(str(ev.reason) ? { reason: str(ev.reason) } : {}),
    checks: checks
      .map((c) => (c ?? {}) as Record<string, unknown>)
      .filter((c) => typeof c.id === "string" && CANARY_IDS.has(c.id) && typeof c.outcome === "string" && OUTCOMES.has(c.outcome))
      .map((c) => ({
        id: c.id as CanaryCheckEvidence["id"],
        outcome: c.outcome as CanaryOutcome,
        detail: str(c.detail, 300) ?? "",
      })),
  };
}

const RECLAIM_OUTCOMES = new Set(["deleted", "absent"]);
function reclaimEvidenceOf(ev: Record<string, unknown>): ReclaimEvidence {
  return {
    ...(str(ev.secretName, 256) ? { secretName: str(ev.secretName, 256) } : {}),
    ...(str(ev.region, 32) ? { region: str(ev.region, 32) } : {}),
    ...(typeof ev.outcome === "string" && RECLAIM_OUTCOMES.has(ev.outcome) ? { outcome: ev.outcome as "deleted" | "absent" } : {}),
  };
}

function sgCleanupEvidenceOf(ev: Record<string, unknown>): SgCleanupEvidence {
  return {
    ...(str(ev.sgId, 64) ? { sgId: str(ev.sgId, 64) } : {}),
    ...(str(ev.region, 32) ? { region: str(ev.region, 32) } : {}),
    ...(str(ev.datasourceId, 64) ? { datasourceId: str(ev.datasourceId, 64) } : {}),
    ...(typeof ev.eniCount === "number" && Number.isFinite(ev.eniCount) ? { eniCount: ev.eniCount } : {}),
    ...(typeof ev.outcome === "string" && SG_CLEANUP_OUTCOMES.has(ev.outcome) ? { outcome: ev.outcome as SgCleanupEvidence["outcome"] } : {}),
  };
}

/** 作业行 → 对外形态(判别联合;种类不认识就抛 —— 不许把未知形态的行原样透出)。 */
export function toPublicJob(row: DataplaneJobRow): PublicJob {
  const base: PublicJobBase = {
    jobId: row.jobId,
    targetId: row.targetId,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    phase: row.phase,
    progress: {
      done: Number(row.progress?.done ?? 0),
      total: Number(row.progress?.total ?? 0),
      ...(str(row.progress?.label, 64) ? { label: str(row.progress?.label, 64) } : {}),
    },
    ...(str(row.lastError) ? { lastError: str(row.lastError) } : {}),
    attempts: Number(row.attempts ?? 0),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: str(row.createdBy, 200) ?? "",
  };
  const ev = (row.evidence ?? {}) as Record<string, unknown>;
  const kind: JobKind = row.kind;
  switch (kind) {
    case "supply":
      return { ...base, kind, evidence: supplyEvidenceOf(ev) };
    case "canary":
      return { ...base, kind, evidence: canaryEvidenceOf(ev) };
    case "reclaim":
      return { ...base, kind, evidence: reclaimEvidenceOf(ev) };
    case "sg-cleanup":
      return { ...base, kind, evidence: sgCleanupEvidenceOf(ev) };
    default: {
      const never: never = kind;
      throw new Error(`未知作业种类 ${String(never)} ⇒ 拒绝透出`);
    }
  }
}
