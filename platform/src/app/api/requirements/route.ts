export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { availableActions, createRequirement, filterBox, listByProject, type Box } from "@/lib/requirements/service";

// GET /api/requirements?box=mine|assigned|inbox|all — 角色感知列表（当前项目空间）。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const box = (req.nextUrl.searchParams.get("box") || "mine") as Box;
  try {
    const all = await listByProject(ctx.projectId);
    const list = filterBox(all, box, ctx.identity).map((r) => ({
      ...r,
      _actions: availableActions(r, ctx.identity),
    }));
    return apiOk(list);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

// POST /api/requirements — 提需求（GenBI 提为需求 或 工作台手工建）。任意项目成员可提。
export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  if (!body?.title || !String(body.title).trim()) return apiError("缺少需求标题");
  try {
    const r = await createRequirement({
      projectId: ctx.projectId,
      title: body.title,
      description: body.description || "",
      priority: body.priority,
      businessValue: body.businessValue,
      acceptanceCriteria: body.acceptanceCriteria,
      source: body.source && body.source.kind === "genbi" ? body.source : undefined,
      identity: ctx.identity,
    });
    recordAudit(req, "requirement.create", {
      resourceType: "requirement",
      resourceId: r.requirementId,
      detail: { title: r.title, projectId: ctx.projectId, fromGenbi: !!r.source },
    }).catch(() => {});
    return apiOk(r, 201);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
