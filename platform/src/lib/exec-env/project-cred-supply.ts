// per-project 凭证的**供给层**(50 SPEC §3.9b「进 `isolated` 的前置」+ 52 SPEC §3.4)。
//
// 这一层是 目的本身:把「target 上每个在用项目都有自己的 Redshift 身份」
// 从合同文字变成可执行的一串步骤,并给状态机的 `isolated` 前置提供**服务端能自证的那部分**证据。
//
// 🔴 **步骤顺序不是风格,是依赖**;而且这个顺序被**真环境改过两次**,两次都是真跑才发现:
//   ⓪ `create-shared-schema`  —— ④/⑤ 的 `GRANT … ON SCHEMA shared` 需要它先存在;
//   ① `create-role`           —— ⑤ 要把它授给登录用户;
//   ② `provisionProjectLogin` —— 建登录用户 + 写 per-project secret(口令全程不出那个函数);
//   ③ `create-project-schema` —— 🔴 它的 `ALTER SCHEMA … OWNER TO` 指向**登录用户**,故必须排在 ② 后;
//   ④ `grant-role-to-login`   —— 用户必须先存在才能把 role 授给它;
//   ⑤ `grant`                 —— 给 role 授 schema/shared 权限(schema 已建)。
//
// 🔴 **第一版把 ③ 排在 ② 前面,真环境当场报 `ERROR: user "role_proj_…" does not exist`** ——
// 根因不在顺序而在模板:`ALTER SCHEMA … OWNER TO` 原来指向 **role**,而 Redshift 的 schema 属主
// **必须是 user**(role 不能当属主)。模板已修(见 `admin-ddl-templates.ts` 同处注释),
// 顺序随之调整。留这段话是因为:光看代码看不出"为什么 login 要排在 schema 前面"。
//
// 🔴 **幂等**:Redshift **没有** `CREATE ROLE IF NOT EXISTS`(schema 有、role 没有)。
// 所以重跑供给时 ① 必然报 "already exists"。这是本仓唯一一处**按错误文本判幂等**的地方,
// 理由写在 `isAlreadyExists` 上 —— 不这样做,重跑供给就必然失败,而供给是需要能重跑的
// (部分失败后补跑、轮换口令、新增项目)。

import { getTargetRaw } from "@/lib/exec-env/registry";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { isHome } from "@/lib/exec-env/target-id";
import { assertProjectId, projectSecretName } from "@/lib/exec-env/project-schema";
import { listAllProjects } from "@/lib/projects/project-service";
import { describeSecretArnByName, resolveTargetWarehouse } from "@/lib/exec-env/target-clients";
import {
  AdminDdlDenied,
  provisionProjectLogin,
  settleAdminDdl,
  submitAdminDdl,
  systemActor,
  type AdminDdlSubmission,
  type AuthenticatedActor,
} from "@/lib/exec-env/admin-ddl-executor";
// 供给作业化(handler 接口 + 入队;写表只经 store)
import { pollWithin, type JobHandler, type StepContext, type StepResult } from "@/lib/dataplane-jobs/handler";
import { createJob, getJob } from "@/lib/dataplane-jobs/store";
import {
  INLINE_POLL_BUDGET_MS,
  WAIT_POLL_MS,
  dataplaneJobId,
  isTerminalPhase,
  type DataplaneJobRow,
} from "@/lib/dataplane-jobs/model";

/** 资源行所在的四张表(与 `monitor/run-owner.ts` 的 `OWNER_TABLES` 同一组,别再列第五张)。 */
const RESOURCE_TABLES: readonly string[] = [
  TABLES.SYNC_TASKS,
  TABLES.WORKFLOWS,
  TABLES.ETL_JOBS,
  TABLES.ENGINE_JOBS,
];
const USER_ID = "default-user"; // 单租户分区键(与各 by-id 路由一致)

// 🔴 原来这里是同步入口 `provisionProjectCredential`(一个请求里六步原地跑完)。
//   它唯一的生产调用方 `POST .../provision-credentials` 已改成 202 + 作业 id(跨区 504 的根治),
//   留着它 = 一份没有调用方、而且与作业 handler 各写一遍步骤序的代码(两个作者)。⇒ 删除;
//   步骤序的唯一作者是下面的 `SUPPLY_STEPS`,执行体是 `supplyJobHandler`(门禁见 project-cred-supply.test.ts)。

