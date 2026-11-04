// @kf-batch 50-WP30-decommission
// WP-30 路 B「下线销毁」—— 装过(或装了一半、有栈)的执行环境的删除流程编排(唯一作者)。
//
// 流程(INTERACTION §1.4 四道闸 + WORK-PACKAGES WP-30 ③):
//   drain(停止承接;intent 路由 / drain 路由同一个写通道 setSpecIntent)
//   → 影响预览(delete-impact.ts:绑定 / 启用调度 / 运行中 run,三个数必须都是 0)
//   → 输 region 名强确认 + previewHash ⇒ `requestDelete` 建 bgp-approvals(type=exec-env-delete)
//   → 平台 admin 审批(收件箱回放影响预览快照)⇒ `startApprovedDestroy`:重算预览(指纹必须仍等于审批单上那份)
//      → `markDecommissionApproved`(intent=delete + 删除计划:最终快照名在这一刻定死)→ broker mode=destroy
//   → buildspec 销毁分支(托管服务先走 → 组件栈反序 → core → base)
//   → `observeDecommission`:build 结束后**自己再真查一遍 AWS** ⇒ 全清 `gone`;否则 `decommissioning` + lastError 点名卡住的资源
//   → 卡住可「重试销毁」(`retryDestroy`;同一份删除计划、同一个快照名 ⇒ 不重复建快照,build 角色连删快照的权限都没有)。
//
// 🔴 不变量:home 永不可删(这里拒 + broker 拒 + buildspec 拒,三道);全程写 bgp-audit(路由层,发起人 / 快照 / 审批人 / 每步结果);
//    「一区一套」的占位口径排除 deleted(registry.registerTarget / candidate-regions 早已如此)⇒ 删完才能在该区重新注册。
// 🔴 本文件**不写** status / phase / spec:所有状态写入都经 lifecycle.ts 的写通道(AST 门禁:lifecycle.ts 之外写点为 0)。
import { randomBytes } from "node:crypto";
import { DescribeStacksCommand, DescribeStackEventsCommand } from "@aws-sdk/client-cloudformation";
import { DescribeVpcsCommand } from "@aws-sdk/client-ec2";
import { GetWorkgroupCommand, GetNamespaceCommand, GetSnapshotCommand } from "@aws-sdk/client-redshift-serverless";
import { GetEnvironmentCommand } from "@aws-sdk/client-mwaa";
import { getTargetRaw, type ExecutionTarget } from "@/lib/exec-env/registry";
import { isHome } from "@/lib/exec-env/target-id";
import {
  classifyDescriptor,
  markDecommissionApproved,
  settleDestroy,
  isStrictIsoInstant,
  NO_BUILD_STATUS,
  type DecommissionPlan,
  type LastDestroyRecord,
  type RetainedResource,
} from "@/lib/exec-env/lifecycle";
import { computeDeleteImpact, retainedResourcesOf, type DeleteImpact } from "@/lib/exec-env/delete-impact";
import {
  invokeDestroyBroker,
  brokerCodeToHttp,
  readExactBuildPhase,
  fetchDestroyReport,
  verifyNoBuildForOperation,
  noBuildRecoveryWindow,
  sanitizeAwsErrorMessage,
  START_ABSENCE_MIN_AGE_MS,
  type DestroyReport,
} from "@/lib/exec-env/deploy-control";
import { explainCfnFailure } from "@/lib/exec-env/cfn-failure";
import { IMPLEMENTED_COMPONENTS } from "@/lib/exec-env/implemented-components";
import { execEnvStackName, resourceName } from "@/lib/aws/naming";
import { ec2ClientFor, redshiftServerlessClientFor } from "@/lib/exec-env/target-clients";
import { regionalClient } from "@/lib/aws/clients";
import { createApproval, listApprovals, type Approval } from "@/lib/projects/project-service";
import { DEFAULT_PROJECT_ID } from "@/lib/projects/constants";
import type { ApiErrorCode } from "@/lib/api-response";

/** bgp-approvals 的审批类型(复用模块 13 审批流;决策人只许平台 admin —— approvals/[id] 路由按类型硬判)。 */
export const EXEC_ENV_DELETE_APPROVAL_TYPE = "exec-env-delete";

