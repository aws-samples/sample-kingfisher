// **跨法域 target 的技术前置 + 项目白名单 + 法域格式**的唯一作者(50 SPEC v3.22 §1.1 / §2.1 前置 / §3.2 / §3.12;DESIGN §18 决策 6quinquies)。
//
// ── 用户 2026-09-05 拍板(原话)────────────────────────────────────────────────
// 「我们不做法务的决策,这部分交给用户自己规划,我们不干预,我们只提供产品,他们的法务如果觉得存在数据合规问题,
//   那就在一开始就规避,而不是靠工具解决问题。我们只需要可审计就行。不需要考虑其他的。」
// ⇒ 本文件**没有任何**「法务 / 备案 / 拒绝跨法域操作」的判据。跨法域 target 与同法域 target 走同一条路,
//    平台唯一多判的是**技术前置**:装了 residency-api(区域审计 / 结果存储)+ 有本 target 自己的执行角色(SPEC §6.1 段二)。
//    这与「跑 Redshift 作业要装 redshift 组件」同性质,不是门。
//
// ── 三件事,三处消费,判据各只有一份 ─────────────────────────────────────────
//   ① `residencyPrerequisite(t)`:插进准入内核 `unusableReason`(registry.ts)⇒ 管理页拒因与数据面拒因**逐字同源**;
//   ② `accessAllows(t, projectId)`:项目白名单,**通用**(任何 target 都可设、缺省全部项目、**不对跨法域特殊化**),
//      写入校验(`assertBindableTarget`)与列表过滤(`listRedshiftCapableTargets`)同一个函数 ⇒ 呈现 = 授权;
//   ③ `JURISDICTION_RE`:法域标记的格式(`Home` / `HOME` / `EU` 这类变体不进库 —— 大小写变体会让「是不是 home」的判定分叉)。
//
// 🔴 零 AWS SDK 依赖:客户端组件(向导 / 详情页)与服务端 route 都能 import。
import { isHome } from "@/lib/exec-env/target-id";
import { missingPerTargetExecRoles } from "@/lib/exec-env/exec-roles";

/** 组件名(与 `TARGET_COMPONENTS` / infra `EXEC_ENV_COMPONENTS` 里的字面一致)。 */
export const RESIDENCY_API_COMPONENT = "residency-api";

/** 法域标记格式(SPEC §1.1 v3.22):小写字母开头、`[a-z0-9-]`、2–32 位。 */
export const JURISDICTION_RE = /^[a-z][a-z0-9-]{1,31}$/;

export const HOME_JURISDICTION = "home";

/** 描述符上的项目白名单(SPEC §1.1 `access?`)。缺省 = 全部项目。 */
export type TargetAccess = { mode: "all-projects" } | { mode: "allowlist"; projects: string[] };

export interface ResidencyTargetLike {
  targetId: string;
  jurisdiction?: unknown;
  components?: readonly unknown[] | null;
  resources?: Record<string, unknown> | null;
  access?: unknown;
}

/** 描述符的法域(缺省 `home`;非字符串 / 空串一律按 `home` —— 与 registry 的 seed 归一同口径)。 */
export function jurisdictionOf(t: { jurisdiction?: unknown }): string {
  const j = t.jurisdiction;
  return typeof j === "string" && j.length > 0 ? j : HOME_JURISDICTION;
}

export function isCrossJurisdiction(t: { jurisdiction?: unknown }): boolean {
  return jurisdictionOf(t) !== HOME_JURISDICTION;
}

/**
 * 🔴 跨法域 target 的**唯一**技术前置(SPEC §2.1 v3.22 前置闸 / §3.2 `residencyPrerequisite`)。
 * home 法域 ⇒ 恒 null。返回的字符串就是管理页与数据面**共用**的拒因(不许两边各写一句)。
 */
export function residencyPrerequisite(t: ResidencyTargetLike): string | null {
  if (isHome(t.targetId)) return null;
  if (!isCrossJurisdiction(t)) return null;
  const comps = (t.components ?? []).filter((c): c is string => typeof c === "string");
  if (!comps.includes(RESIDENCY_API_COMPONENT)) {
    return `跨法域目标(jurisdiction=${jurisdictionOf(t)})未装 residency-api(区域审计 / 结果存储),不承接 —— 去「执行环境管理」补充部署该组件`;
  }
  const missing = missingPerTargetExecRoles({ targetId: t.targetId, components: comps, resources: t.resources });
  if (missing.length > 0) {
    return `缺 per-target 执行角色(${missing.join(", ")};SPEC §6.1 硬门)—— 对该执行环境执行一次「重新部署」以切换角色`;
  }
  return null;
}

