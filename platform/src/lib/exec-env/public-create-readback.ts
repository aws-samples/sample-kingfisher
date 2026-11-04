// `revoke-public-create` 的**收口回读**(台账)。
//
// 🔴 为什么要有这一步:2026-10-14 第三十七轮硬门 MIG-CN-5 —— 撤 PUBLIC 在 public 上的 CREATE 回 200 之后**立刻**复跑 canary,
//   C-6(项目身份在 public 建表)仍然建成;12h 后单独复跑 8/8 绿、目录里 `nspacl={…,=U/rdsdb,…}`、`has_schema_privilege=false`。
//   2026-10-15 真环境勘定(…4400 tgt_usw2_a):REVOKE 到终态的瞬间目录就翻了,项目身份首次尝试(+5s)已被拒 ⇒ 窗口若存在在 5s 以内。
//   「语句到终态」≠「别的身份已经看见」。所以 200 的含义改成:**项目登录身份自己回读到 public 对它已无 CREATE**,
//   回读不到就如实 502(读不到 ≠ 一致),绝不把「REVOKE 执行完了」当成「撤权已生效」。
//
// 回读用**项目自己的 secret**(与 canary 同一纪律:只有它的视角才证明得了隔离);同一条语句里同时拿
//   · 目录真值 `pg_namespace.nspacl`(PUBLIC 的条目 = 以 `=` 开头的那段,含 C 即仍有 CREATE)
//   · 当前登录身份的有效判定 `has_schema_privilege('public','create')`
// 两者都为「否」才算收口。这里只 SELECT 目录,不建任何探针对象(建表留残留的教训见 permission-canary C-6)。
import { describeStatementState, firstScalar, submitStatements, type StatementPlace } from "@/lib/dataplane-jobs/statement";
import { listProjectsWithBindings } from "@/lib/exec-env/project-cred-supply";
import { lookupProjectSecretArn } from "@/lib/exec-env/project-secret";
import { resolveTargetWarehouse } from "@/lib/exec-env/target-clients";
import type { ExecutionTarget } from "@/lib/exec-env/registry";

/** 回读语句(单条;nspacl 为 NULL 时按空 ACL 处理 —— 空 ACL 对 PUBLIC 没有任何授权)。 */
export const PUBLIC_CREATE_READBACK_SQL =
  "SELECT COALESCE(nspacl::text, '') || '|' || has_schema_privilege('public', 'create')::text FROM pg_namespace WHERE nspname = 'public'";
/** 总预算(含语句本身的等待):REVOKE ≈ 2–3s + 回读 ≤ 20s,整个请求仍在 ALB 60s 之内。 */
export const PUBLIC_CREATE_READBACK_BUDGET_MS = 20_000;
/** 两次回读之间的间隔。 */
export const PUBLIC_CREATE_READBACK_POLL_MS = 1_000;

/**
 * nspacl 文本里 PUBLIC 的条目是否含 CREATE。
 * 形如 `{rdsdb=UCDA/rdsdb,=UC/rdsdb,shared_writer=U/rdsdb}`:每段 `grantee=privs/grantor`,PUBLIC 的 grantee 为空(段以 `=` 开头)。
 * 带引号的 grantee(`"a b"=U/x`)不是 PUBLIC;没有 PUBLIC 段 / 空 ACL ⇒ 没有 CREATE。
 */
export function publicEntryHasCreate(nspacl: string): boolean {
  const inner = String(nspacl ?? "").trim().replace(/^\{/, "").replace(/\}$/, "");
  if (!inner) return false;
  for (const raw of inner.split(",")) {
    const entry = raw.trim();
    if (!entry.startsWith("=")) continue;
    const privs = entry.slice(1).split("/")[0] ?? "";
    return privs.includes("C");
  }
  return false;
}

export interface PublicCreateReadback {
  nspacl: string;
  /** 目录:PUBLIC 条目仍含 C */
  publicHasCreate: boolean;
  /** 有效判定:回读身份自己 has_schema_privilege('public','create') */
  effectiveHasCreate: boolean;
  /** 两者都为否 = 收口 */
  revoked: boolean;
}

/** 解析回读标量 `<nspacl>|<true/false>`;形态不对就抛(不许把解析失败当成「已撤」)。 */
export function parsePublicCreateReadback(scalar: string): PublicCreateReadback {
  const i = String(scalar ?? "").lastIndexOf("|");
  if (i < 0) throw new Error(`回读结果形态不对(缺 | 分隔):${JSON.stringify(scalar)}`);
  const nspacl = scalar.slice(0, i);
  const eff = scalar.slice(i + 1).trim().toLowerCase();
  if (eff !== "true" && eff !== "false") throw new Error(`回读结果 has_schema_privilege 不是布尔:${JSON.stringify(eff)}`);
  const publicHasCreate = publicEntryHasCreate(nspacl);
  const effectiveHasCreate = eff === "true";
  return { nspacl, publicHasCreate, effectiveHasCreate, revoked: !publicHasCreate && !effectiveHasCreate };
}