/**
 * 「已存在」类错误。
 *
 * 🔴 **本仓唯一一处按错误文本判幂等**,理由:Redshift 的 `CREATE ROLE` **没有** `IF NOT EXISTS`
 * 变体(`CREATE SCHEMA` 有),而 Redshift 也不支持 `DO` 块,所以"先查再建"要多一次
 * 查询 + 仍有竞态。判据刻意收得很窄(必须同时出现"已存在"的语义词),
 * 且只在**明确标了 `tolerate`** 的步骤上生效 —— 不是全局吞异常。
 */
export function isAlreadyExists(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e).toLowerCase();
  return /already exists|已存在|duplicate_object/.test(m);
}

/**
 * 该 target 上「在用项目」的清单(§3.9b 进 `isolated` 的前置要按它逐个核凭证)。
 *
 * 🔴 **如实说明口径来源**:52/50 的项目台账里**没有** project→target 绑定字段
 * (`Project` 只有 id/name/owner/时间戳;绑定作为一等概念落地)。
 * 所以这里的口径是从**现实**推的,而不是编一个字段:
 *   · **home**:当前架构下每个项目的默认执行落点就是 home ⇒ 全部项目都算在用。
 *     宁可**多算** —— 多算只会让 `isolated` 的门更严,少算才会放过没凭证的项目。
 *   · **非 home**:扫四张资源表,取显式盖了该 `targetId` 的行的 `projectId`
 *     (`targetId` 是 W2-a 给运行记录盖章时同一维;资源行上缺省即 home)。
 */
export async function listProjectsWithBindings(targetId: string): Promise<string[]> {
  const all = await listAllProjects();
  const known = new Set(all.map((p) => p.projectId));
  if (isHome(targetId)) return Array.from(known).sort();

  const found = new Set<string>();
  for (const table of RESOURCE_TABLES) {
    let startKey: Record<string, unknown> | undefined;
    // 🔴 必须翻页:单页就返回 = 静默漏项目(DDB 单次 Query 上限 1MiB),
    //    而漏掉的项目正是"没凭证却被放行进 isolated"的那一类。
    for (let page = 0; page < 100; page++) {
      const r: { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> } =
        await docClient.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: "userId = :u",
            ExpressionAttributeValues: { ":u": USER_ID },
            ...(startKey ? { ExclusiveStartKey: startKey } : {}),
          })
        );
      for (const item of r.Items ?? []) {
        if (String(item.targetId ?? "") !== targetId) continue;
        const pid = item.projectId ? String(item.projectId) : "";
        if (pid && known.has(pid)) found.add(pid);
      }
      startKey = r.LastEvaluatedKey;
      if (!startKey) break;
    }
  }
  return Array.from(found).sort();
}

export interface CredentialVerification {
  /** 确认有 per-project secret 的项目 */
  present: string[];
  /** 确认**没有**的项目(DescribeSecret 明确 ResourceNotFound) */
  missing: string[];
  /** 🔴 **无法核实**的项目(读失败 / 形态不符)—— 非空即不得进 isolated */
  unverifiable: Array<{ projectId: string; why: string }>;
}

/**
 * 逐项目核 per-project 凭证是否真的存在。
 *
 * 🔴 三分而不是二分(`present` / `missing` / **`unverifiable`**)是本函数的全部意义:
 * 「查不到 ≠ 没问题」。把读失败塞进 `missing` 会让运维以为"补上这几个就能切",
 * 塞进 `present` 更糟(直接放行一个其实没凭证的项目,切 isolated 后它整个不可用)。
 * ⇒ 单独一栏,并由调用方(credential-state 端点)在它非空时**拒绝**前进。
 */
