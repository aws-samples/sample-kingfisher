// @kf-batch 52-P52.5a-supply
// 🔴 **闭合 admin-DDL 执行器**(50 SPEC §3.9a v3.3,用户拍板 B)—— P0-4 的真正关闭点。
//
// ── 这个文件把什么从"地基"变成"边界" ──────────────────────────────────────────
// G2R 交付了结构化请求(`admin-ddl-request.ts`)+ 私有模板(`admin-ddl-templates.ts`)+
// defense-in-depth lint(`admin-ddl-guards.ts`),但**没有执行器** ⇒ 那三件的文件头都如实写着
// 「P0-4 仍未关闭」「真正的边界是 §3.9a 的闭合执行器,**它还没落地**」。
// 原因很实在:TS 的 branded type 挡不住 `as unknown as`,所以"SQL 只能由模板产生"这句话
// 在没有执行器之前只是**约定**;只有当**唯一能执行 admin SQL 的函数**同时满足
// 「SQL 自己生成 + 凭证自己取 + 两者之间没有调用方插手的缝」时,它才是边界。
//
// ── 九步固定序(§3.9a 原文,不可重排)────────────────────────────────────────
//   1) runtime schema 校验结构化 request(不是 TS 强转)
//   2) 服务端解析并**交叉验证** target / project / 资源归属(不只信 header/body)
//   3) **强一致**校验 target ready / status / credentialEpoch(§3.9b)
//   4) 按 operation 做 RBAC / 审批 / 绑定数 / lifecycle 前置校验
//   5) 私有模板生成 SQL(逐条过 lint)
//   6) 写**执行意图**审计;审计失败**立即拒绝**(fail-closed-on-audit)
//   7) 函数内部读该 target 的 admin secret —— 禁 return、禁进对外缓存、禁写日志
//   8) 在**该 target 的** workgroup/database 执行;**禁 IAM fallback**
//   9) 写成功/失败结果审计,返回非敏感结果
// 🔴 顺序里有两处是**语义**不是风格:审计在执行**之前**(6 在 8 前),凭证在校验**之后**(7 在 4 后)。
//    把 6 挪到 8 后 = 执行了但可能没有记录;把 7 提到 4 前 = 校验没过也已经把凭证取出来了。
//
// ── 🔴 口令为什么走第二个入口而不是模板 ──────────────────────────────────────
// `admin-ddl-templates.ts` 早已定案:「口令**不进模板**:模板产物会进审计,口令绝不能落审计/日志」。
// 我一度想给模板加 `create-project-login` 并把生成的口令塞进 `VerifiedAdminDdlContext` ——
// 那与上面这条直接冲突,已撤销。定案:
//   · **纯权限**语句(`GRANT ROLE … TO …`,零字面量)= 正常 operation `grant-role-to-login`;
//   · **建用户 + 设口令 + 写 secret** = 本文件的第二个公开入口 `provisionProjectLogin()`:
//     语句由**本文件私有**的 builder 产出、**不铸 branded**、**不进审计明细**、错误文本先脱敏;
//     口令**从生成到写入 Secrets Manager 全程不出这个函数**(所以也就不存在"返回口令"的接口面)。
//
// @kf-batch 50-WP11b-shared-writer —— 第三个公开入口 `provisionSharedWriter()`(SPEC §3.9d.4):每个 target 一个
//   窄权写者 `shared_writer`,与 `provisionProjectLogin` 同形态、同纪律(口令不出函数、不进模板 / 审计 / 返回值)。
//
// 🔴 **返回面封闭**:本模块任何导出都不返回 secret 明文 / admin secret ARN / 口令。
//    `provisionProjectLogin` 返回的 `secretArn` 是**该项目自己的** secret 的 ARN(供给层要把它
//    写进描述符/校验存在性),不是 admin 凭证;口令不在返回值里。有可执行门禁钉住这条。

import { randomBytes } from "node:crypto";
import {
  parseAdminDdlRequest,
  type AdminDdlRequest,
  type ResolvedModelingObject,
  type VerifiedAdminDdlContext,
} from "@/lib/exec-env/admin-ddl-request";
// @kf-batch 50-WP11b-shared-writer —— 窄权写者身份名的唯一作者
import { sharedWriterSecretName, sharedWriterUserName } from "@/lib/modeling/landing-fqn";
import { buildAdminDdlStatements } from "@/lib/exec-env/admin-ddl-templates";
import { lintGeneratedStatement, sqlSkeleton } from "@/lib/exec-env/admin-ddl-guards";
import { withSchemaCreateRetry } from "@/lib/redshift/concurrent-schema";
import { requireCredentialIsolationState } from "@/lib/exec-env/privileged-cred";
import { requireReadyTarget, type ExecutionTarget } from "@/lib/exec-env/registry";
// @kf-batch 50-WP31-place-first-class(序 31 第二刀 ① = B-98)
// 🔴 本文件是**第二条**数据面执行通道(建模码表落地 / 维表应用 DDL 的非主控区一跳走这里,不走 resolveRedshiftBinding),
//   原来只做准入、不记落点决策 ⇒ 请求上下文里只有主控区那一条决策 ⇒ observe 观测器把本就该落到第二区的
//   redshift-data / secretsmanager 调用判成 cross-region(第三十九 / 四十轮各 16 / 12 条,全部 = B-98);
//   序 31 第二刀 enforce(SDK middleware 越区即抛)一开,这条路会被**误拦**。⇒ 准入之后、执行之前记一笔决策。
import { notePlaceDecision } from "@/lib/place/context";

