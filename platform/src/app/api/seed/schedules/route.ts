export const dynamic = "force-dynamic";
// (登记 CAP-SEED 交付)
// GET  /api/seed/schedules?scope=   当前项目的定时造数任务(按执行范围过滤;读路由口径)
// POST /api/seed/schedules          建一个定时造数任务(**未启用**;启用走 POST /api/schedule/enable taskType=seed)
//
// 载体与治理定时同款:单节点 platform-action 工作流(动作 `seed.run-once`),逐区发到**该区**的 MWAA Serverless。
// 🔴 权限与「立即造数」同一档:平台管理员(否则编辑者可以借定时任务绕过手动入口的那道门)。读列表 = 项目 viewer。
// 🔴 落点只认点名:这个任务**在哪个区造数**,就是建它时页面复述的那个执行范围;每区自治调度,多区就各建一个。
// 🔴 建的时候就确认该区**能承接**且**真有造数作业**(生产模式 / 没跑过部署期造数 ⇒ 409 说清,不建一个注定失败的定时任务)。
import { NextRequest, NextResponse } from "next/server";
import { ulid } from "ulid";
import { requireProject } from "@/lib/projects/guard";
import { requireScope, filterRowsByScope } from "@/lib/exec-env/scope";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requestedTargetId } from "@/lib/place/resolve";
import { requireReadyTarget } from "@/lib/exec-env/registry";
import { SEED_ACTION_ID } from "@/lib/scheduler/action-commands";
import { createActionSchedule, listActionSchedules } from "@/lib/scheduler/action-schedules";
import { attachActionCarrierDrift } from "@/lib/scheduler/action-schedules-http";
import { assertSeedJobPresent } from "@/lib/seed/run-once";
import { seedError } from "@/lib/seed/seed-http";

export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const scope = await requireScope(req, ctx.projectId);
  if (scope instanceof NextResponse) return scope;
  try {
    const all = (await listActionSchedules("seed")).filter((r) => r.projectId === ctx.projectId);
    const rows = filterRowsByScope(all as unknown as Array<Record<string, unknown>>, scope) as unknown as typeof all;
    if (req.nextUrl.searchParams.get("withDrift") === "1") await attachActionCarrierDrift(rows);
    return apiOk(rows);
  } catch (e) {
    return seedError(e);
  }
}

export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.identity.isPlatformAdmin) {
    return apiError("仅平台管理员可建定时造数任务(与「立即造数」同一档权限)", 403, { code: "RBAC_DENIED" });
  }
  let body: { name?: unknown; dataset?: unknown; targetId?: unknown; cronExpression?: unknown };
  try {
    body = await req.json();
  } catch {
    return apiError("请求体必须是 JSON", 400, { code: "VALIDATION_FAILED" });
  }
  try {
    const targetId = requestedTargetId(body.targetId, "建定时造数任务");
    const name = String(body.name || "").trim();
    if (!name || name.length > 80) return apiError("名称必填且不超过 80 字", 400, { code: "VALIDATION_FAILED" });
    await requireReadyTarget(targetId);
    await assertSeedJobPresent(targetId);
    const row = await createActionSchedule({
      taskId: `seedsch_${ulid()}`,
      kind: "seed",
      name,
      projectId: ctx.projectId,
      targets: [targetId],
      action: SEED_ACTION_ID,
      // 🔴 参数原样交给单一校验(`validateActionParams`):没点名数据集 ⇒ 400,不替用户补默认值
      params: { dataset: typeof body.dataset === "string" ? body.dataset : "" },
      cronExpression: typeof body.cronExpression === "string" && body.cronExpression.trim() ? body.cronExpression.trim() : null,
      ownerSub: ctx.identity.sub,
      ownerUsername: ctx.identity.username,
    });
    await recordAudit(req, "seed.schedule.create", {
      resourceType: "action-schedule",
      resourceId: row.taskId,
      targetId,
      detail: { action: SEED_ACTION_ID, name, params: row.params },
    });
    return apiOk(row);
  } catch (e) {
    return seedError(e);
  }
}