/** 停止承接后页面 / 拒因里的那句话(与 lifecycle.serviceabilityReason 的开头一致)。 */
export const STOPPED_ACCEPTING = "该执行环境已停止承接";

export class DecommissionRefused extends Error {
  constructor(
    message: string,
    readonly httpStatus: 400 | 403 | 404 | 409 | 502,
    readonly code: ApiErrorCode,
    readonly detail?: Record<string, unknown>
  ) {
    super(message);
    this.name = "DecommissionRefused";
  }
}

const GO_DISCARD = "这个环境从没部署过 —— 请用「弃置」(路 A),不需要销毁";

async function loadTarget(targetId: string): Promise<ExecutionTarget> {
  const t = await getTargetRaw(targetId);
  if (!t) throw new DecommissionRefused(`执行目标不存在:${targetId}`, 404, "NOT_FOUND");
  if (isHome(t.targetId) || (t as { isHome?: unknown }).isHome === true) {
    throw new DecommissionRefused("主控区执行环境永不可删(它是控制面自己的执行环境)", 403, "RBAC_DENIED");
  }
  return t;
}

function axesOrRefuse(t: ExecutionTarget) {
  const c = classifyDescriptor(t);
  if (c.kind === "invalid") throw new DecommissionRefused(`描述符形态非法(fail-closed):${c.reason}`, 409, "CONFLICT");
  if (c.kind === "legacy") throw new DecommissionRefused("这是 legacy 描述符(无 spec/observed)—— 先「检测初始化」让平台收养,再申请删除", 409, "CONFLICT");
  return c;
}

/** 删除流程此刻走到哪一步(页面据此决定显示哪个按钮;**提示性**,每个动作在服务端都会重判)。 */
export type DeleteStage =
  | "serving" // 还在承接 ⇒ 先〔停止承接〕
  | "drained" // 已停止承接 ⇒ 可以〔申请删除〕(影响预览为 0 时)
  | "pending-approval" // 已提交删除申请,等平台 admin 审批
  | "approved" // 审批已通过、删除计划已写,销毁还没起来(或 broker 没起来)⇒〔重试销毁〕
  | "destroying" // 销毁会话在跑
  | "stuck" // 销毁卡住(decommissioning + lastError)⇒〔重试销毁〕
  | "deleted" // 已删除(tombstone)
  | "never-deployed"; // 从没部署过 ⇒ 走弃置

export interface DeletePreview {
  targetId: string;
  region: string;
  stage: DeleteStage;
  impact: DeleteImpact;
  pendingApprovalId?: string;
  /** 不能「申请删除」的原因(空 = 可以申请);与 requestDelete 的拒因同源 */
  blockers: string[];
}

async function pendingDeleteApprovalOf(targetId: string): Promise<Approval | undefined> {
  const all = await listApprovals({ status: "pending" });
  return all.find((a) => a.type === EXEC_ENV_DELETE_APPROVAL_TYPE && a.payload?.targetId === targetId);
}

function stageOf(t: ExecutionTarget, pending: Approval | undefined): DeleteStage {
  const c = classifyDescriptor(t);
  if (c.kind !== "modern") return "serving";
  const { spec, observed } = c;
  if (observed.phase === "gone") return "deleted";
  if (observed.phase === "registered") return "never-deployed";
  if (observed.phase === "decommissioning") return observed.operation ? "destroying" : "stuck";
  if (spec.intent === "delete") return "approved";
  if (spec.intent === "drain") return pending ? "pending-approval" : "drained";
  return "serving";
}

