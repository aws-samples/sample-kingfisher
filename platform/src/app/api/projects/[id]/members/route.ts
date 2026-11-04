export const dynamic = "force-dynamic";
// @kf-batch 52-P52.1-D4
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject, requireProjectConfigAdmin } from "@/lib/projects/guard";
import { listMembers, putMember } from "@/lib/projects/project-service";
import { isProjectRole } from "@/lib/projects/constants";
import { resolveUserSub } from "@/lib/auth/cognito-users";
import { recordAudit } from "@/lib/audit";

// GET /api/projects/[id]/members — list members (any member can view).
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "viewer", params.id);
  if (ctx instanceof NextResponse) return ctx;
  try {
    return apiOk(await listMembers(params.id));
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

// POST /api/projects/[id]/members — add or update a member's role。
// Body: { username, role, sub?, email? }
// 🔴 **D4 收紧**:由「项目 owner」改为 **平台 admin ∨(manager ∧ 本项目 owner)**
//    (纯 developer 即使是项目 owner 也管不了成员 —— 拍板原文;开发权不受影响)。
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requireProjectConfigAdmin(req, params.id);
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  if (!body?.username) return apiError("缺少 username");
  if (!isProjectRole(body.role)) return apiError("role 必须是 owner / editor / viewer");
  try {
    // 仅传用户名时，服务端解析其 Cognito sub/email 后落库，保证后续按 sub 精确授权可靠
    // （如需求指派 isAssignee）。Best-effort：解析失败仍按用户名建成员（授权层有用户名兜底）。
    let sub = body.sub as string | undefined;
    let email = body.email as string | undefined;
    if (!sub) {
      const resolved = await resolveUserSub(body.username);
      sub = resolved.sub;
      email = email || resolved.email;
    }
    const member = await putMember(
      params.id,
      { username: body.username, sub, email, role: body.role },
      ctx.identity.username
    );
    recordAudit(req, "project.member.put", {
      resourceType: "project",
      resourceId: params.id,
      detail: { username: body.username, role: body.role },
    }).catch(() => {});
    return apiOk(member, 201);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
