// **可审计闭包** `residencyAudit` + 同意前置 `requireResidencyAck` 的唯一作者(50 SPEC v3.23 §3.2 / §3.3;DESIGN §18 决策 6quinquies)。
//
// 【它做什么、不做什么】
//   · 不判轨、不拒绝、不设法务门(用户 2026-09-05 原话:「我们只需要可审计就行」)。跨法域 target 与同法域 target 走同一条路,
//     多出来的只有两件事:① 用户对该 target 同意过当前版本的免责告知(缺 ⇒ 409,响应带文案;同意留存后不再弹);
//     ② 每次跨法域数据操作在**区域**审计表留全量、在**中央** bgp-audit 留无 PII 摘要 —— 任一写不成 ⇒ **操作不执行**(503)。
//   · home / 同法域 target ⇒ 直接 `null`,**在碰任何区域客户端之前**返回(单测钉:home 请求零区域客户端调用)。
//   · `requireReadyTarget` 绝不 `?? homeTarget`(v3.2 修掉的 fail-open,仍成立 —— 那是准入正确性,与法务无关)。
//
// 【为什么不放 residency.ts】registry.ts import residency.ts(JURISDICTION_RE / residencyPrerequisite …),而本文件要 import registry
//   (requireReadyTarget)⇒ 放一起就成环;且 residency.ts 要保持零 AWS 依赖给客户端组件 import。词与错误形状留在 residency.ts,写库的在这里。
//
// 【白名单入口(SPEC §3.2)】redshift/execute(逐 target,提交前)· redshift/result/[id](取行前)· redshift/history/[historyId]/sql(读原文前)
//   · 建模落地(码表 land / 维表 apply,逐 target)· 运行提交(etl-jobs / engines 的 run · rerun · backfill,逐 target;定时 = 观测后补写)。
//   ⇒ residency-wiring-guard.test.ts 逐个点名;少接一处即红。
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { ulid } from "ulid";
import type { Identity } from "@/lib/auth/identity";
import { apiError } from "@/lib/api-response";
import { writeAuditRecord } from "@/lib/audit";
import { getTargetRaw, requireReadyTarget, TargetNotReadyError, type ExecutionTarget } from "@/lib/exec-env/registry";
import { isHome } from "@/lib/exec-env/target-id";
import {
  AuditUnavailable,
  HOME_JURISDICTION,
  ResidencyAckRequired,
  isCrossJurisdiction,
  jurisdictionOf,
  type AuthKind,
  type ResidencyEntry,
} from "@/lib/exec-env/residency";
import { hasAck, putRegionAudit } from "@/lib/exec-env/residency-store";
import { DISCLAIMER_TEXT, DISCLAIMER_TEXT_HASH, DISCLAIMER_VERSION } from "@/lib/residency/disclaimer";
import { updateRunRecord } from "@/lib/monitor/run-records";

/** 审计的行为主体:身份 + 认证方式(authKind 只是审计字段)。 */
export interface ResidencyActor {
  identity: Identity;
  authKind: AuthKind;
}

function systemIdentity(sub: string): Identity {
  return { sub, username: sub, groups: [], isPlatformAdmin: false, isManager: false, isDeveloper: false, demo: false };
}

/** 平台自身(无请求上下文的路径,如 backfill 执行器)。 */
export const SERVICE_ACTOR: ResidencyActor = { identity: systemIdentity("service:platform"), authKind: "service" };
/** MWAA 定时触发(观测后补写用)。 */
export const MWAA_ACTOR: ResidencyActor = { identity: systemIdentity("service:mwaa"), authKind: "mwaa" };

/** 由请求身份构造 actor(路由用)。 */
export function userActor(identity: Identity): ResidencyActor {
  return { identity, authKind: "cognito-user-jwt" };
}

/**
 * 运行提交路径的 actor 归一:路由传用户 actor ⇒ 走同意前置;无用户身份的路径(backfill 执行器 / 内部调用)
 * ⇒ 平台服务主体 + skipAck(没有「用户」可同意;审计照写、authKind=service)。单作者,免得每个 run 函数各写一份判断。
 */