/** 「能不能申请删除」的唯一判定(预览与申请共用,拒因逐字同源)。 */
function requestBlockers(t: ExecutionTarget, impact: DeleteImpact | null, pending: Approval | undefined): Array<{ code: ApiErrorCode; message: string; status: 409 }> {
  const out: Array<{ code: ApiErrorCode; message: string; status: 409 }> = [];
  const c = classifyDescriptor(t);
  if (c.kind !== "modern") return [{ code: "CONFLICT", message: "描述符不是 modern 形态 —— 先「检测初始化」", status: 409 }];
  const { spec, observed } = c;
  if (observed.phase === "registered") out.push({ code: "USE_DISCARD", message: GO_DISCARD, status: 409 });
  else if (observed.phase === "gone") out.push({ code: "CONFLICT", message: "已经是已删除状态", status: 409 });
  else if (observed.phase === "decommissioning" || spec.intent === "delete") {
    out.push({ code: "CONFLICT", message: "删除已经批准(销毁中 / 卡住)—— 请在详情页看进度或「重试销毁」", status: 409 });
  } else if (spec.intent !== "drain") {
    out.push({ code: "NOT_DRAINED", message: "先〔停止承接〕(drain):删除前该环境不许再承接新绑定 / 新调度 / 新运行", status: 409 });
  }
  if (observed.operation) out.push({ code: "CONFLICT", message: `有在途部署会话(${observed.operation.operationId})—— 等它收口`, status: 409 });
  if (pending) out.push({ code: "DUPLICATE_REQUEST", message: `已有一张待审批的删除申请(${pending.approvalId})`, status: 409 });
  if (impact) {
    if (impact.unresolved.length > 0) {
      out.push({ code: "IMPACT_UNVERIFIABLE", message: `影响预览有 ${impact.unresolved.length} 个来源读不到(读不到 ≠ 没有):${impact.unresolved.map((u) => u.source).join(", ")}`, status: 409 });
    }
    const { bindings, schedules, runningRuns } = impact.counts;
    if ((bindings ?? 0) > 0 || (schedules ?? 0) > 0 || (runningRuns ?? 0) > 0) {
      out.push({
        code: "IMPACT_NOT_ZERO",
        message: `还有绑定资源 ${bindings ?? "?"} 个 / 启用调度 ${schedules ?? "?"} 个 / 运行中 run ${runningRuns ?? "?"} 个 —— 先解绑 / 停调度 / 等运行结束`,
        status: 409,
      });
    }
  }
  return out;
}

/** GET delete-preview:只读。 */
export async function previewDelete(targetId: string): Promise<DeletePreview> {
  const t = await loadTarget(targetId);
  const [impact, pending] = await Promise.all([computeDeleteImpact(t), pendingDeleteApprovalOf(targetId)]);
  return {
    targetId,
    region: t.region,
    stage: stageOf(t, pending),
    impact,
    ...(pending ? { pendingApprovalId: pending.approvalId } : {}),
    blockers: requestBlockers(t, impact, pending).map((b) => b.message),
  };
}

/** POST delete-request:输 region 名强确认 + 带 previewHash ⇒ 建审批单。 */
export async function requestDelete(
  targetId: string,
  input: { confirm: unknown; previewHash: unknown },
  actor: { username: string; sub?: string }
): Promise<{ approval: Approval; impact: DeleteImpact }> {
  const t = await loadTarget(targetId);
  axesOrRefuse(t);
  if (input.confirm !== t.region) {
    throw new DecommissionRefused(`确认文字必须逐字等于该环境的 region(${t.region})`, 400, "VALIDATION_FAILED");
  }
  if (typeof input.previewHash !== "string" || !/^[a-f0-9]{64}$/.test(input.previewHash)) {
    throw new DecommissionRefused("previewHash 缺失或形态非法 —— 先打开影响预览", 400, "VALIDATION_FAILED");
  }
  const [impact, pending] = await Promise.all([computeDeleteImpact(t), pendingDeleteApprovalOf(targetId)]);
  const blockers = requestBlockers(t, impact, pending);
  if (blockers.length > 0) {
    const b = blockers[0];
    throw new DecommissionRefused(blockers.map((x) => x.message).join(";"), b.status, b.code, { impact, ...(pending ? { pendingApprovalId: pending.approvalId } : {}) });
  }
  // 🔴 计数都是 0 也要比指纹:用户看的那一份 ≠ 现在这一份 ⇒ 重新预览(列表变了说明有人在动它)
  if (impact.previewHash !== input.previewHash) {
    throw new DecommissionRefused("影响清单在你预览之后变了 —— 请重新打开影响预览确认后再提交", 409, "PREVIEW_DRIFT", { impact });
  }
  const approval = await createApproval({
    projectId: DEFAULT_PROJECT_ID,
    type: EXEC_ENV_DELETE_APPROVAL_TYPE,
    payload: {
      targetId,
      region: t.region,
      displayName: (t as { displayName?: string }).displayName ?? targetId,
      previewHash: impact.previewHash,
      // 🔴 收件箱回放用的**快照**(审批人看到的就是申请人提交那一刻的爆炸半径;批的时候服务端还会再重算一次)
      snapshot: {
        computedAt: impact.computedAt,
        counts: impact.counts,
        retained: impact.retained,
        components: Array.isArray(t.components) ? t.components : [],
      },
    },
    requestedBy: actor.username,
    ...(actor.sub ? { requestedBySub: actor.sub } : {}),
    targetIds: [targetId],
  });
  return { approval, impact };
}

