export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { getCodeTable, updateCodeTable, deleteCodeTable } from "@/lib/modeling/service";
import { recordAudit } from "@/lib/audit";
import { resourceBusyResponse } from "@/lib/long-ops/guard";
import { resourceKey } from "@/lib/long-ops/kinds";

// 码表 详情 / 改 / 删。
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  const ct = await getCodeTable(params.id);
  if (!ct) return apiError("码表不存在", 404);
  return apiOk(ct);
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可管理码表", 403);
  // §2.8 对象租约:落地 / 解绑进行中不许改定义(否则后续步骤核的是另一份定义)
  const busy = await resourceBusyResponse([resourceKey("codetable", params.id)]);
  if (busy) return busy;
  const body = await req.json().catch(() => ({}));
  try {
    const updated = await updateCodeTable(params.id, body);
    if (!updated) return apiError("码表不存在", 404);
    recordAudit(req, "modeling.codetable.update", { resourceType: "code-table", resourceId: params.id }).catch(() => {});
    return apiOk(updated);
  } catch (e: any) {
    return apiError(e.message);
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可管理码表", 403);
  // 删定义**受控**(50 SPEC v3.20 §3.8):仍有落地产物 ⇒ 409 DECISION_REQUIRED,
  //   出口 = 逐区〔解绑并清理〕/ `?keepTables=1&confirm=<code>` 显式保留物理表只删定义(审计逐表登记)。
  //   修之前:只删 DDB 一行,每个区的物理表原地成孤儿、平台从此不知道它们。
  // §2.8 对象租约:落地 / 解绑进行中不许删定义(2026-10-22 实测:落地中被删 ⇒ 目标区留物理表孤儿)
  const busy = await resourceBusyResponse([resourceKey("codetable", params.id)]);
  if (busy) return busy;
  const sp = req.nextUrl.searchParams;
  const keepTables = sp.get("keepTables") === "1" || sp.get("keepTables") === "true";
  const confirm = sp.get("confirm");
  try {
    const { keptTables } = await deleteCodeTable(params.id, { keepTables, confirm });
    recordAudit(req, "modeling.codetable.delete", {
      resourceType: "code-table",
      resourceId: params.id,
      detail: { keptTables: keptTables.map((a) => ({ targetId: a.targetId, table: a.table, status: a.status, kept: "刻意保留" })) },
    }).catch(() => {});
    return apiOk({ deleted: true, keptTables });
  } catch (e: unknown) {
    const { DeleteDecisionRequired, UnbindRejected } = await import("@/lib/modeling/unbind-shared");
    if (e instanceof DeleteDecisionRequired) {
      return apiError(e.message, 409, { code: "DECISION_REQUIRED", detail: { artifacts: e.artifacts, confirmHint: "code" } });
    }
    if (e instanceof UnbindRejected) return apiError(e.message, 400, { code: "VALIDATION_FAILED", detail: { reason: e.reason } });
    return apiError((e as Error)?.message ?? String(e), 500);
  }
}