export async function verifyProjectCredentials(
  targetId: string,
  projectIds: string[]
): Promise<CredentialVerification> {
  const t = await getTargetRaw(targetId);
  if (!t) throw new Error(`执行目标不存在:${targetId}`);
  const { region } = resolveTargetWarehouse(t);

  const out: CredentialVerification = { present: [], missing: [], unverifiable: [] };
  for (const projectId of projectIds) {
    let name: string;
    try {
      name = projectSecretName(targetId, projectId);
    } catch (e) {
      // 连名字都派生不出来(projectId 形态非法)⇒ 无法核实,绝不当"没有"。
      out.unverifiable.push({ projectId, why: `派生 secret 名失败:${(e as Error)?.message ?? String(e)}` });
      continue;
    }
    try {
      const arn = await describeSecretArnByName(region, name);
      if (arn) out.present.push(projectId);
      else out.missing.push(projectId);
    } catch (e) {
      out.unverifiable.push({ projectId, why: `DescribeSecret 失败:${(e as Error)?.message ?? String(e)}` });
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// 供给**作业化**
// ══════════════════════════════════════════════════════════════════════════════
//
// 🔴 为什么:`provisionProjectCredential` 是同步的 —— 一个 HTTP 请求里 N 个项目 × ~10 条语句,
//    每条原地轮询到终态。跨区时直接撞 ALB 504(② 第 2 行),而且**断在中间没有任何记录**:
//    重点一次就从头再来(口令再轮换一遍)。作业化之后:
//    · 每个 (target, project) 一条作业,确定性 jobId ⇒ 双击 / 重放只入队一条;
//    · 每一步做完就存档(步骤游标 + 已提交的 statementId),进程被杀后接着做**下一步**,
//      已完成的步骤不重做(🔴 尤其 `provision-login` —— 重做 = 口令再轮换一次 = 「重建」);
//    · DDL 步走 `submitAdminDdl` / `settleAdminDdl` 两段式:一步只提交或只读一次终态。

/**
 * 供给的步骤序 —— **唯一作者**(同步入口 `provisionProjectCredential` 与作业 handler 都按它走)。
 * 顺序 = 依赖顺序(见文件头 ⓪–⑤ 的说明;真环境改过两次)。
 */
export const SUPPLY_STEPS = [
  { step: "create-shared-schema", kind: "ddl", tolerateExists: false },
  { step: "create-role", kind: "ddl", tolerateExists: true },
  { step: "provision-login", kind: "login", tolerateExists: false },
  { step: "create-project-schema", kind: "ddl", tolerateExists: false },
  { step: "grant-role-to-login", kind: "ddl", tolerateExists: false },
  { step: "grant", kind: "ddl", tolerateExists: false },
  { step: "verify", kind: "verify", tolerateExists: false },
] as const;

type SupplyStepName = (typeof SUPPLY_STEPS)[number]["step"];

function supplyRequestOf(step: SupplyStepName, targetId: string, projectId: string): Record<string, string> {
  switch (step) {
    case "create-shared-schema":
      return { operation: "create-shared-schema", targetId };
    case "create-role":
    case "create-project-schema":
    case "grant-role-to-login":
    case "grant":
      return { operation: step, targetId, projectId };
    default:
      throw new Error(`供给步骤 ${step} 不是 DDL 步`);
  }
}

/** 作业私有 state(不进 DTO)。 */
interface SupplyState {
  stepIndex: number;
  /** 已提交、还没读到终态的那一步 */
  pending?: AdminDdlSubmission;
  /** 以谁的名义执行(入队时定;systemActor 或真人管理员)*/
  runAs: AuthenticatedActor;
  steps: Array<{ step: string; ok: boolean; note?: string }>;
  secretName?: string;
  secretCreated?: boolean;
}

function supplyStateOf(raw: Record<string, unknown>): SupplyState {
  const s = raw as unknown as SupplyState;
  if (!s || typeof s.stepIndex !== "number" || !s.runAs || typeof s.runAs.actor !== "string") {
    throw new Error("供给作业的 state 形态不对(缺 stepIndex / runAs)⇒ 拒绝推进");
  }
  return { ...s, steps: Array.isArray(s.steps) ? s.steps : [] };
}

function supplyEvidenceOf(s: SupplyState): Record<string, unknown> {
  return {
    steps: s.steps,
    ...(s.secretName ? { secretName: s.secretName } : {}),
    ...(typeof s.secretCreated === "boolean" ? { secretCreated: s.secretCreated } : {}),
  };
}

function supplyProgress(s: SupplyState) {
  const cur = SUPPLY_STEPS[s.stepIndex];
  return { done: Math.min(s.stepIndex, SUPPLY_STEPS.length), total: SUPPLY_STEPS.length, ...(cur ? { label: cur.step } : {}) };
}

/** 「确定不可恢复」的拒绝:RBAC / 交叉验证 / 请求非法 —— 重试也一样被拒。 */
function isDefinitive(e: unknown): boolean {
  if (e instanceof AdminDdlDenied) return ["2-cross-verify", "4-rbac", "5-template"].includes(e.step);
  return (e as { name?: string })?.name === "AdminDdlRequestInvalid";
}

export const supplyJobHandler: JobHandler = {
  async step(ctx: StepContext): Promise<StepResult> {
    const job = ctx.job;
    const projectId = assertProjectId(job.projectId);
    const s = supplyStateOf(job.state);
    const out = (next: StepResult["next"], st: SupplyState = s): StepResult => ({
      state: st as unknown as Record<string, unknown>,
      progress: supplyProgress(st),
      evidence: supplyEvidenceOf(st),
      next,
    });
    const cur = SUPPLY_STEPS[s.stepIndex];
    if (!cur) return out({ kind: "succeeded" });
    const advance = (note?: string): StepResult => {
      const st: SupplyState = {
        ...s,
        pending: undefined,
        stepIndex: s.stepIndex + 1,
        steps: [...s.steps, { step: cur.step, ok: true, ...(note ? { note } : {}) }],
      };
      delete st.pending;
      return out(st.stepIndex >= SUPPLY_STEPS.length ? { kind: "succeeded" } : { kind: "continue" }, st);
    };

    try {
      if (cur.kind === "ddl") {
        if (s.pending) {
          const pending = s.pending;
          const r = await pollWithin(() => settleAdminDdl(pending), ctx, INLINE_POLL_BUDGET_MS);
          if (r.state === "running") return out({ kind: "wait", delayMs: WAIT_POLL_MS });
          if (r.state === "succeeded") return advance();
          // 失败:先清掉 pending(下次重新提交),再决定是不是「已存在 = 幂等成功」
          const cleared: SupplyState = { ...s };
          delete cleared.pending;
          if (cur.tolerateExists && isAlreadyExists(r.error)) {
            return advance("已存在(幂等跳过)");
          }
          return out({ kind: "retry", reason: `第「${cur.step}」步失败:${r.error}` }, cleared);
        }
        const submission = await submitAdminDdl(s.runAs, supplyRequestOf(cur.step, job.targetId, projectId));
        return out({ kind: "continue" }, { ...s, pending: submission });
      }
      if (cur.kind === "login") {
        // 🔴 同步一小步(两条短语句 + 写 secret);已完成就不会再进这里(步骤游标已越过)
        const login = await provisionProjectLogin(s.runAs, { targetId: job.targetId, projectId });
        const st: SupplyState = { ...s, secretName: login.secretName, secretCreated: login.created };
        const r = { ...st, stepIndex: s.stepIndex + 1, steps: [...s.steps, { step: cur.step, ok: true }] };
        return out({ kind: "continue" }, r);
      }
      // verify:写得进去 ≠ 是对的 —— 回读确认 secret 真存在
      const v = await verifyProjectCredentials(job.targetId, [projectId]);
      if (v.present.includes(projectId)) return advance();
      const why = v.missing.includes(projectId)
        ? "供给完成后回读:per-project secret 不存在"
        : `供给完成后回读:无法核实(${v.unverifiable.map((u) => u.why).join("; ")})`;
      return out({ kind: "retry", reason: why });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (isDefinitive(e)) return out({ kind: "failed", reason: `第「${cur.step}」步被拒(不可重试):${msg}` });
      return out({ kind: "retry", reason: `第「${cur.step}」步出错:${msg}` });
    }
  },
};

/** 每个 (target, project) 最多尝试几代供给作业(防止无界地找下一代 id)。 */
const MAX_SUPPLY_GENERATIONS = 50;

export interface EnqueueSupplyResult {
  jobId: string;
  /** 本次是否新建(false = 已有在途 / 已成功的那一条) */
  created: boolean;
  phase: string;
}

/**
 * 给 (target, project) 入队一条供给作业。
 *
 * 幂等键 = 「第几代」(`g1`, `g2`, …):
 *   · 最新一代**未终态** ⇒ 直接返回它(双击 / 重放 / 两个副本同时补队都不会多一条);
 *   · 最新一代已终态:`force=true`(人点的「供给凭证」)⇒ 开下一代;`force=false`(自动补队)⇒ 原样返回,
 *     🔴 自动路径**不对失败的作业无限重开**(失败要人看见、人决定;作业内部已有有界重试)。
 */
export async function enqueueSupplyJob(
  targetId: string,
  projectId: string,
  opts: { runAs: AuthenticatedActor; force: boolean; now?: number }
): Promise<EnqueueSupplyResult> {
  const pid = assertProjectId(projectId);
  const now = opts.now ?? Date.now();
  let latest: DataplaneJobRow | null = null;
  let gen = 1;
  for (; gen <= MAX_SUPPLY_GENERATIONS; gen++) {
    const row = await getJob(dataplaneJobId("supply", targetId, pid, `g${gen}`));
    if (!row) break;
    latest = row;
  }
  if (latest && (!isTerminalPhase(latest.phase) || !opts.force)) {
    return { jobId: latest.jobId, created: false, phase: latest.phase };
  }
  if (gen > MAX_SUPPLY_GENERATIONS) {
    throw new Error(`(${targetId}, ${projectId}) 的供给作业已达 ${MAX_SUPPLY_GENERATIONS} 代 ⇒ 拒绝再开(请先排查为什么反复失败)`);
  }
  const state: SupplyState = { stepIndex: 0, runAs: opts.runAs, steps: [] };
  const r = await createJob({
    kind: "supply",
    targetId,
    projectId: pid,
    subject: pid,
    idempotencyKey: `g${gen}`,
    createdBy: opts.runAs.actor,
    state: state as unknown as Record<string, unknown>,
    progress: { done: 0, total: SUPPLY_STEPS.length, label: SUPPLY_STEPS[0].step },
    now,
  });
  return { jobId: r.job.jobId, created: r.created, phase: r.job.phase };
}

/** 自动补队要看的执行环境:凭证状态在供给窗口或稳态里(legacy-seeded 的存量 home 由人按 ④-7 的序手动供给)。 */
const AUTO_SUPPLY_STATES: ReadonlySet<string> = new Set(["provisioning", "isolated"]);

export interface SweepSummary {
  /** 开关关着(缺省)⇒ true 且其余全 0:什么都没扫、什么都没入队(见 `dataplaneAutoSupplyEnabled`) */
  disabled?: true;
  targets: number;
  enqueued: number;
  existing: number;
  errors: Array<{ targetId: string; projectId?: string; error: string }>;
}

/**
 * 「绑定即自动供给」(⑨-6,systemActor)。
 *
 * 🔴 为什么是周期补队、而不是在每个「建任务」的路由里各插一句入队:绑定没有一等概念 ——
 *    「在用项目」是从四张资源表推出来的(`listProjectsWithBindings` 是唯一口径)。在每个写入点插入队 =
 *    N 个作者各自判断「这算不算绑定」,漏一个就是那一类资源的项目永远没人供给。周期补队只问那一个口径。
 * 🔴 一个执行环境 / 一个项目出错不影响其余(逐个 try/catch),错误原样回报,不吞。
 */
export async function sweepAutoSupply(now: number = Date.now()): Promise<SweepSummary> {
  const { listTargetsRaw } = await import("@/lib/exec-env/registry");
  const out: SweepSummary = { targets: 0, enqueued: 0, existing: 0, errors: [] };
  const { dataplaneAutoSupplyEnabled } = await import("@/lib/dataplane-jobs/schema");
  if (!dataplaneAutoSupplyEnabled()) return { ...out, disabled: true };
  const runAs = systemActor("dataplane-auto-supply");
  for (const t of await listTargetsRaw()) {
    const state = (t as { credentialIsolationState?: string }).credentialIsolationState;
    if (!state || !AUTO_SUPPLY_STATES.has(state)) continue;
    out.targets++;
    let projects: string[];
    try {
      projects = await listProjectsWithBindings(t.targetId);
    } catch (e) {
      out.errors.push({ targetId: t.targetId, error: String((e as Error)?.message ?? e) });
      continue;
    }
    for (const projectId of projects) {
      try {
        const r = await enqueueSupplyJob(t.targetId, projectId, { runAs, force: false, now });
        if (r.created) out.enqueued++;
        else out.existing++;
      } catch (e) {
        out.errors.push({ targetId: t.targetId, projectId, error: String((e as Error)?.message ?? e) });
      }
    }
  }
  return out;
}