/** 最终快照名:`bgp-final-<slug>-<yyyymmdd>-<hhmm>`(审批通过那一刻定死,写进删除计划;重试复用)。 */
export function finalSnapshotNameFor(targetId: string, at: Date): string {
  // 日期与时刻之间留一个连字符(`20261011-0930`):连续 12 位数字会被红线扫描当成账号号(日志 / 审计 / 夹具里都会出现它)
  const iso = at.toISOString();
  const ts = `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 16).replace(":", "")}`;
  return `bgp-final-${targetId.replace(/_/g, "-")}-${ts}`;
}

/**
 * 审批前置(**零写**):审批通过前调用,任一不满足 ⇒ 抛,审批单保持 pending(审批人可以驳回)。
 * 返回此刻重算的影响预览(必须仍等于申请时那一份)。
 */
export async function preflightApprovedDelete(approval: Approval): Promise<{ target: ExecutionTarget; impact: DeleteImpact }> {
  if (approval.type !== EXEC_ENV_DELETE_APPROVAL_TYPE) throw new DecommissionRefused("不是删除执行环境的审批单", 400, "VALIDATION_FAILED");
  const targetId = String(approval.payload?.targetId ?? "");
  const t = await loadTarget(targetId);
  const c = axesOrRefuse(t);
  const plan = (t as { decommission?: DecommissionPlan }).decommission;
  if (c.spec.intent === "delete" && plan?.approvalId === approval.approvalId) {
    // 已经按这张单写过删除计划(broker 上次没起来)—— 不再比影响预览(环境已不承接,计划已定)
    return { target: t, impact: await computeDeleteImpact(t) };
  }
  const impact = await computeDeleteImpact(t);
  const blockers = requestBlockers(t, impact, undefined);
  if (blockers.length > 0) throw new DecommissionRefused(blockers.map((b) => b.message).join(";"), 409, blockers[0].code, { impact });
  if (impact.previewHash !== approval.payload?.previewHash) {
    throw new DecommissionRefused("影响清单在审批期间变了(与申请时那一份不同)—— 请驳回后重新申请", 409, "PREVIEW_DRIFT", { impact });
  }
  return { target: t, impact };
}

/**
 * 审批**已通过**之后:写删除计划(intent=delete + 最终快照名)→ broker mode=destroy。
 * 失败不回滚审批(审批是「人同意了」这一事实);页面给〔重试销毁〕。
 */
export async function startApprovedDestroy(
  approval: Approval,
  actor: { username: string }
): Promise<{ buildId: string; operationId: string; finalSnapshotName: string; lockEpoch: number }> {
  const { target: t, impact } = await preflightApprovedDelete(approval);
  let plan = (t as { decommission?: DecommissionPlan }).decommission;
  if (!plan || plan.approvalId !== approval.approvalId) {
    const now = new Date();
    const finalSnapshotName = finalSnapshotNameFor(t.targetId, now);
    const next: DecommissionPlan = {
      approvalId: approval.approvalId,
      previewHash: impact.previewHash,
      finalSnapshotName,
      requestedBy: approval.requestedBy,
      approvedBy: actor.username,
      approvedAt: now.toISOString(),
      retained: retainedResourcesOf(t as ExecutionTarget & { resources?: Record<string, unknown> }, finalSnapshotName),
    };
    await markDecommissionApproved(t.targetId, { expectedVersion: Number(t.version), plan: next });
    plan = next;
  }
  return invokeDestroy(t.targetId, plan.finalSnapshotName);
}

