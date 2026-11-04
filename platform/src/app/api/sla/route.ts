export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { listSlas, createSla } from "@/lib/baseline/sla-service";
// SLA 列表按执行范围(行上的 `targets[]` 派生自绑定对象)
import { readScope, filterRowsByScope } from "@/lib/exec-env/scope";

// GET /api/sla — SLA 定义列表(viewer)。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  try {
    const all = await listSlas(ctx.projectId);
    const scope = readScope(req);
    return apiOk({
      slas: scope
        ? (filterRowsByScope(all as unknown as Array<Record<string, unknown>>, scope) as unknown as typeof all)
        : all,
    });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

// POST /api/sla — 新建 SLA(editor)。
export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  try {
    const sla = await createSla(ctx.projectId, ctx.identity.username, body);
    recordAudit(req, "sla.create", { resourceType: "sla", resourceId: sla.slaId, detail: { name: sla.name, type: sla.target.type } }).catch(() => {});
    return apiOk(sla, 201);
  } catch (e: any) {
    return apiError(e.message, 400, { code: "VALIDATION_FAILED" });
  }
}
