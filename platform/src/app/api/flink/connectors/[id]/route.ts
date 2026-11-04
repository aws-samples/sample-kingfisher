export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { getConnector, deleteConnector } from "@/lib/realtime/flink-connectors";

// DELETE /api/flink/connectors/[id] — 删除自定义连接器(连同 S3 上的 JAR)。
export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const c = await getConnector(params.id);
  if (!c) return apiError("连接器不存在", 404, { code: "NOT_FOUND" });
  const ctx = await guardResourceAccess(req, c, "editor");
  if (ctx instanceof NextResponse) return ctx;
  try {
    await deleteConnector(params.id);
    recordAudit(req, "flink.connector.delete", { resourceType: "flink", resourceId: params.id, detail: { name: c.name } }).catch(() => {});
    return apiOk({ connectorId: params.id, deleted: true });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