async function invokeDestroy(targetId: string, finalSnapshotName: string) {
  const operationId = `op_${randomBytes(8).toString("hex")}`;
  const r = await invokeDestroyBroker(targetId, operationId);
  if (!r.ok) {
    throw new DecommissionRefused(`broker 拒绝销毁(${r.code}):${r.message}`, brokerCodeToHttp(r.code) as 400 | 404 | 409 | 502, "BROKER_REJECTED", { brokerCode: r.code });
  }
  return { buildId: r.buildId, operationId, finalSnapshotName, lockEpoch: r.lockEpoch };
}

/** POST destroy-retry:卡住 / 审批后没起来 ⇒ 用**同一份**删除计划再起一次销毁(要再输一次 region 名)。 */
export async function retryDestroy(targetId: string, input: { confirm: unknown }, actor: { username: string }) {
  const t = await loadTarget(targetId);
  const { spec, observed } = axesOrRefuse(t);
  if (input.confirm !== t.region) throw new DecommissionRefused(`确认文字必须逐字等于该环境的 region(${t.region})`, 400, "VALIDATION_FAILED");
  if (observed.phase === "gone") throw new DecommissionRefused("已经是已删除状态", 409, "CONFLICT");
  if (observed.operation) throw new DecommissionRefused(`销毁会话还在跑(${observed.operation.operationId})—— 等它结束`, 409, "CONFLICT");
  const plan = (t as { decommission?: DecommissionPlan }).decommission;
  if (spec.intent === "delete" && plan) return invokeDestroy(targetId, plan.finalSnapshotName);
  // 审批通过了、删除计划却没写上(那一步失败过)⇒ 找到那张已通过的审批单,按它补写计划再起
  const approved = (await listApprovals({ status: "approved" }))
    .filter((a) => a.type === EXEC_ENV_DELETE_APPROVAL_TYPE && a.payload?.targetId === targetId)
    .sort((a, b) => String(b.decidedAt ?? "").localeCompare(String(a.decidedAt ?? "")))[0];
  if (!approved) throw new DecommissionRefused("没有已批准的删除审批 —— 先申请删除并经平台管理员审批", 409, "NOT_APPROVED");
  return startApprovedDestroy(approved, actor);
}

// ══════════════════════════════════════════════════════════════════════════════
// 观测与收口(施工序 5)
// ══════════════════════════════════════════════════════════════════════════════

export interface DecommissionFacts {
  checkedAt: string;
  remaining: string[];
  unverifiable: string[];
  /** 第一个卡住的栈的真因(DELETE_FAILED 事件翻成人话) */
  stackFailure?: { resource: string; reason: string };
  finalSnapshot?: { name: string; state: string };
}

const isNotFound = (e: unknown) => {
  const n = String((e as { name?: string })?.name ?? "");
  const m = String((e as Error)?.message ?? e);
  return /NotFound/i.test(n) || /does not exist|not found|could not be found/i.test(m);
};

/**
 * 真查目标区:本 slug 的栈(**全部**已实现组件的栈名,不只描述符声称的那几个)/ 本 target 的 VPC /
 * Redshift 工作组与命名空间 / 经典 MWAA 环境 / 最终快照。看不清(非「不存在」的失败)一律进 unverifiable —— 看不清不算删完。
 */
