export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { resolveIdentity } from "@/lib/auth/identity";
import { recordAudit } from "@/lib/audit";
import { deleteContext, updateContext, isKind, GLOBAL_SCOPE } from "@/lib/genbi/context";

// PUT /api/genbi/context/[id] — 编辑条目（editor；global 条目仅平台管理员）。body 含
// projectId(pk) + 可编辑字段 kind/title/body/scope/tags。权限模型与 DELETE 一致。
export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let b: any;
  try { b = await req.json(); } catch { return apiError("请求体解析失败"); }
  const pid = b?.projectId || "";
  if (!pid) return apiError("缺少 projectId");
  if (pid === GLOBAL_SCOPE) {
    const identity = await resolveIdentity(req);
    if (!identity?.isPlatformAdmin) return apiError("仅平台管理员可编辑 global 条目", 403);
  } else {
    const ctx = await requireProject(req, "editor", pid);
    if (ctx instanceof NextResponse) return ctx;
  }
  if (b.kind !== undefined && !isKind(b.kind)) return apiError("类型非法");
  if (b.title !== undefined && !String(b.title).trim()) return apiError("名称不能为空");
  if (b.body !== undefined && !String(b.body).trim()) return apiError("定义/内容不能为空");
  try {
    const tags = b.tags !== undefined ? (Array.isArray(b.tags) ? b.tags : String(b.tags).split(/[，,\s]+/).filter(Boolean)) : undefined;
    const e = await updateContext(pid, params.id, { kind: b.kind, title: b.title, body: b.body, scope: b.scope, tags });
    recordAudit(req, "genbi.context.update", { resourceType: "genbi-context", resourceId: params.id, detail: { projectId: pid, kind: e.kind, title: e.title } }).catch(() => {});
    return apiOk(e);
  } catch (e: any) {
    return apiError(e.message, e.message === "条目不存在" ? 404 : 500);
  }
}

// DELETE /api/genbi/context/[id]?projectId=<pk> — 删除条目（editor；global 条目仅平台管理员）。
export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const pid = req.nextUrl.searchParams.get("projectId") || "";
  if (!pid) return apiError("缺少 projectId");
  if (pid === GLOBAL_SCOPE) {
    const identity = await resolveIdentity(req);
    if (!identity?.isPlatformAdmin) return apiError("仅平台管理员可删除 global 条目", 403);
  } else {
    const ctx = await requireProject(req, "editor", pid);
    if (ctx instanceof NextResponse) return ctx;
  }
  try {
    await deleteContext(pid, params.id);
    recordAudit(req, "genbi.context.delete", { resourceType: "genbi-context", resourceId: params.id, detail: { projectId: pid } }).catch(() => {});
    return apiOk({ deleted: true });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
