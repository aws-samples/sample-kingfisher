export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { listContext, createContext, isKind, GLOBAL_SCOPE } from "@/lib/genbi/context";

// GET /api/genbi/context — 列出当前项目 + global 的业务口径/术语/规则（任意项目成员可读）。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  try {
    return apiOk(await listContext(ctx.projectId));
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

// POST /api/genbi/context — 新建条目（editor）。global 范围条目仅平台管理员可建。
export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  if (!body?.title || !String(body.title).trim()) return apiError("缺少名称");
  if (!isKind(body.kind)) return apiError("kind 必须是 caliber / term / rule");
  const wantGlobal = !!body.global;
  if (wantGlobal && !ctx.identity.isPlatformAdmin) return apiError("仅平台管理员可创建 global 通用条目", 403);
  try {
    const e = await createContext({
      projectId: wantGlobal ? GLOBAL_SCOPE : ctx.projectId,
      kind: body.kind,
      title: body.title,
      body: body.body || "",
      scope: body.scope || undefined,
      tags: Array.isArray(body.tags) ? body.tags : undefined,
      createdBy: ctx.identity.username,
    });
    recordAudit(req, "genbi.context.create", { resourceType: "genbi-context", resourceId: e.entryId, detail: { kind: e.kind, title: e.title, projectId: e.projectId } }).catch(() => {});
    return apiOk(e, 201);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
