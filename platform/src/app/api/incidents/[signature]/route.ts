export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { getMaster, listOccurrences, updateResolution } from "@/lib/incidents/store";

// GET /api/incidents/[signature] — 单类故障详情:主档 + 发生时间线。RBAC: viewer。
// signature 含 "::"/"#",调用方须 encodeURIComponent;Next.js 自动解码 params。
export async function GET(req: NextRequest, props: { params: Promise<{ signature: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const signature = decodeURIComponent(params.signature);
  try {
    const master = await getMaster(ctx.projectId, signature);
    if (!master) return apiError("故障类别不存在", 404, { code: "NOT_FOUND" });
    const occurrences = await listOccurrences(ctx.projectId, signature);
    return apiOk({ master, occurrences });
  } catch (e: any) {
    return apiError(e.message || String(e), 500);
  }
}

// PUT /api/incidents/[signature] — 维护"已验证修复手册" + 标记 verified(乐观锁 version)。RBAC: editor。
// body: { markdown, verified, fixKind, backfillHint, status, version }
export async function PUT(req: NextRequest, props: { params: Promise<{ signature: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const signature = decodeURIComponent(params.signature);
  const body = await req.json().catch(() => ({}));
  try {
    const updated = await updateResolution(ctx.projectId, signature, {
      markdown: body?.markdown,
      verified: body?.verified,
      fixKind: body?.fixKind,
      backfillHint: body?.backfillHint,
      status: body?.status,
      expectedVersion: parseInt(body?.version, 10),
      actor: ctx.identity.username,
    });
    recordAudit(req, "incident.resolution.update", {
      resourceType: "incident",
      resourceId: signature,
      detail: { verified: !!body?.verified, fixKind: body?.fixKind },
    }).catch(() => {});
    return apiOk(updated);
  } catch (e: any) {
    if (e?.code === "CONFLICT") return apiError(e.message, 409, { code: "CONFLICT" });
    if (e?.code === "NOT_FOUND") return apiError(e.message, 404, { code: "NOT_FOUND" });
    return apiError(e.message || String(e), 500);
  }
}