export async function probeDecommissionFacts(t: ExecutionTarget, finalSnapshotName?: string): Promise<DecommissionFacts> {
  const remaining: string[] = [];
  const unverifiable: string[] = [];
  let stackFailure: DecommissionFacts["stackFailure"];
  const cfn = await regionalClient("cloudformation", t.region);
  const names = Array.from(new Set(["base", ...IMPLEMENTED_COMPONENTS].map((c) => execEnvStackName(t.targetId, c))));
  await Promise.all(
    names.map(async (name) => {
      try {
        const out = await cfn.send(new DescribeStacksCommand({ StackName: name }));
        const st = out.Stacks?.[0];
        const status = st?.StackStatus ?? "UNKNOWN";
        if (!st || status === "DELETE_COMPLETE") return;
        remaining.push(`stack:${name}[${status}]`);
        if (/FAILED/.test(status) && !stackFailure) {
          try {
            const ev = await cfn.send(new DescribeStackEventsCommand({ StackName: name }));
            const first = (ev.StackEvents ?? []).find((x) => /_FAILED$/.test(x.ResourceStatus ?? "") && x.ResourceStatusReason);
            stackFailure = {
              resource: `stack:${name} / ${first?.LogicalResourceId ?? "?"}(${first?.ResourceType ?? "?"})`,
              reason: explainCfnFailure(first?.ResourceStatusReason) ?? sanitizeAwsErrorMessage(String(first?.ResourceStatusReason ?? status)),
            };
          } catch {
            stackFailure = { resource: `stack:${name}`, reason: status };
          }
        }
      } catch (e) {
        if (isNotFound(e)) return;
        unverifiable.push(`stack:${name}(${sanitizeAwsErrorMessage(String((e as Error)?.message ?? e)).slice(0, 160)})`);
      }
    })
  );
  try {
    const ec2 = await ec2ClientFor(t.region);
    const v = await ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: "tag:aws:cloudformation:stack-name", Values: [execEnvStackName(t.targetId, "base")] }] }));
    for (const x of v.Vpcs ?? []) remaining.push(`vpc:${x.VpcId ?? "?"}`);
  } catch (e) {
    unverifiable.push(`vpc(${sanitizeAwsErrorMessage(String((e as Error)?.message ?? e)).slice(0, 160)})`);
  }
  const res = ((t as { resources?: Record<string, unknown> }).resources ?? {}) as Record<string, unknown>;
  const nm = (kind: string, bag: string) => (typeof res[bag] === "string" && res[bag] ? String(res[bag]) : resourceName(kind, { targetId: t.targetId, account: t.accountId }));
  const comps = new Set([...(Array.isArray(t.components) ? t.components : []), ...((t.spec?.desiredComponents as string[] | undefined) ?? [])].map(String));
  let finalSnapshot: DecommissionFacts["finalSnapshot"];
  if (comps.has("redshift")) {
    const rs = await redshiftServerlessClientFor(t.region);
    const wg = nm("redshiftWorkgroup", "redshiftWorkgroup");
    const ns = nm("redshiftNamespace", "redshiftNamespace");
    try {
      const w = await rs.send(new GetWorkgroupCommand({ workgroupName: wg }));
      remaining.push(`redshift-workgroup:${wg}[${w.workgroup?.status ?? "?"}]`);
    } catch (e) {
      if (!isNotFound(e)) unverifiable.push(`redshift-workgroup:${wg}`);
    }
    try {
      const n = await rs.send(new GetNamespaceCommand({ namespaceName: ns }));
      remaining.push(`redshift-namespace:${ns}[${n.namespace?.status ?? "?"}]`);
    } catch (e) {
      if (!isNotFound(e)) unverifiable.push(`redshift-namespace:${ns}`);
    }
    if (finalSnapshotName) {
      try {
        const s = await rs.send(new GetSnapshotCommand({ snapshotName: finalSnapshotName }));
        finalSnapshot = { name: finalSnapshotName, state: String(s.snapshot?.status ?? "UNKNOWN") };
      } catch (e) {
        finalSnapshot = { name: finalSnapshotName, state: isNotFound(e) ? "missing" : "unknown" };
      }
    }
  }
  if (comps.has("mwaa")) {
    const env = nm("mwaaEnvName", "mwaaEnvName");
    try {
      const m = await (await regionalClient("mwaa", t.region)).send(new GetEnvironmentCommand({ Name: env }));
      remaining.push(`mwaa:${env}[${m.Environment?.Status ?? "?"}]`);
    } catch (e) {
      if (!isNotFound(e)) unverifiable.push(`mwaa:${env}`);
    }
  }
  remaining.sort();
  unverifiable.sort();
  return { checkedAt: new Date().toISOString(), remaining, unverifiable, ...(stackFailure ? { stackFailure } : {}), ...(finalSnapshot ? { finalSnapshot } : {}) };
}