/** 本通道在落点决策账本里的署名(观测清单按它归类;判据按它过滤)。 */
export const ADMIN_DDL_PLACE_VIA = "admin-ddl-executor";
import {
  projectDbUserName,
  projectSchema,
  projectSecretName,
  assertProjectId,
} from "@/lib/exec-env/project-schema";
import {
  execOnTarget,
  putSecretJson,
  resolveTargetEndpoint,
  resolveTargetWarehouse,
  type TargetWarehouse,
} from "@/lib/exec-env/target-clients";
import { writeAuditRecord, writeAuditRecordOnce, type AuditActorRef } from "@/lib/audit";
// @kf-batch 50-WP9a-durable-jobs —— 两段式入口的提交 / 读终态原语(不改 target-clients.ts;客户端走唯一工厂)
import { describeStatementState, submitStatements } from "@/lib/dataplane-jobs/statement";
import { getApproval, getProject } from "@/lib/projects/project-service";
import type { Identity } from "@/lib/auth/identity";

/**
 * 执行 admin-DDL 的**行为主体**(§3.9a 的 `actor`)。
 *
 * 🔴 刻意**不收 `NextRequest`**:执行器会被无请求上下文的路径调用(后台供给、DAG)。
 * 但也刻意**不允许匿名**:`actor` 必须是非空串,`isPlatformAdmin` 必须由调用方显式给出 ——
 * 「没传就当不是管理员」是唯一安全的缺省,而不是「没传就跳过 RBAC」。
 */
export interface AuthenticatedActor extends AuditActorRef {
  isPlatformAdmin: boolean;
}

/** 把路由拿到的 `Identity` 转成执行器的 actor(单一转换点,免得每个路由各拼一遍)。 */
export function actorFromIdentity(identity: Identity): AuthenticatedActor {
  return {
    actor: identity.email || identity.username || identity.sub,
    actorSub: identity.sub,
    ...(identity.email ? { email: identity.email } : {}),
    isPlatformAdmin: identity.isPlatformAdmin,
  };
}

/**
 * 平台自身发起的系统 actor(供给层的后台流程用)。
 *
 * 🔴 它**是**平台管理员级别的主体 —— 这一点必须显式写出来而不是藏在某个 `?? true` 里。
 * 唯一构造点在这里,便于审计里一眼认出"这是系统干的"以及 grep 出全部使用处。
 */
export function systemActor(reason: string): AuthenticatedActor {
  if (!reason || reason.trim().length < 4) {
    throw new Error("systemActor 必须写明用途(它是管理员级主体,审计里要能看出是哪条后台流程发起的)");
  }
  return { actor: `system:${reason}`, isPlatformAdmin: true };
}