export function auditActorOrService(actor?: ResidencyActor): { actor: ResidencyActor; skipAck: boolean } {
  const a = actor ?? SERVICE_ACTOR;
  return { actor: a, skipAck: a.authKind !== "cognito-user-jwt" };
}

export function currentDisclaimer(): { version: string; text: string; textHash: string } {
  return { version: DISCLAIMER_VERSION, text: DISCLAIMER_TEXT, textHash: DISCLAIMER_TEXT_HASH };
}

/**
 * 同意前置:用户对该**跨法域** target 必须同意过当前版本的免责告知;home / 同法域 ⇒ 直接返回。
 * 缺同意 ⇒ 抛 `ResidencyAckRequired`(调用方回 409,响应带当前文案与版本;前端弹窗、同意后重试同一请求)。
 * 🔴 目标不存在 / 非法 ⇒ 这里**不**抛(不是本函数的职责):后面的 requireReadyTarget / 绑定校验会用自己的拒因说清。
 */
export async function requireResidencyAck(identity: Identity, targetId: string, known?: ExecutionTarget | null): Promise<void> {
  if (isHome(targetId)) return;
  const t = known ?? (await getTargetRaw(targetId));
  if (!t || !isCrossJurisdiction(t)) return;
  if (await hasAck(identity.sub, targetId, DISCLAIMER_VERSION)) return;
  throw new ResidencyAckRequired(targetId, currentDisclaimer());
}

/**
 * 多 target 扇出时**先判全部**再执行任何一个:任一 target 缺同意 ⇒ 整个请求 409
 * (否则用户看到一半 sheet 出结果、另一半弹窗 —— 而且那一半已经在别的区跑起来了)。顺序稳定:按入参顺序第一个缺的报出去。
 */
export async function requireResidencyAckForTargets(identity: Identity, targets: readonly string[]): Promise<void> {
  for (const t of targets) await requireResidencyAck(identity, t);
}

export interface ResidencyAuditInput {
  actor: ResidencyActor;
  targetId: string;
  entry: ResidencyEntry;
  statementId?: string;
  sqlText?: string;
  triggeredBy?: string;
  projectId?: string;
  rows?: number;
  durationMs?: number;
  /**
   * 跳过同意前置。**只**给无用户身份的系统路径(定时观测补写 / backfill 执行器)用;
   * 带用户身份的白名单入口一律不许传 —— wiring-guard 会 grep。
   */
  skipAck?: boolean;
  /**
   * 调用方**已从同一注册表**解析出的法域(绑定 `binding.jurisdiction` / `landing.jurisdiction`)。
   * 传 `home` ⇒ 同法域,直接 null、不再读一次注册表;传非 home 或不传 ⇒ 仍走 `requireReadyTarget`(权威)。
   * 🔴 只许传绑定解析的结果,不许调用方自己拼(第二个说法)。
   */
  knownJurisdiction?: string;
}

