export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import {
  isResourceType,
  loadResource,
  listVersions,
  getVersion,
  rollbackToVersion,
  ResourceType,
} from "@/lib/versions/version-service";

// GET /api/versions?type=<t>&id=<id>            → list a resource's version history (viewer)
// GET /api/versions?type=<t>&id=<id>&version=N  → fetch one version's full snapshot (viewer)
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const type = p.get("type") || "";
  const id = p.get("id") || "";
  const versionStr = p.get("version");
  if (!isResourceType(type) || !id) return apiError("缺少或非法的 type / id");

  const item = await loadResource(type as ResourceType, id);
  if (!item) return apiError("资源不存在", 404);
  const guard = await guardResourceAccess(req, item, "viewer");
  if (guard instanceof NextResponse) return guard;

  try {
    if (versionStr) {
      const v = await getVersion(type as ResourceType, id, Number(versionStr));
      if (!v) return apiError("版本不存在", 404);
      return apiOk(v);
    }
    return apiOk(await listVersions(type as ResourceType, id));
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

// POST /api/versions  body { type, id, version }  → roll the resource back to that version (editor)
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { type, id, version } = body || {};
  if (!isResourceType(type) || !id || version === undefined) {
    return apiError("缺少或非法的 type / id / version");
  }

  const item = await loadResource(type as ResourceType, id);
  if (!item) return apiError("资源不存在", 404);
  const guard = await guardResourceAccess(req, item, "editor");
  if (guard instanceof NextResponse) return guard;

  try {
    const restored = await rollbackToVersion(type as ResourceType, id, Number(version), guard.identity.username);
    if (!restored) return apiError("版本不存在", 404);
    recordAudit(req, "resource.rollback", {
      resourceType: type,
      resourceId: id,
      detail: { version: Number(version) },
    }).catch(() => {});
    return apiOk(restored);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
