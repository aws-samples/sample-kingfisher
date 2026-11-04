export const dynamic = "force-dynamic";
// (登记 CAP-SEED 交付)
// GET    /api/seed/schedules/[taskId]   取一个定时造数任务
// PATCH  /api/seed/schedules/[taskId]   改草稿(名称 / cron;**启用中不许改**:先停用再改)
// DELETE /api/seed/schedules/[taskId]   删除(先把每个有产物的区真撤下来;撤不下来 ⇒ 502,行不删)
//
// 🔴 守卫按**资源自己的归属项目**判,且授权在「存不存在」之前(404 本身就是存在性预言机)。
// (数据集只有一套 ⇒ PATCH 只收名称 / cron,不收参数。)
import { NextRequest, NextResponse } from "next/server";
import { guardResourceAccess } from "@/lib/projects/guard";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { deleteActionSchedule, getActionSchedule, updateActionScheduleDraft, type ActionScheduleRow } from "@/lib/scheduler/action-schedules";
import { seedError } from "@/lib/seed/seed-http";

async function load(req: NextRequest, taskId: string, min: "viewer" | "editor") {
  const row = await getActionSchedule(taskId);
  const ctx = await guardResourceAccess(req, row ?? undefined, min);
  if (ctx instanceof NextResponse) return ctx;
  if (!row || row.kind !== "seed") return apiError("定时造数任务不存在", 404, { code: "NOT_FOUND" });
  return { ctx, row: row as ActionScheduleRow };
}

export async function GET(req: NextRequest, props: { params: Promise<{ taskId: string }> }) {
  const params = await props.params;
  try {
    const r = await load(req, params.taskId, "viewer");
    if (r instanceof NextResponse) return r;
    return apiOk(r.row);
  } catch (e) {
    return seedError(e);
  }
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ taskId: string }> }) {
  const params = await props.params;
  try {
    const r = await load(req, params.taskId, "editor");
    if (r instanceof NextResponse) return r;
    if (!r.ctx.identity.isPlatformAdmin) return apiError("仅平台管理员可改定时造数任务", 403, { code: "RBAC_DENIED" });
    const body = (await req.json().catch(() => ({}))) as { name?: unknown; cronExpression?: unknown };
    const next = await updateActionScheduleDraft(r.row, {
      ...(typeof body.name === "string" ? { name: body.name.trim() } : {}),
      ...(body.cronExpression !== undefined
        ? { cronExpression: typeof body.cronExpression === "string" && body.cronExpression.trim() ? body.cronExpression.trim() : null }
        : {}),
    });
    await recordAudit(req, "seed.schedule.update", { resourceType: "action-schedule", resourceId: next.taskId, targetId: next.targets[0] });
    return apiOk(next);
  } catch (e) {
    return seedError(e);
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ taskId: string }> }) {
  const params = await props.params;
  try {
    const r = await load(req, params.taskId, "editor");
    if (r instanceof NextResponse) return r;
    if (!r.ctx.identity.isPlatformAdmin) return apiError("仅平台管理员可删定时造数任务", 403, { code: "RBAC_DENIED" });
    await deleteActionSchedule(r.row);
    await recordAudit(req, "seed.schedule.delete", { resourceType: "action-schedule", resourceId: r.row.taskId, targetId: r.row.targets[0] });
    return apiOk({ deleted: true, taskId: r.row.taskId });
  } catch (e) {
    return seedError(e);
  }
}
