export const dynamic = "force-dynamic";
// 🔴 **D4**:改名/删项目由「项目 owner」收紧为 **平台 admin ∨(manager ∧ 本项目 owner)**
//    (`requireProjectConfigAdmin`,判据与前端按钮显隐同源)。
// 🔴 **删项目前置校验**(§D4 最后一条):项目下资源/成员/数据面表**全为 0** 才可删,
//    否则 400 列明细。**不级联删除**(级联删数据风险过高,列二期)。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject, requireProjectConfigAdmin } from "@/lib/projects/guard";
import { DEFAULT_PROJECT_ID } from "@/lib/projects/constants";
import {
  getProject,
  listMembers,
  updateProject,
} from "@/lib/projects/project-service";
import { recordAudit } from "@/lib/audit";
import { getCorrelationId } from "@/lib/observability/logger";
// (根治的第二刀):删项目是长操作(kind project-delete,执行体 lib/projects/long-ops.ts:盘点 → 阻断 → 凭证回收入队 → 删)。
//   数仓冷恢复时盘点语句在执行体里等到终态,超 45s 由统一框架转 202(页面右下「正在后台执行:删除项目空间」),原「正在唤醒数仓」202 协议退役。
//   对象租约 `project:<id>`:删除进行中再改名 ⇒ 409「『删除项目空间』正在进行中」。
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";
import { resourceBusyResponse } from "@/lib/long-ops/guard";
import { resourceKey } from "@/lib/long-ops/kinds";

// GET /api/projects/[id] — project detail + members (requires membership).
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "viewer", params.id);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const project = await getProject(params.id);
    if (!project) return apiError("项目不存在", 404);
    const members = await listMembers(params.id);
    return apiOk({ ...project, members, myRole: ctx.role });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

// PUT /api/projects/[id] — update name/description(D4:admin ∨ manager-owner)。
export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requireProjectConfigAdmin(req, params.id);
  if (ctx instanceof NextResponse) return ctx;
  // 对象租约:这个项目正在被删 ⇒ 409,不改
  const busy = await resourceBusyResponse([resourceKey("project", params.id)]);
  if (busy) return busy;
  const body = await req.json().catch(() => ({}));
  try {
    const updated = await updateProject(params.id, { name: body.name, description: body.description });
    recordAudit(req, "project.update", { resourceType: "project", resourceId: params.id }).catch(() => {});
    return apiOk(updated);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

// DELETE /api/projects/[id] — delete the project and its memberships。默认空间不可删。
// D4:admin ∨ manager-owner;且**必须先清空**(资源/其它成员/数据面表全为 0)—— 判据在执行体 inventoryProject 里。
export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  if (params.id === DEFAULT_PROJECT_ID) return apiError("默认空间不可删除", 400);
  const ctx = await requireProjectConfigAdmin(req, params.id);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const result = await submitLongOp(
      { kind: "project-delete", params: { projectId: params.id }, correlationId: getCorrelationId(req) },
      { req, identity: ctx.identity },
    );
    return longOpResponse(req, result);
  } catch (e: any) {
    const lo = longOpErrorResponse(e);
    if (lo) return lo;
    return apiError(e.message, 500);
  }
}

// GET 用的只读盘点入口不在本路由:前端在弹删除确认前先调 DELETE 拿 400 明细即可
// (一次往返、判据与真删**完全同源**;另开一个"预检"端点就会有两份判据漂移的风险)。
