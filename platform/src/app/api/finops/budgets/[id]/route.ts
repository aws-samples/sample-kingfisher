export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { DEFAULT_PROJECT_ID } from "@/lib/projects/constants";
import { getBudget, updateBudget, deleteBudget } from "@/lib/finops/store";

// PUT /api/finops/budgets/[id] — 更新预算(乐观锁 version)。RBAC: owner。
export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "owner");
  if (ctx instanceof NextResponse) return ctx;

  try {
    const existing = await getBudget(DEFAULT_PROJECT_ID, params.id);
    if (!existing) return apiError("预算不存在", 404);
    const body = await req.json();
    const expectVersion = Number(body.version);
    if (!expectVersion) return apiError("缺少 version(乐观锁)", 400);

    const next = {
      ...existing,
      ...(body.name !== undefined ? { name: String(body.name).trim() } : {}),
      ...(body.monthlyLimitUsd !== undefined ? { monthlyLimitUsd: Number(body.monthlyLimitUsd) } : {}),
      ...(body.channelIds !== undefined ? { channelIds: (body.channelIds as unknown[]).map(String) } : {}),
      ...(body.enabled !== undefined ? { enabled: !!body.enabled } : {}),
    };
    if (!(next.monthlyLimitUsd > 0)) return apiError("月限额必须为正数", 400);

    try {
      await updateBudget(next, expectVersion);
    } catch (e: unknown) {
      if ((e as { name?: string }).name === "ConditionalCheckFailedException") {
        return apiError("版本冲突:预算已被他人修改,请刷新后重试", 409);
      }
      throw e;
    }
    return apiOk({ ...next, version: expectVersion + 1 });
  } catch (e: unknown) {
    return apiError((e as Error).message || String(e), 500);
  }
}

// DELETE /api/finops/budgets/[id] — 删除预算。RBAC: owner。
export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "owner");
  if (ctx instanceof NextResponse) return ctx;

  try {
    await deleteBudget(DEFAULT_PROJECT_ID, params.id);
    return apiOk({ deleted: params.id });
  } catch (e: unknown) {
    return apiError((e as Error).message || String(e), 500);
  }
}
