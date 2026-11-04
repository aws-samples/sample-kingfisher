export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { isResourceType, loadResource, ResourceType } from "@/lib/versions/version-service";
import { lineageStatus } from "@/lib/env/promote-service";

// @kf-batch 50-SEQ47a-promote-ux
// GET /api/promote/lineage?type=&id=  —— 这份资源(按 lineageId)在 dev / staging / prod 各有没有一份、哪一版、谁何时发布的、
//   有没有待批准的发布审批。只读;项目成员(viewer)即可看。资源不存在 ⇒ 404。
export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type") || "";
  const id = req.nextUrl.searchParams.get("id") || "";
  if (!isResourceType(type) || !id) return apiError("缺少或非法的 type / id");
  const source = await loadResource(type as ResourceType, id);
  if (!source) return apiError("资源不存在", 404);
  const ctx = await guardResourceAccess(req, source, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const status = await lineageStatus(type as ResourceType, id);
  return apiOk(status);
}