export class AdminDdlDenied extends Error {
  constructor(
    /** 九步里的哪一步拒的 —— 排障时最想知道的信息 */
    readonly step: string,
    message: string
  ) {
    super(message);
    this.name = "AdminDdlDenied";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 第 4 步:每个 operation 的 RBAC / 审批要求(**穷尽表**,新增 operation 编译期就会缺项)
// ──────────────────────────────────────────────────────────────────────────────

interface OperationPolicy {
  /** 需要平台管理员(bgp-admin)。 */
  requirePlatformAdmin: boolean;
  /** 需要一张**真实存在且已批准**的审批单(破坏性操作)。 */
  requireApproval: boolean;
  /** 审计动作名后缀(审计分类;§3.9a「新增 operation 时强制补:模板 + RBAC + 审计分类 + 测试」)。 */
  auditKind: "schema" | "role" | "grant" | "destructive" | "bootstrap" | "code-table" | "model-table" | "modeling-drop" | "canary";
}

/**
 * 🔴 全部 operation 目前都要求平台管理员。
 *
 * **这不是把功能做窄**:这 8 个 operation 现在**一个生产调用方都没有**(G2R 起就是无副作用地基),
 * 本批的调用方是供给层的 `systemActor`。将来 `land-code-table` 接到建模页时,
 * 它需要的是"项目 owner + 该码表属 modeling-global"这样的窄规则 ——
 * 那条规则要和真实调用点一起落(P52.5b / P50.3),**现在写一个猜的规则等于给自己一个假门**。
 * 所以这里的口径是:**先全部收紧到管理员**,接线时按调用点逐个放开并补测。
 */
const OPERATION_POLICY: Record<AdminDdlRequest["operation"], OperationPolicy> = {
  "create-project-schema": { requirePlatformAdmin: true, requireApproval: false, auditKind: "schema" },
  "create-shared-schema": { requirePlatformAdmin: true, requireApproval: false, auditKind: "schema" },
  "create-role": { requirePlatformAdmin: true, requireApproval: false, auditKind: "role" },
  grant: { requirePlatformAdmin: true, requireApproval: false, auditKind: "grant" },
  "grant-role-to-login": { requirePlatformAdmin: true, requireApproval: false, auditKind: "grant" },
  "drop-project-schema": { requirePlatformAdmin: true, requireApproval: true, auditKind: "destructive" },
  "dms-ingest-bootstrap": { requirePlatformAdmin: true, requireApproval: false, auditKind: "bootstrap" },
  "land-code-table": { requirePlatformAdmin: true, requireApproval: false, auditKind: "code-table" },
  // @kf-batch 50-WP11b-shared-writer —— 建模页的落地 / 解绑路由本就只许平台管理员(路由层 403),这里同口径。
  //   drop-landed-table 不走审批单:它的有损确认是路由层的机制 A(逐字确认串 FORCE-REBUILD / 物理表名)。
  "grant-shared-writer": { requirePlatformAdmin: true, requireApproval: false, auditKind: "grant" },
  "land-model-table": { requirePlatformAdmin: true, requireApproval: false, auditKind: "model-table" },
  // @kf-batch 50-SEQ47c-catalog-ddl —— 图形化改表:同建表口径(平台管理员);删列的不可逆确认与 prod 审批都是路由层机制,不在这里二次设门
  "alter-model-table": { requirePlatformAdmin: true, requireApproval: false, auditKind: "model-table" },
  "drop-landed-table": { requirePlatformAdmin: true, requireApproval: false, auditKind: "modeling-drop" },
  // @kf-batch 50-WP9a-durable-jobs —— permission canary(WP-9 ④-3);两条都只由平台管理员 / systemActor 发起
  "create-canary-probes": { requirePlatformAdmin: true, requireApproval: false, auditKind: "canary" },
  "revoke-public-create": { requirePlatformAdmin: true, requireApproval: false, auditKind: "grant" },
};

/** 允许给 `drop-project-schema` 放行的审批单类型(白名单,不接受任意 type)。 */
const DROP_APPROVAL_TYPES: readonly string[] = ["project-delete", "project-schema-drop"] as const;

// ──────────────────────────────────────────────────────────────────────────────
// 第 7 步:admin 凭证 —— **本文件私有**,永不导出
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 该 target 的 admin secret ARN。
 *
 * 🔴 **刻意不导出、也刻意不放到 `privileged-cred.ts`**:那个模块的文件头写着
 * 「本模块不导出任何返回 Secret / SecretArn 的 admin 路径」,并且有单测钉住它的导出面。
 * admin 凭证的**唯一**用途就是本文件第 8 步的那一次 `ExecuteStatement`,所以它就该住在这里、
 * 且没有出口。
 * 🔴 **不进任何缓存**:§3.9b 的缓存规则是给 project-context 写的;admin 凭证根本不该有缓存槽。
 */
function adminSecretArnOf(t: ExecutionTarget): string {
  const arn = (t.resources ?? {})["redshiftSecretArn"];
  if (typeof arn !== "string" || !arn.startsWith("arn:")) {
    throw new AdminDdlDenied(
      "7-credential",
      `target ${t.targetId} 的描述符里没有可用的 redshiftSecretArn —— 拒绝执行。` +
        `§3.9a 第 8 步禁 IAM fallback:解析不到凭证就拒,绝不省略 SecretArn 退回联邦身份` +
        `(那会造成表属主分叉 —— P52.1-L1 修过的病)`
    );
  }
  return arn;
}

// ──────────────────────────────────────────────────────────────────────────────
// 公开入口 ①:executeAdminDdl
// ──────────────────────────────────────────────────────────────────────────────

export interface AdminDdlResult {
  affected: number;
  auditId: string;
}

/**
 * 九步里 1–6 的**共同前半段**(同步入口 `executeAdminDdl` 与两段式入口 `submitAdminDdl` 共用)。
 *
 * @kf-batch 50-WP9a-durable-jobs —— 🔴 为什么抽出来而不是在 submit 里再写一遍:两份前半段 = 两份 RBAC /
 *   两份审批 / 两份 lint,漂移一处就是「同步入口拒的东西,异步入口放行」。抽成一个私有函数,
 *   两个入口的差别只剩第 8 步「原地等终态」还是「只提交」。顺序与原实现逐行一致(6 在 7 之前,7 在 4 之后)。
 */
async function prepareAdminDdl(actor: AuthenticatedActor, input: unknown) {
  assertActor(actor);

  // ── 1) runtime 校验(不是 TS 强转)────────────────────────────────────────
  const request = parseAdminDdlRequest(input);
  const policy = OPERATION_POLICY[request.operation];
  if (!policy) {
    // parseAdminDdlRequest 已经把 operation 收进枚举了;走到这里说明策略表漏了一项。
    throw new AdminDdlDenied("4-rbac", `operation=${request.operation} 没有登记 RBAC 策略 ⇒ 拒绝执行`);
  }

  // ── 2) 交叉验证 target / project(**不只信 body**)───────────────────────
  const ctxProjectId = "projectId" in request ? (request as { projectId: string }).projectId : undefined;
  if (ctxProjectId) {
    const project = await getProject(ctxProjectId);
    if (!project) {
      throw new AdminDdlDenied(
        "2-cross-verify",
        `projectId=${ctxProjectId} 在项目台账里不存在 ⇒ 拒绝。` +
          `body 里的 id 只是**声称**,服务端必须自己核一遍(§3.9a 第 2 步)`
      );
    }
  }

  // @kf-batch 50-WP11b-shared-writer —— 🔴 建模类 operation 的**台账成员资格**(SPEC §3.9d.7(a))
  //   codeTableId → 码表台账、modelTableId → 模型表台账,**查不到即拒**。对象属于哪一类由它来自哪本台账决定
  //   (编不出来),业务表压根不在这两本台账里 ⇒「禁业务表进平台全局 schema」原样成立。
  //   落点 / 列也只从这里取(模板不认 request 里的任何名字)。
  const modelingObject = await resolveModelingObject(request);

  // ── 3) 强一致读 target + 准入 + 凭证隔离状态 ─────────────────────────────
  const target = await requireReadyTarget(request.targetId); // ConsistentRead + 整包校验 + 可服务性
  // B-98:准入**之后**才记(被拒的请求不许被归到某个区),执行**之前**记(第 8 步的每次数据面调用都要能归因)
  notePlaceDecision({ targetId: target.targetId, via: ADMIN_DDL_PLACE_VIA });
  const iso = requireCredentialIsolationState(target); // 缺状态/未知即抛,绝不隐式当 legacy

  // ── 4) RBAC / 审批 / lifecycle 前置 ─────────────────────────────────────
  if (policy.requirePlatformAdmin && !actor.isPlatformAdmin) {
    throw new AdminDdlDenied(
      "4-rbac",
      `operation=${request.operation} 需要平台管理员(bgp-admin);actor=${actor.actor} 不是 ⇒ 拒绝`
    );
  }
  if (policy.requireApproval) {
    await assertApprovedFor(request, ctxProjectId);
  }

  // ── 5) 私有模板生成 SQL + 逐条自检 ──────────────────────────────────────
  const context: VerifiedAdminDdlContext = {
    targetId: target.targetId,
    ...(ctxProjectId ? { projectId: ctxProjectId, projectSchemaName: projectSchema(ctxProjectId) } : {}),
    credentialEpoch: iso.epoch,
    ...(modelingObject ? { modelingObject } : {}),
  };
  const statements = buildAdminDdlStatements(request, context);
  for (const sql of statements) {
    // 🔴 有项目维的 operation **必须**把 projectId 传进 lint —— 少了它,归属校验形同不存在。
    lintGeneratedStatement(sql, ctxProjectId ? { projectId: ctxProjectId } : undefined);
  }

  // ── 6) 执行意图审计;写不进去就拒 ───────────────────────────────────────
  const auditBase = {
    resourceType: "exec-env-admin-ddl",
    resourceId: `${target.targetId}#${request.operation}`,
  };
  const intentDetail = {
    operation: request.operation,
    auditKind: policy.auditKind,
    targetId: target.targetId,
    ...(ctxProjectId ? { projectId: ctxProjectId } : {}),
    ...(modelingObject ? { modelingObject: { kind: modelingObject.kind, id: modelingObjectId(modelingObject) } } : {}),
    credentialIsolationState: iso.state,
    credentialEpoch: iso.epoch,
    statementCount: statements.length,
    // 🔴 只写**骨架**(字面量已被 mask):§3.9b「不记 secret / 口令 / 完整敏感 SQL」。
    sqlSkeletons: statements.map((s) => sqlSkeleton(s)),
  };
  let auditId: string;
  try {
    auditId = await writeAuditRecord(actor, "exec-env.admin-ddl.intent", { ...auditBase, detail: intentDetail });
  } catch (e) {
    throw new AdminDdlDenied(
      "6-audit",
      `执行意图审计写入失败 ⇒ 拒绝执行 admin-DDL(fail-closed-on-audit):` +
        `${(e as Error)?.message ?? String(e)}。一次没有审计记录的权限边界变更,事后无法复盘"当时凭什么放行"`
    );
  }
  return { request, target, statements, auditBase, intentDetail, auditId };
}

export async function executeAdminDdl(actor: AuthenticatedActor, input: unknown): Promise<AdminDdlResult> {
  const { target, statements, auditBase, intentDetail, auditId } = await prepareAdminDdl(actor, input);

  // ── 7) 函数内部取 admin 凭证(不 return、不缓存、不打日志)────────────────
  const secretArn = adminSecretArnOf(target);
  // ── 8) 在该 target 的 workgroup/database 执行 ───────────────────────────
  const warehouse = resolveTargetWarehouse(target);
  let affected = 0;
  try {
    for (const sql of statements) {
      // 🔴 并发安全:`create-project-schema` / `create-shared-schema` 两个模板都以
      //   `CREATE SCHEMA IF NOT EXISTS` 开头,而它在 Redshift **不是原子的** ——
      //   两个项目同时供给就会有一个撞 `pg_namespace_nspname_index`(见 lib/redshift/concurrent-schema.ts)。
      //   包装器只对「幂等 schema 创建 + 并发签名」重试;别的语句一次都不重试。
      const r = await withSchemaCreateRetry(sql, () => execOnTarget({ warehouse, sql, secretArn }));
      affected += r.affected;
    }
  } catch (e) {
    // ── 9) 失败也要写结果审计(失败记录同样是复盘证据)──────────────────
    await writeAuditRecord(actor, "exec-env.admin-ddl.failed", {
      ...auditBase,
      detail: { ...intentDetail, intentAuditId: auditId, error: redactSql(String((e as Error)?.message ?? e)) },
    }).catch(() => {});
    throw e;
  }

  // ── 9) 成功结果审计 ────────────────────────────────────────────────────
  await writeAuditRecord(actor, "exec-env.admin-ddl.done", {
    ...auditBase,
    detail: { ...intentDetail, intentAuditId: auditId, affected },
  }).catch(() => {});

  // 🔴 返回值里没有 secret / ARN / 口令(§3.9a 原文)。
  return { affected, auditId };
}

// ──────────────────────────────────────────────────────────────────────────────
// @kf-batch 50-WP9a-durable-jobs
// 公开入口 ④⑤:submitAdminDdl / settleAdminDdl —— 两段式(50 SPEC §3.9a 合同差分 ③-1)
// ──────────────────────────────────────────────────────────────────────────────
//
// 🔴 为什么要两段式:`executeAdminDdl` 第 8 步原地轮询到终态(≤~3 分钟)。一个请求里供给 N 个项目 ×
//    ~10 条语句,跨区就撞 ALB 504;9b 的大表复制更是一条语句就可能跑几十分钟。作业化之后,
//    一步只「提交」或「读一次终态」,中间进程可以重启、可以换副本。
// 🔴 九步 1–7 与同步入口**同一个函数**(prepareAdminDdl),第 8 步只提交;第 9 步(结果审计)挪到
//    `settleAdminDdl` 读到终态时写,并且**恰好一次**(作业重做读终态那一步不会多一条审计)。

/**
 * 提交凭据。🔴 里面**没有** secret / ARN / SQL —— 它会被存进作业行的私有 `state`(不进 DTO),
 * 下一步凭它读终态。actor 一并记下:结果审计必须记在**发起者**名下,而不是某个后台副本。
 */
export interface AdminDdlSubmission {
  auditId: string;
  targetId: string;
  operation: AdminDdlRequest["operation"];
  statementIds: string[];
  region: string;
  actor: string;
  actorSub?: string;
  submittedAt: string;
}

export async function submitAdminDdl(actor: AuthenticatedActor, input: unknown): Promise<AdminDdlSubmission> {
  const { request, target, statements, auditBase, intentDetail, auditId } = await prepareAdminDdl(actor, input);
  // ── 7) 函数内部取 admin 凭证(不 return、不缓存、不打日志)────────────────
  const secretArn = adminSecretArnOf(target);
  // ── 8') 只提交:多条语句走一个 Batch(一个事务,失败整批回滚 ⇒ 重试不会留下半套状态)──
  const warehouse = resolveTargetWarehouse(target);
  let statementId: string;
  try {
    statementId = await submitStatements({
      place: { region: warehouse.region, workgroup: warehouse.workgroup, database: warehouse.database },
      sqls: statements,
      secretArn,
      statementName: auditId,
    });
  } catch (e) {
    await writeAuditRecord(actor, "exec-env.admin-ddl.failed", {
      ...auditBase,
      detail: { ...intentDetail, intentAuditId: auditId, phase: "submit", error: redactSql(String((e as Error)?.message ?? e)) },
    }).catch(() => {});
    throw e;
  }
  return {
    auditId,
    targetId: target.targetId,
    operation: request.operation,
    statementIds: [statementId],
    region: warehouse.region,
    actor: actor.actor,
    ...(actor.actorSub ? { actorSub: actor.actorSub } : {}),
    submittedAt: new Date().toISOString(),
  };
}

export type AdminDdlSettlement =
  | { state: "running" }
  | { state: "succeeded"; affected: number; auditId: string }
  | { state: "failed"; error: string; auditId: string };

/**
 * 读一次终态;到了终态就写结果审计(**恰好一次**:排序键 = `<意图审计 id>#settled`,重做被条件写挡掉)。
 * 🔴 失败文本先脱敏再返回(会进作业行 lastError → 页面)。
 * 🔴 结果审计写不进去 ⇒ **抛**(不回 succeeded):没有结果记录的执行,作业不许宣称完成;下一轮重读重写。
 */
export async function settleAdminDdl(submission: AdminDdlSubmission): Promise<AdminDdlSettlement> {
  if (!submission?.auditId || !Array.isArray(submission.statementIds) || submission.statementIds.length === 0) {
    throw new AdminDdlDenied("9-settle", "settleAdminDdl:提交凭据不完整(缺 auditId / statementIds)⇒ 拒绝当成任何一种结论");
  }
  // B-98:收口发生在**另一个请求**(轮询 / 泵)里,它对 submission.region 的 redshift-data 读也要能归因
  notePlaceDecision({ targetId: submission.targetId, via: ADMIN_DDL_PLACE_VIA });
  let affected = 0;
  for (const id of submission.statementIds) {
    const s = await describeStatementState(submission.region, id);
    if (s.state === "running") return { state: "running" };
    if (s.state === "failed") {
      const error = redactSql(s.error);
      await writeSettlementAudit(submission, "exec-env.admin-ddl.failed", { error });
      return { state: "failed", error, auditId: submission.auditId };
    }
    affected += s.affected;
  }
  await writeSettlementAudit(submission, "exec-env.admin-ddl.done", { affected });
  return { state: "succeeded", affected, auditId: submission.auditId };
}

async function writeSettlementAudit(
  s: AdminDdlSubmission,
  action: "exec-env.admin-ddl.done" | "exec-env.admin-ddl.failed",
  extra: Record<string, unknown>
): Promise<void> {
  await writeAuditRecordOnce(
    { actor: s.actor, ...(s.actorSub ? { actorSub: s.actorSub } : {}) },
    action,
    {
      resourceType: "exec-env-admin-ddl",
      resourceId: `${s.targetId}#${s.operation}`,
      detail: {
        operation: s.operation,
        targetId: s.targetId,
        intentAuditId: s.auditId,
        statementIds: s.statementIds,
        mode: "two-phase",
        ...extra,
      },
    },
    `${s.auditId}#settled`
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// 公开入口 ②:provisionProjectLogin —— 建登录用户 + 设口令 + 写 secret
// ──────────────────────────────────────────────────────────────────────────────

export interface ProjectLoginResult {
  /** per-project secret 的名字(派生自 SSOT,不是这里编的) */
  secretName: string;
  /** **该项目自己的** secret 的 ARN(不是 admin 凭证);供给层要拿它做存在性校验 */
  secretArn: string;
  /** 该 secret 是本次新建(true)还是轮换了既有值(false) */
  created: boolean;
  auditId: string;
}

/**
 * 为某个项目在某个 target 上准备**登录身份**:建用户(或轮换口令)→ 写 per-project secret。
 *
 * 🔴 口令的生命周期**完全在本函数内**:生成 → 进 SQL → 进 Secrets Manager → 变量出栈。
 * 它不进返回值、不进审计、不进日志、不进模板注册表、不进 branded 语句。
 * 审计里只有一个**固定脱敏描述符** `create-login:<user>@<target>`。
 *
 * 🔴 复用九步里的 1–4、6–9,只有第 5 步(SQL 来源)不同:语句由本文件私有 builder 产出。
 * 这是**刻意的偏离**,理由见文件头;偏离已回灌 52 DESIGN §13bis,不留"代码与合同各说各话"。
 */
export async function provisionProjectLogin(
  actor: AuthenticatedActor,
  args: { targetId: string; projectId: string }
): Promise<ProjectLoginResult> {
  assertActor(actor);
  const projectId = assertProjectId(args.projectId);

  // 2) 交叉验证:项目必须真存在
  if (!(await getProject(projectId))) {
    throw new AdminDdlDenied("2-cross-verify", `projectId=${projectId} 在项目台账里不存在 ⇒ 拒绝建登录身份`);
  }
  // 3) 强一致读 target + 准入 + 隔离状态
  const target = await requireReadyTarget(args.targetId);
  notePlaceDecision({ targetId: target.targetId, via: ADMIN_DDL_PLACE_VIA }); // B-98
  const iso = requireCredentialIsolationState(target);
  // 4) RBAC:建登录身份是特权动作,一律要求平台管理员(供给层用 systemActor)
  if (!actor.isPlatformAdmin) {
    throw new AdminDdlDenied("4-rbac", `建项目登录身份需要平台管理员;actor=${actor.actor} 不是 ⇒ 拒绝`);
  }

  const warehouse = resolveTargetWarehouse(target);
  const userName = projectDbUserName(projectId);
  const secretName = projectSecretName(target.targetId, projectId);
  // 🔴 **固定脱敏描述符** —— 审计里出现的是这一行,不是 SQL。
  const descriptor = `create-login:${userName}@${target.targetId}`;

  const auditBase = { resourceType: "exec-env-admin-ddl", resourceId: `${target.targetId}#provision-login` };
  const intentDetail = {
    operation: "provision-project-login",
    auditKind: "credential" as const,
    targetId: target.targetId,
    projectId,
    credentialIsolationState: iso.state,
    credentialEpoch: iso.epoch,
    descriptor,
    secretName,
  };
  // 6) 意图审计 fail-closed
  let auditId: string;
  try {
    auditId = await writeAuditRecord(actor, "exec-env.admin-ddl.provision-login.intent", {
      ...auditBase,
      detail: intentDetail,
    });
  } catch (e) {
    throw new AdminDdlDenied(
      "6-audit",
      `执行意图审计写入失败 ⇒ 拒绝建项目登录身份(fail-closed-on-audit):${(e as Error)?.message ?? String(e)}`
    );
  }

  // 7) admin 凭证(函数内部)
  const secretArn = adminSecretArnOf(target);
  // 端点先解析:半份 secret 会通过"存在性"检查却不可用(写得进去 ≠ 是对的)。
  const endpoint = await resolveTargetEndpoint(warehouse);

  // 8) 执行 —— 🔴 语句含口令字面量,**全程包在脱敏 try 里**
  const password = generateRedshiftPassword();
  try {
    await execLoginStatements(warehouse, secretArn, userName, password);
    const put = await putSecretJson(warehouse.region, secretName, {
      engine: "redshift",
      username: userName,
      password,
      host: endpoint.host,
      port: endpoint.port,
      dbname: warehouse.database,
      workgroupName: warehouse.workgroup,
      region: warehouse.region,
      targetId: target.targetId,
      projectId,
    });
    // 9) 结果审计
    await writeAuditRecord(actor, "exec-env.admin-ddl.provision-login.done", {
      ...auditBase,
      detail: { ...intentDetail, intentAuditId: auditId, secretCreated: put.created },
    }).catch(() => {});
    return { secretName, secretArn: put.arn, created: put.created, auditId };
  } catch (e) {
    const safe = redactSql(String((e as Error)?.message ?? e));
    await writeAuditRecord(actor, "exec-env.admin-ddl.provision-login.failed", {
      ...auditBase,
      detail: { ...intentDetail, intentAuditId: auditId, error: safe },
    }).catch(() => {});
    // 🔴 抛出去的也必须是脱敏后的文本:错误会进日志/HTTP 响应,原文可能带回语句片段。
    throw new AdminDdlDenied("8-execute", `建项目登录身份失败(${descriptor}):${safe}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 公开入口 ③:provisionSharedWriter —— 建窄权写者 + 设口令 + 写 secret(@kf-batch 50-WP11b-shared-writer)
// ──────────────────────────────────────────────────────────────────────────────

export interface SharedWriterResult {
  /** 窄权写者 secret 的名字(派生自 SSOT `sharedWriterSecretName`) */
  secretName: string;
  /** 本次新建(true)还是轮换了既有值(false) */
  created: boolean;
  auditId: string;
}

/**
 * 为某个 target 准备**窄权写者** `shared_writer`:建用户(或轮换口令)→ 写 `bgp/shared-writer/<slug>`。
 *
 * 🔴 与 `provisionProjectLogin` **逐字同一条纪律**(SPEC §3.9d.1 / §3.9d.4):
 *  · 口令生命周期完全在本函数内:生成 → 进 SQL → 进 Secrets Manager → 出栈;不进返回值 / 审计 / 日志 / 模板 / branded;
 *  · 审计只写固定脱敏描述符 `create-shared-writer:<user>@<target>`;错误文本先脱敏再抛;
 *  · 幂等:用户已存在 ⇒ `ALTER USER … PASSWORD`(轮换),不报错。
 * 🔴 **只建用户、不授任何权**:它能写什么,完全由 `grant-shared-writer` 逐表决定(闭合式)。
 * 🔴 **返回值里没有 secretArn**(SPEC §3.9d.4):调用方要 ARN 就按名自己 Describe —— 名字由 SSOT 派生,
 *    再递一份 ARN 只是一份会漂的副本(与「不进描述符资源袋」同一条理由)。
 */
export async function provisionSharedWriter(
  actor: AuthenticatedActor,
  args: { targetId: string }
): Promise<SharedWriterResult> {
  assertActor(actor);
  // 3) 强一致读 target + 准入 + 隔离状态
  const target = await requireReadyTarget(args.targetId);
  notePlaceDecision({ targetId: target.targetId, via: ADMIN_DDL_PLACE_VIA }); // B-98
  const iso = requireCredentialIsolationState(target);
  // 4) RBAC:建登录身份是特权动作,一律要求平台管理员
  if (!actor.isPlatformAdmin) {
    throw new AdminDdlDenied("4-rbac", `建窄权写者身份需要平台管理员;actor=${actor.actor} 不是 ⇒ 拒绝`);
  }

  const warehouse = resolveTargetWarehouse(target);
  const userName = sharedWriterUserName();
  const secretName = sharedWriterSecretName(target.targetId);
  const descriptor = `create-shared-writer:${userName}@${target.targetId}`;

  const auditBase = { resourceType: "exec-env-admin-ddl", resourceId: `${target.targetId}#provision-shared-writer` };
  const intentDetail = {
    operation: "provision-shared-writer",
    auditKind: "credential" as const,
    targetId: target.targetId,
    credentialIsolationState: iso.state,
    credentialEpoch: iso.epoch,
    descriptor,
    secretName,
  };
  // 6) 意图审计 fail-closed
  let auditId: string;
  try {
    auditId = await writeAuditRecord(actor, "exec-env.admin-ddl.provision-shared-writer.intent", {
      ...auditBase,
      detail: intentDetail,
    });
  } catch (e) {
    throw new AdminDdlDenied(
      "6-audit",
      `执行意图审计写入失败 ⇒ 拒绝建窄权写者身份(fail-closed-on-audit):${(e as Error)?.message ?? String(e)}`
    );
  }

  // 7) admin 凭证(函数内部)
  const secretArn = adminSecretArnOf(target);
  // 端点先解析:半份 secret 会通过"存在性"检查却不可用(写得进去 ≠ 是对的)。
  const endpoint = await resolveTargetEndpoint(warehouse);

  // 8) 执行 —— 🔴 语句含口令字面量,**全程包在脱敏 try 里**
  const password = generateRedshiftPassword();
  try {
    await execLoginStatements(warehouse, secretArn, userName, password);
    const put = await putSecretJson(warehouse.region, secretName, {
      engine: "redshift",
      username: userName,
      password,
      host: endpoint.host,
      port: endpoint.port,
      dbname: warehouse.database,
      workgroupName: warehouse.workgroup,
      region: warehouse.region,
      targetId: target.targetId,
      purpose: "shared-writer",
    });
    // 9) 结果审计
    await writeAuditRecord(actor, "exec-env.admin-ddl.provision-shared-writer.done", {
      ...auditBase,
      detail: { ...intentDetail, intentAuditId: auditId, secretCreated: put.created },
    }).catch(() => {});
    return { secretName, created: put.created, auditId };
  } catch (e) {
    const safe = redactSql(String((e as Error)?.message ?? e));
    await writeAuditRecord(actor, "exec-env.admin-ddl.provision-shared-writer.failed", {
      ...auditBase,
      detail: { ...intentDetail, intentAuditId: auditId, error: safe },
    }).catch(() => {});
    throw new AdminDdlDenied("8-execute", `建窄权写者身份失败(${descriptor}):${safe}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 私有件
// ──────────────────────────────────────────────────────────────────────────────

/**
 * @kf-batch 50-WP11b-shared-writer —— 第 2 步的建模台账成员资格(SPEC §3.9d.7(a))。
 * 非建模类 operation ⇒ undefined。台账模块**动态** import:`modeling/landing.ts` 反过来要调本执行器,
 * 静态 import 会成环。
 */
async function resolveModelingObject(request: AdminDdlRequest): Promise<ResolvedModelingObject | undefined> {
  let kind: "code-table" | "model-table";
  let id: string;
  switch (request.operation) {
    case "land-code-table":
    case "grant-shared-writer":
      kind = "code-table";
      id = request.codeTableId;
      break;
    case "land-model-table":
    case "alter-model-table":
      kind = "model-table";
      id = request.modelTableId;
      break;
    case "drop-landed-table":
      kind = request.kind;
      id = request.objectId;
      break;
    default:
      return undefined;
  }
  if (kind === "code-table") {
    const { getCodeTable } = await import("@/lib/modeling/service");
    const ct = await getCodeTable(id);
    if (!ct) {
      throw new AdminDdlDenied(
        "2-cross-verify",
        `codeTableId=${id} 在码表台账里查不到 ⇒ 拒绝(只有码表台账里的对象才能落进平台全局 schema;业务表不在这本台账里)`
      );
    }
    return { kind, codeTableId: ct.codeTableId, code: ct.code };
  }
  const { getModelTable } = await import("@/lib/modeling/dimensions");
  const mt = await getModelTable(id);
  if (!mt) {
    throw new AdminDdlDenied(
      "2-cross-verify",
      `modelTableId=${id} 在模型表台账里查不到 ⇒ 拒绝(只有建模台账里的维度/事实表才能由这条通道建表)`
    );
  }
  return {
    kind,
    modelTableId: mt.modelTableId,
    schema: mt.schema,
    physicalTable: mt.physicalTable,
    columns: mt.columns,
    // @kf-batch 50-SEQ47c-catalog-ddl —— 改表计划随台账行带给模板(没有就是 undefined,模板会拒)
    ...(mt.pendingAlter ? { pendingAlter: mt.pendingAlter } : {}),
  };
}

function modelingObjectId(o: ResolvedModelingObject): string {
  return o.kind === "code-table" ? o.codeTableId : o.modelTableId;
}

function assertActor(actor: AuthenticatedActor): void {
  if (!actor || typeof actor.actor !== "string" || !actor.actor.trim()) {
    throw new AdminDdlDenied("4-rbac", "admin-DDL 必须带具名 actor(审计要求可归因;匿名一律拒)");
  }
  if (typeof actor.isPlatformAdmin !== "boolean") {
    // 「没传就当不是管理员」听起来更宽容,但那会让调用方漏传时**静默降级成不鉴权的路径**。
    throw new AdminDdlDenied("4-rbac", "actor.isPlatformAdmin 必须显式给出(布尔);缺省即拒");
  }
}

async function assertApprovedFor(request: AdminDdlRequest, projectId: string | undefined): Promise<void> {
  const approvalId = (request as { approvalId?: string }).approvalId;
  if (!approvalId) {
    throw new AdminDdlDenied("4-rbac", `operation=${request.operation} 是破坏性操作,必须带 approvalId`);
  }
  const approval = await getApproval(approvalId);
  if (!approval) {
    throw new AdminDdlDenied(
      "4-rbac",
      `审批单 ${approvalId} 不存在 ⇒ 拒绝。**带了一个单号**与**这个单号真的批过**是两件事`
    );
  }
  if (approval.status !== "approved") {
    throw new AdminDdlDenied("4-rbac", `审批单 ${approvalId} 状态为 ${approval.status},不是 approved ⇒ 拒绝`);
  }
  if (projectId && approval.projectId !== projectId) {
    throw new AdminDdlDenied(
      "4-rbac",
      `审批单 ${approvalId} 属于项目 ${approval.projectId},与请求的 ${projectId} 不符 ⇒ 拒绝` +
        `(否则拿 A 项目批过的单子去删 B 项目的 schema)`
    );
  }
  if (!DROP_APPROVAL_TYPES.includes(approval.type)) {
    throw new AdminDdlDenied(
      "4-rbac",
      `审批单 ${approvalId} 的类型 ${approval.type} 不在破坏性操作白名单内(${DROP_APPROVAL_TYPES.join("/")})⇒ 拒绝` +
        `(否则一张成员加入的审批单就能当删库许可)`
    );
  }
}

/**
 * Redshift 登录口令。
 *
 * 形态保证(Redshift 要求 8–64 位、含大写/小写/数字):首 `Kf` 给大小写、尾 `7` 给数字,
 * 中间是 24 字节随机 base64url(**字符集 `A-Za-z0-9-_`,不含单引号/反斜杠**⇒ 进 SQL 字面量安全)。
 * 🔴 不用可读性更好的词表:口令只在函数内活几毫秒,可读性没有价值,熵有。
 */
function generateRedshiftPassword(): string {
  return `Kf${randomBytes(24).toString("base64url")}7`;
}

/** 口令不进模板注册表,但**标识符仍必须过同一套编码**(否则就是在私有路径上放弃了转义)。 */
function identForLogin(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new AdminDdlDenied("5-template", `拒绝非法登录用户名:${JSON.stringify(name)}`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * 建用户或轮换口令。幂等做法与 `realtime/redshift-target.ts` 同款(先 CREATE,已存在则 ALTER)。
 *
 * 🔴 这里产出的字符串**刻意不是** `GeneratedAdminStatement`:它含字面量口令,
 * 一旦铸成 branded 类型,它就有资格流进任何接受模板产物的地方(审计、lint、错误栈)。
 */
async function execLoginStatements(
  warehouse: TargetWarehouse,
  secretArn: string,
  userName: string,
  password: string
): Promise<void> {
  const u = identForLogin(userName);
  const pw = `'${password.replace(/'/g, "''")}'`;
  try {
    await execOnTarget({ warehouse, sql: `CREATE USER ${u} PASSWORD ${pw}`, secretArn });
  } catch {
    // 已存在 ⇒ 轮换口令。🔴 catch 里**不看也不记**原错误:它可能带语句片段。
    await execOnTarget({ warehouse, sql: `ALTER USER ${u} PASSWORD ${pw}`, secretArn });
  }
}

/**
 * 错误文本脱敏:抹掉任何单引号字面量。
 *
 * Redshift 的报错有时会回带语句片段;`CREATE USER … PASSWORD 'xxx'` 的片段里就是口令。
 * 复用 `sqlSkeleton` 的 mask 规则(单一作者),再补一层"password 后面的东西全抹"。
 */
export function redactSql(text: string): string {
  return String(text)
    .replace(/'(?:[^']|'')*'/g, "'<redacted>'")
    .replace(/(password)\s+\S+/gi, "$1 <redacted>");
}