export interface ResidencyAuditResult {
  auditId: string;
  targetId: string;
  jurisdiction: string;
  region: string;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * 可审计闭包(SPEC §3.2)。
 *   1. `requireReadyTarget`(内核已含 residencyPrerequisite;miss / not-ready / stale 一律抛,**绝不** `?? homeTarget`);
 *   2. home / 同法域 ⇒ `null`(中央 recordAudit 照旧,一字不变;**此前不碰任何区域客户端**);
 *   3. 同意前置(除 skipAck);
 *   4. 区域全量 → 中央摘要(无 operator / 无 SQL 原文 / 无 statementId 明文,只有 sqlHash);任一失败 ⇒ 抛 `AuditUnavailable`,调用方 503、操作不执行。
 */
export async function residencyAudit(input: ResidencyAuditInput): Promise<ResidencyAuditResult | null> {
  const { actor, targetId, entry } = input;
  // home 恒为 home 法域(注册表 seed 钉死)⇒ 零 I/O 直接返回:home 路径逐字节等价,且不碰任何区域客户端。
  if (isHome(targetId)) return null;
  // 调用方已从同一注册表解析出「同法域」⇒ 不必再读一次(两次读会有两个说法);非 home 法域仍走权威准入。
  if (input.knownJurisdiction === HOME_JURISDICTION) return null;
  const t = await requireReadyTarget(targetId);
  if (!isCrossJurisdiction(t)) return null;
  if (!input.skipAck) await requireResidencyAck(actor.identity, targetId, t);

  const auditId = ulid();
  const ts = new Date().toISOString();
  const jurisdiction = jurisdictionOf(t);
  const region = typeof t.region === "string" ? t.region : "";
  try {
    await putRegionAudit(t, {
      auditId,
      targetId,
      jurisdiction,
      entry,
      authKind: actor.authKind,
      operatorSub: actor.identity.sub,
      operator: actor.identity.email || actor.identity.username || actor.identity.sub,
      projectId: input.projectId,
      sqlText: input.sqlText,
      statementId: input.statementId,
      triggeredBy: input.triggeredBy,
      ts,
    });
    // 中央摘要:同一 auditId,**没有** operator / sql / statementId 明文(轴 D:个人数据与业务数据留区)。
    await writeAuditRecord(
      { actor: "system:residency" },
      `residency.${entry}`,
      {
        resourceType: "exec-env",
        resourceId: targetId,
        detail: {
          auditId,
          targetId,
          jurisdiction,
          region,
          entry,
          authKind: actor.authKind,
          ...(input.sqlText !== undefined ? { sqlHash: sha256Hex(input.sqlText) } : {}),
          ...(input.triggeredBy ? { triggeredBy: input.triggeredBy } : {}),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(typeof input.rows === "number" ? { rows: input.rows } : {}),
          ...(typeof input.durationMs === "number" ? { durationMs: input.durationMs } : {}),
        },
      },
      { method: "", path: `residency/${entry}` }
    );
  } catch (e) {
    throw new AuditUnavailable(targetId, String((e as Error)?.message ?? e));
  }
  return { auditId, targetId, jurisdiction, region };
}

// (问数)
/** 定时平台动作的服务主体(审计 authKind=service;没有「用户」可当场同意)。 */
export const SCHEDULED_ACTION_ACTOR: ResidencyActor = { identity: systemIdentity("service:action-dispatcher"), authKind: "service" };

/**
 * **代作者执行**的定时动作的驻留审计(问数卡片定时刷新)。
 * 🔴 服务身份**不能**凭空跳过同意:跨法域 target 上只放行「**作者本人**已同意过当前版本告知」的那个 target ——
 *    先按作者的 sub 查同意(缺 ⇒ 抛 ResidencyAckRequired,这次定时失败、真因进台账),再以服务主体写审计。
 *    `skipAck: true` 只在本文件里出现(接线守卫钉住),带用户身份的入口一律不许跳过。
 */
export async function scheduledResidencyAudit(input: {
  onBehalfOfSub: string;
  targetId: string;
  entry: ResidencyEntry;
  triggeredBy: string;
  projectId?: string;
  sqlText?: string;
}): Promise<ResidencyAuditResult | null> {
  if (!input.onBehalfOfSub) throw new Error("定时动作缺作者身份 —— 跨法域审计不知道替谁执行");
  // home / 同法域:requireResidencyAck 与 residencyAudit 自己都零 I/O 返回(不在这里再判一次主控区)
  await requireResidencyAck(systemIdentity(input.onBehalfOfSub), input.targetId);
  return residencyAudit({
    actor: SCHEDULED_ACTION_ACTOR,
    targetId: input.targetId,
    entry: input.entry,
    triggeredBy: input.triggeredBy,
    projectId: input.projectId,
    sqlText: input.sqlText,
    skipAck: true,
  });
}

/**
 * 把本文件的两类错误映射成路由响应(单作者:409 / 503 的形状只在这里定义;SPEC §3.2 v3.23)。
 * 不是这两类 ⇒ `null`,调用方按原有方式处理。
 */
export function residencyErrorResponse(e: unknown): NextResponse | null {
  if (e instanceof ResidencyAckRequired) {
    return apiError(e.message, 409, {
      code: "CONFLICT",
      detail: { reason: e.reason, targetId: e.targetId, disclaimer: e.disclaimer },
    });
  }
  if (e instanceof AuditUnavailable) {
    return apiError(e.message, 503, { code: "UPSTREAM_ERROR", detail: { reason: e.reason, targetId: e.targetId } });
  }
  return null;
}

/** 是否属于本文件定义的两类错误(扇出循环里逐 target 归类用)。 */
export function isResidencyError(e: unknown): e is ResidencyAckRequired | AuditUnavailable {
  return e instanceof ResidencyAckRequired || e instanceof AuditUnavailable;
}

const PENDING_PREFIX = "pending#";

/**
 * 🔴 定时触发的 run 的**观测后补写**(SPEC §3.2 v3.23:执行体是 MWAA,平台进程不在提交路径上)。
 * 协议(幂等、可重试、不产生重复审计):
 *   ① 只看 `triggeredBy=schedule` 且 target 跨法域且 run 行**没有**最终 `residencyAuditId` 的 run;
 *   ② 先用条件写把 run 行的 `residencyAuditId` 标成 `pending#<claim>`(不存在 / 仍是上一次的 pending 才写得进)—— 抢到才继续;
 *   ③ 写区域审计 + 中央摘要(`MWAA_ACTOR`,skipAck);
 *   ④ 条件写把 `pending#<claim>` 换成真 auditId。③ 失败 ⇒ 行上留着 pending,下次观测重试;绝不静默当成已审。
 * 任何异常都**吞掉不上抛**(对账路径不许被审计问题打断),但会 console.warn 留痕。
 */
export async function auditObservedScheduledRun(run: {
  taskId: string;
  runId: string;
  targetId?: unknown;
  triggeredBy?: unknown;
  residencyAuditId?: unknown;
}): Promise<{ audited: boolean; auditId?: string }> {
  try {
    if (run.triggeredBy !== "schedule") return { audited: false };
    const targetId = typeof run.targetId === "string" ? run.targetId : "";
    if (!targetId || isHome(targetId)) return { audited: false };
    const existing = typeof run.residencyAuditId === "string" ? run.residencyAuditId : undefined;
    if (existing && !existing.startsWith(PENDING_PREFIX)) return { audited: true, auditId: existing };
    const t = await getTargetRaw(targetId);
    if (!t || !isCrossJurisdiction(t)) return { audited: false };

    const claim = `${PENDING_PREFIX}${ulid()}`;
    const claimed = await updateRunRecord({
      taskId: run.taskId,
      runId: run.runId,
      set: { residencyAuditId: claim },
      extraCondition: existing ? "residencyAuditId = :prev" : "attribute_not_exists(residencyAuditId)",
      ...(existing ? { extraConditionValues: { ":prev": existing } } : {}),
    });
    if (!claimed) return { audited: false };
    const r = await residencyAudit({ actor: MWAA_ACTOR, targetId, entry: "run-submit", triggeredBy: "schedule", skipAck: true });
    if (!r) return { audited: false };
    await updateRunRecord({
      taskId: run.taskId,
      runId: run.runId,
      set: { residencyAuditId: r.auditId },
      extraCondition: "residencyAuditId = :prev",
      extraConditionValues: { ":prev": claim },
    });
    return { audited: true, auditId: r.auditId };
  } catch (e) {
    if (!(e instanceof TargetNotReadyError)) {
      console.warn("[residency] 定时 run 的观测后审计补写失败(行上保留 pending,下次对账重试)", run.taskId, run.runId, String((e as Error)?.message ?? e));
    }
    return { audited: false };
  }
}
