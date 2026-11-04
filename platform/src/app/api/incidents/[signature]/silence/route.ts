export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { silenceIncident, getMaster } from "@/lib/incidents/store";

// POST /api/incidents/[signature]/silence — 抑制该类故障(已知无害/待排期)。RBAC: editor。
// body: { silenceUntil }(ISO;缺省抑制 30 天)。
export async function POST(req: NextRequest, props: { params: Promise<{ signature: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const signature = decodeURIComponent(params.signature);
  const body = await req.json().catch(() => ({}));
  const silenceUntil =
    typeof body?.silenceUntil === "string" && body.silenceUntil
      ? body.silenceUntil
      : new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  try {
    const master = await getMaster(ctx.projectId, signature);
    if (!master) return apiError("故障类别不存在", 404, { code: "NOT_FOUND" });
    await silenceIncident(ctx.projectId, signature, silenceUntil);
    recordAudit(req, "incident.silence", { resourceType: "incident", resourceId: signature, detail: { silenceUntil } }).catch(() => {});
    return apiOk({ signature, status: "silenced", silenceUntil });
  } catch (e: any) {
    return apiError(e.message || String(e), 500);
  }
}
