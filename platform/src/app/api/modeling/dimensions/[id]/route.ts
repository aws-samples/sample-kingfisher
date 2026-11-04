export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { updateModelTable, deleteModelTable } from "@/lib/modeling/dimensions";
import { recordAudit } from "@/lib/audit";
import { resourceBusyResponse } from "@/lib/long-ops/guard";
import { resourceKey } from "@/lib/long-ops/kinds";

// D3: 维度/事实表 改 / 删(仅平台管理员)。
export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可管理维度/事实表", 403);
  // §2.8 对象租约:应用 / 解绑进行中不许改定义
  const busy = await resourceBusyResponse([resourceKey("dimension", params.id)]);
  if (busy) return busy;
  const body = await req.json().catch(() => ({}));
  try {
    const t = await updateModelTable(params.id, body, identity.username);
    if (!t) return apiError("模型表不存在", 404);
    recordAudit(req, "modeling.dimension.update", { resourceType: "model-table", resourceId: params.id, detail: { name: t.name, tableType: t.tableType } }).catch(() => {});
    return apiOk(t);
  } catch (e: any) {
    return apiError(e.message);
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可管理维度/事实表", 403);
  // 删定义受控(与码表同一条;确认串 = 物理表名)。
  // §2.8 对象租约:应用 / 解绑进行中不许删定义(与码表同一条)
  const busy = await resourceBusyResponse([resourceKey("dimension", params.id)]);
  if (busy) return busy;
  const sp = req.nextUrl.searchParams;
  const keepTables = sp.get("keepTables") === "1" || sp.get("keepTables") === "true";
  const confirm = sp.get("confirm");
  try {
    const { keptTables } = await deleteModelTable(params.id, { keepTables, confirm });
    recordAudit(req, "modeling.dimension.delete", {
      resourceType: "model-table",
      resourceId: params.id,
      detail: { keptTables: keptTables.map((a) => ({ targetId: a.targetId, table: a.table, status: a.status, kept: "刻意保留" })) },
    }).catch(() => {});
    return apiOk({ deleted: true, keptTables });
  } catch (e: unknown) {
    const { DeleteDecisionRequired, UnbindRejected } = await import("@/lib/modeling/unbind-shared");
    if (e instanceof DeleteDecisionRequired) {
      return apiError(e.message, 409, { code: "DECISION_REQUIRED", detail: { artifacts: e.artifacts, confirmHint: "physicalTable" } });
    }
    if (e instanceof UnbindRejected) return apiError(e.message, 400, { code: "VALIDATION_FAILED", detail: { reason: e.reason } });
    return apiError((e as Error)?.message ?? String(e), 500);
  }
}