export type ReadbackOutcome =
  | { settled: true; attempts: number; waitedMs: number; last: PublicCreateReadback }
  | { settled: false; attempts: number; waitedMs: number; last?: PublicCreateReadback; error?: string };

/**
 * 以给定身份(项目 secret)反复回读,直到收口或预算用尽。
 * 预算是**总**预算:语句排队 / 执行 / 间隔都算在内;超了就如实返回 `settled:false`(带最后一次读到的样子)。
 */
export async function awaitPublicCreateRevoked(args: {
  place: StatementPlace;
  secretArn: string;
  statementName?: string;
  budgetMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ReadbackOutcome> {
  const budget = args.budgetMs ?? PUBLIC_CREATE_READBACK_BUDGET_MS;
  const poll = args.pollMs ?? PUBLIC_CREATE_READBACK_POLL_MS;
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();
  let attempts = 0;
  let last: PublicCreateReadback | undefined;
  let error: string | undefined;
  for (;;) {
    attempts++;
    try {
      const id = await submitStatements({ place: args.place, sqls: [PUBLIC_CREATE_READBACK_SQL], secretArn: args.secretArn, statementName: args.statementName });
      let st = await describeStatementState(args.place.region, id);
      while (st.state === "running" && now() - start < budget) {
        await sleep(Math.min(poll, 300));
        st = await describeStatementState(args.place.region, id);
      }
      if (st.state === "finished") {
        last = parsePublicCreateReadback(await firstScalar(args.place.region, id));
        error = undefined;
        if (last.revoked) return { settled: true, attempts, waitedMs: now() - start, last };
      } else if (st.state === "failed") {
        error = st.error;
      } else {
        error = "回读语句未在预算内到终态";
      }
    } catch (e) {
      error = (e as Error)?.message ?? String(e);
    }
    if (now() - start >= budget) return { settled: false, attempts, waitedMs: now() - start, ...(last ? { last } : {}), ...(error ? { error } : {}) };
    await sleep(poll);
  }
}

export type ProjectReadbackResult =
  | { verified: true; projectId: string; outcome: Extract<ReadbackOutcome, { settled: true }> }
  | { verified: false; unsettled: true; projectId: string; outcome: Extract<ReadbackOutcome, { settled: false }> }
  | { verified: false; unsettled: false; reason: string };

/** 协作方(同目录兄弟模块)按依赖注入进来 —— 与 isolation-prereqs 的 PrereqDeps 同一做法:测试不 vi.mock 兄弟模块,改传假协作方;默认值 = 真函数(有身份判据钉着)。 */
export interface ReadbackDeps {
  listProjectsWithBindings: (targetId: string) => Promise<string[]>;
  lookupProjectSecretArn: (t: ExecutionTarget, projectId: string) => Promise<string | undefined>;
  resolveTargetWarehouse: (t: ExecutionTarget) => StatementPlace;
}
export const DEFAULT_READBACK_DEPS: ReadbackDeps = { listProjectsWithBindings, lookupProjectSecretArn, resolveTargetWarehouse };

/**
 * 用该执行环境上**第一个有 per-project 凭证的在用项目**的身份回读。
 * 没有任何项目带凭证 ⇒ 回读做不了(canary 同样跑不了),如实返回 `verified:false`,**不**冒充已验证。
 * 返回值里没有 secret / ARN。
 */
export async function readbackPublicCreateRevokedAsProject(
  target: ExecutionTarget,
  opts?: { statementName?: string; budgetMs?: number; pollMs?: number },
  deps: ReadbackDeps = DEFAULT_READBACK_DEPS
): Promise<ProjectReadbackResult> {
  const projects = await deps.listProjectsWithBindings(target.targetId);
  for (const projectId of projects) {
    const secretArn = await deps.lookupProjectSecretArn(target, projectId);
    if (!secretArn) continue;
    const outcome = await awaitPublicCreateRevoked({
      place: deps.resolveTargetWarehouse(target),
      secretArn,
      statementName: opts?.statementName,
      budgetMs: opts?.budgetMs,
      pollMs: opts?.pollMs,
    });
    return outcome.settled ? { verified: true, projectId, outcome } : { verified: false, unsettled: true, projectId, outcome };
  }
  return {
    verified: false,
    unsettled: false,
    reason: projects.length
      ? `${projects.length} 个在用项目都还没有 per-project 凭证 ⇒ 无法用项目身份回读(canary 同样跑不了;先供给)`
      : "该执行环境上没有在用项目 ⇒ 无可回读的身份",
  };
}