/** 卡住时给人看的那句话:哪一步 / 哪个资源 / 真因(构建报告优先,其次 CFN 事件,再次真查残留)。 */
export function describeStuck(facts: DecommissionFacts, report: DestroyReport | null, buildStatus: string): { text: string; stuck: LastDestroyRecord["stuck"] } {
  if (report?.stuck) {
    const s = report.stuck;
    return {
      text: `销毁卡在「${s.step}」:${s.resource} —— ${sanitizeAwsErrorMessage(s.detail)}(build ${buildStatus})`,
      stuck: { step: s.step, resource: s.resource, reason: sanitizeAwsErrorMessage(s.detail) },
    };
  }
  if (facts.stackFailure) {
    return { text: `销毁卡在 ${facts.stackFailure.resource} —— ${facts.stackFailure.reason}(build ${buildStatus})`, stuck: { resource: facts.stackFailure.resource, reason: facts.stackFailure.reason } };
  }
  const first = facts.remaining[0] ?? facts.unverifiable[0];
  if (first) {
    const why = facts.unverifiable.length && !facts.remaining.length ? "查不清(看不清不算删完)" : "仍然存在";
    return { text: `销毁没有完成:${first} ${why}(build ${buildStatus};还剩 ${facts.remaining.length + facts.unverifiable.length} 项)`, stuck: { resource: first, reason: why } };
  }
  return { text: `销毁 build 结束于 ${buildStatus},但没有残留也没有报告 —— 请重新检测`, stuck: { resource: "build", reason: buildStatus } };
}

export interface DecommissionView {
  targetId: string;
  phase: string;
  status: string;
  state: "not-decommissioning" | "running" | "settled-gone" | "settled-stuck" | "stuck" | "deleted";
  buildPhase?: string;
  lastError?: string;
  lastDestroy?: LastDestroyRecord;
  plan?: DecommissionPlan;
}

function viewOf(t: ExecutionTarget, state: DecommissionView["state"], extra: Partial<DecommissionView> = {}): DecommissionView {
  const o = (t.observed ?? {}) as { phase?: string; lastError?: string; lastDestroy?: LastDestroyRecord };
  return {
    targetId: t.targetId,
    phase: String(o.phase ?? ""),
    status: String(t.status),
    state,
    ...(o.lastError ? { lastError: o.lastError } : {}),
    ...(o.lastDestroy ? { lastDestroy: o.lastDestroy } : {}),
    ...((t as { decommission?: DecommissionPlan }).decommission ? { plan: (t as { decommission?: DecommissionPlan }).decommission } : {}),
    ...extra,
  };
}

function retainedFromReport(report: DestroyReport | null, plan: DecommissionPlan | undefined): RetainedResource[] {
  const fromReport = (report?.steps ?? [])
    .filter((s) => s.status === "retained")
    .map((s) => {
      const i = s.resource.indexOf(":");
      return { kind: i > 0 ? s.resource.slice(0, i) : "resource", name: i > 0 ? s.resource.slice(i + 1) : s.resource, note: s.detail };
    });
  return fromReport.length ? fromReport : plan?.retained ?? [];
}

/**
 * POST destroy-observe / 周期 reconciler:观测销毁并收口。
 * · 会话在跑(build 未终态 / 无 buildId 且未过窗口)⇒ 只读回报;
 * · build 终态 ⇒ **自己真查 AWS** ⇒ 全清 `gone`,否则 `decommissioning` + lastError(清锁,可重试);
 * · 已卡住(无会话)⇒ 再真查一次:全清了(例如人工处理掉了卡住的那个资源)⇒ `gone`;否则原样。
 */