/** `access` 的形态校验:合法 ⇒ 归一后的对象;非法 ⇒ 抛(拒而不是忽略)。`undefined` ⇒ 缺省 all-projects。 */
export function parseTargetAccess(raw: unknown): TargetAccess {
  if (raw === undefined || raw === null) return { mode: "all-projects" };
  if (typeof raw !== "object") throw new Error(`access 须为对象:${JSON.stringify(raw)}`);
  const mode = (raw as { mode?: unknown }).mode;
  if (mode === "all-projects") return { mode: "all-projects" };
  if (mode === "allowlist") {
    const projects = (raw as { projects?: unknown }).projects;
    if (!Array.isArray(projects) || projects.some((p) => typeof p !== "string" || !p.trim())) {
      throw new Error("access.mode=allowlist 时 projects 须为字符串数组(可为空数组 = 谁都不能绑,允许但审计)");
    }
    const dedup = (projects as string[]).map((p) => p.trim()).filter((p, i, a) => a.indexOf(p) === i).sort();
    return { mode: "allowlist", projects: dedup };
  }
  throw new Error(`access.mode 只允许 all-projects / allowlist(收到 ${JSON.stringify(mode)})`);
}

/**
 * 项目白名单判定(SPEC §3.12 v3.22)。**通用**:任何 target、缺省全部项目。
 * 🔴 `allowlist` 下 projectId 缺失 ⇒ **false**(没有项目上下文的写入不许借「缺省」绕过白名单)。
 * 🔴 `access` 形态非法 ⇒ **false**(fail-closed:坏数据不当「全部项目」)。
 */
export function accessAllows(t: { access?: unknown }, projectId: string | null | undefined): boolean {
  let access: TargetAccess;
  try {
    access = parseTargetAccess(t.access);
  } catch {
    return false;
  }
  if (access.mode === "all-projects") return true;
  return typeof projectId === "string" && projectId.length > 0 && access.projects.includes(projectId);
}

/** 拒因文案(写入路径与列表过滤共用)。 */
export function accessDeniedReason(t: { targetId: string }, projectId: string | null | undefined): string {
  return (
    `执行目标 ${t.targetId} 未授权给项目 ${projectId ?? "(无项目上下文)"} —— ` +
    `该 target 设了项目白名单(执行环境详情页「授权项目」),请管理员把本项目加入白名单`
  );
}

// ──:可审计闭环的**枚举与错误类**(SPEC v3.23 §3.2 第二段细化)────────────────────
// 🔴 仍然零 AWS SDK 依赖:这里只放「词」和「错误形状」;真写库的 `residencyAudit` 在 residency-audit.ts
//    (它要 import registry,而 registry import 本文件 —— 放这里会成环;客户端组件也要 import 这些词来判 409)。

/** 审计入口(entry)枚举 —— 白名单入口逐一对应,单作者;wiring-guard 按它逐个点名。 */
export const RESIDENCY_ENTRIES = ["execute", "result", "history", "modeling-land", "run-submit"] as const;
export type ResidencyEntry = (typeof RESIDENCY_ENTRIES)[number];

/** 认证方式 —— 只是审计字段(已作废的 classifyTrack 判轨降级为此),**不驱动任何分叉**。 */
export const AUTH_KINDS = ["cognito-user-jwt", "service", "mwaa"] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

/** 409 / 503 的 `error.detail.reason` 字面(前端据此弹窗 / 提示;单作者)。 */
export const RESIDENCY_ACK_REQUIRED = "residency-ack-required";
export const AUDIT_UNAVAILABLE = "audit-unavailable";

/** 用户对该跨法域 target 尚未同意当前版本的免责告知 ⇒ 调用方回 409(响应带当前文案与版本)。 */
export class ResidencyAckRequired extends Error {
  readonly reason = RESIDENCY_ACK_REQUIRED;
  constructor(
    readonly targetId: string,
    readonly disclaimer: { version: string; text: string; textHash: string }
  ) {
    super(`对执行目标 ${targetId} 的操作需要先同意免责告知(${disclaimer.version})`);
    this.name = "ResidencyAckRequired";
  }
}

/** 区域审计 / 中央摘要写不成 ⇒ 操作不执行,调用方回 503(审计完整性 fail-closed,不是合规干预)。 */
export class AuditUnavailable extends Error {
  readonly reason = AUDIT_UNAVAILABLE;
  constructor(
    readonly targetId: string,
    readonly cause_: string
  ) {
    super(`执行目标 ${targetId} 的区域审计当前写不进去,操作未执行(审计完整性):${cause_}`);
    this.name = "AuditUnavailable";
  }
}
