export const dynamic = "force-dynamic";
// (治理)
// GET  /api/governance/schedules?scope=   当前项目的定时治理任务(按执行范围过滤;读路由口径)
// POST /api/governance/schedules          建一个定时治理任务(**未启用**;启用走 POST /api/schedule/enable taskType=governance)
//
// 🔴 权限与手动按钮**同一档**:质量检查 / 敏感扫描 / 目录同步的手动入口都只许平台管理员 ⇒ 建它们的定时任务也只许平台管理员
//    (否则编辑者可以借定时任务绕过手动入口的那道门)。读列表 = 项目 viewer。
// 🔴 落点只认点名(`requestedTargetId`):这个任务**在哪个区跑**,就是建它时页面复述的那个执行范围;
//    每区自治调度(用户拍板),多区就各建一个。
// 🔴 「目录同步」勾上 `redshift` = 定时唤醒该区数仓(计费)—— 页面上明示;服务端照单执行,不替用户决定。
import { NextRequest, NextResponse } from "next/server";
import { ulid } from "ulid";
import { requireProject } from "@/lib/projects/guard";
import { requireScope, filterRowsByScope } from "@/lib/exec-env/scope";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requestedTargetId } from "@/lib/place/resolve";
import { requireReadyTarget } from "@/lib/exec-env/registry";
import { GOVERNANCE_ACTION_IDS } from "@/lib/scheduler/action-commands";
import { createActionSchedule, listActionSchedules } from "@/lib/scheduler/action-schedules";
import { actionScheduleError, attachActionCarrierDrift } from "@/lib/scheduler/action-schedules-http";

export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const scope = await requireScope(req, ctx.projectId);
  if (scope instanceof NextResponse) return scope;
  try {
    const all = (await listActionSchedules("governance")).filter((r) => r.projectId === ctx.projectId);
    const rows = filterRowsByScope(all as unknown as Array<Record<string, unknown>>, scope) as unknown as typeof all;
    if (req.nextUrl.searchParams.get("withDrift") === "1") await attachActionCarrierDrift(rows);
    return apiOk(rows);
  } catch (e) {
    return actionScheduleError(e);
  }
}

export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.identity.isPlatformAdmin) {
    return apiError("仅平台管理员可建定时治理任务(与手动运行质量检查 / 敏感扫描 / 目录同步同一档权限)", 403, { code: "RBAC_DENIED" });
  }
  let body: { name?: unknown; action?: unknown; params?: unknown; targetId?: unknown; cronExpression?: unknown };
  try {
    body = await req.json();
  } catch {
    return apiError("请求体必须是 JSON", 400, { code: "VALIDATION_FAILED" });
  }
  try {
    const targetId = requestedTargetId(body.targetId, "建定时治理任务");
    const action = String(body.action || "");
    if (!(GOVERNANCE_ACTION_IDS as readonly string[]).includes(action)) {
      return apiError(`治理定时任务的动作只能是 ${GOVERNANCE_ACTION_IDS.join(" / ")}`, 400, { code: "VALIDATION_FAILED" });
    }
    const name = String(body.name || "").trim();
    if (!name || name.length > 80) return apiError("名称必填且不超过 80 字", 400, { code: "VALIDATION_FAILED" });
    // 🔴 建的时候就确认那个区**能承接**(不可承接 ⇒ 409 说清,不建一个注定发布不出去的任务)
    await requireReadyTarget(targetId);
    const row = await createActionSchedule({
      taskId: `gov_${ulid()}`,
      kind: "governance",
      name,
      projectId: ctx.projectId,
      targets: [targetId],
      action,
      params: (body.params && typeof body.params === "object" ? body.params : {}) as Record<string, unknown>,
      cronExpression: typeof body.cronExpression === "string" && body.cronExpression.trim() ? body.cronExpression.trim() : null,
      ownerSub: ctx.identity.sub,
      ownerUsername: ctx.identity.username,
    });
    await recordAudit(req, "governance.schedule.create", {
      resourceType: "action-schedule",
      resourceId: row.taskId,
      targetId,
      detail: { action, name, params: row.params },
    });
    return apiOk(row);
  } catch (e) {
    return actionScheduleError(e);
  }
}