export async function observeDecommission(targetId: string, now: number = Date.now()): Promise<DecommissionView> {
  const t = await loadTarget(targetId);
  const c = axesOrRefuse(t);
  const { observed } = c;
  if (observed.phase === "gone") return viewOf(t, "deleted");
  if (observed.phase !== "decommissioning") return viewOf(t, "not-decommissioning");
  const plan = (t as { decommission?: DecommissionPlan }).decommission;
  const op = observed.operation;

  if (op && op.kind === "destroy") {
    let buildStatus: string;
    let reportBuildId: string | undefined = op.buildId;
    if (op.buildId) {
      buildStatus = await readExactBuildPhase(op.buildId);
      if (buildStatus === "IN_PROGRESS" || buildStatus === "UNKNOWN") return viewOf(t, "running", { buildPhase: buildStatus });
    } else {
      // 没 attach 上 buildId:与部署同一份第二证据 + 结构窗(不早于 START_ABSENCE_MIN_AGE_MS)
      const startedMs = Date.parse(op.startedAt);
      if (!Number.isFinite(startedMs) || now - startedMs < START_ABSENCE_MIN_AGE_MS) return viewOf(t, "running", { buildPhase: "starting" });
      const evidence = await verifyNoBuildForOperation(op.operationId, op.startedAt, now).catch(() => undefined);
      if (evidence && !evidence.absent && evidence.candidateBuildId) {
        reportBuildId = evidence.candidateBuildId;
        buildStatus = await readExactBuildPhase(evidence.candidateBuildId);
        if (buildStatus === "IN_PROGRESS" || buildStatus === "UNKNOWN") return viewOf(t, "running", { buildPhase: buildStatus });
      } else {
        const w = noBuildRecoveryWindow(op.startedAt, now, evidence);
        if (!w.recoverable) return viewOf(t, "running", { buildPhase: "starting" });
        buildStatus = NO_BUILD_STATUS;
      }
    }
    const [facts, report] = await Promise.all([
      probeDecommissionFacts(t, plan?.finalSnapshotName),
      reportBuildId ? fetchDestroyReport(reportBuildId) : Promise.resolve(null),
    ]);
    const clean = facts.remaining.length === 0 && facts.unverifiable.length === 0;
    const desc = clean ? null : describeStuck(facts, report, buildStatus);
    const record: LastDestroyRecord = {
      at: new Date(now).toISOString(),
      outcome: clean ? "gone" : "stuck",
      operationId: op.operationId,
      ...(op.buildId ? { buildId: op.buildId } : {}),
      buildStatus,
      checkedAt: facts.checkedAt,
      remaining: facts.remaining,
      unverifiable: facts.unverifiable,
      ...(desc?.stuck ? { stuck: desc.stuck } : {}),
      retained: retainedFromReport(report, plan),
      ...(facts.finalSnapshot ? { finalSnapshot: facts.finalSnapshot } : {}),
    };
    if (!isStrictIsoInstant(record.checkedAt)) record.checkedAt = new Date(now).toISOString();
    const r = await settleDestroy(targetId, {
      fence: { expectedVersion: Number(t.version), session: { operationId: op.operationId, lockEpoch: op.lockEpoch, ...(op.buildId ? { buildId: op.buildId } : {}), buildStatus } },
      record,
      ...(desc ? { lastError: desc.text } : {}),
    });
    const after = (await getTargetRaw(targetId)) ?? t;
    return viewOf(after, r.phase === "gone" ? "settled-gone" : "settled-stuck", { buildPhase: buildStatus });
  }
  if (op) return viewOf(t, "running", { buildPhase: `operation=${op.kind}` });

  // 已卡住、无会话:再真查一次
  const facts = await probeDecommissionFacts(t, plan?.finalSnapshotName);
  if (facts.remaining.length === 0 && facts.unverifiable.length === 0) {
    const prev = (observed as { lastDestroy?: LastDestroyRecord }).lastDestroy;
    await settleDestroy(targetId, {
      fence: { expectedVersion: Number(t.version) },
      record: {
        at: new Date(now).toISOString(),
        outcome: "gone",
        buildStatus: prev?.buildStatus ?? NO_BUILD_STATUS,
        checkedAt: facts.checkedAt,
        remaining: [],
        unverifiable: [],
        retained: prev?.retained ?? plan?.retained ?? [],
        ...(facts.finalSnapshot ? { finalSnapshot: facts.finalSnapshot } : prev?.finalSnapshot ? { finalSnapshot: prev.finalSnapshot } : {}),
      },
    });
    const after = (await getTargetRaw(targetId)) ?? t;
    return viewOf(after, "settled-gone");
  }
  // 只读回报本次真查的残留(不写库:卡住态的 lastError / lastDestroy 只由收口那一次写,重探不覆盖「卡在哪」的原始证据)
  const prevRec = (observed as { lastDestroy?: LastDestroyRecord }).lastDestroy;
  return viewOf(t, "stuck", prevRec ? { lastDestroy: { ...prevRec, remaining: facts.remaining, unverifiable: facts.unverifiable, checkedAt: facts.checkedAt } } : {});
}
