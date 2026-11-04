export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { getChannel, updateChannel, deleteChannel } from "@/lib/alerting/channels";
import { redactChannel } from "@/lib/alerting/redact";

// GET /api/alerting/channels/[id] — 取单个通道(viewer,脱敏)。
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const channel = await getChannel(params.id);
  if (!channel) return apiError("通道不存在", 404);
  return apiOk(redactChannel(channel));
}

// PUT /api/alerting/channels/[id] — 更新通道(editor)。未回传的敏感字段保持原值。
export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  try {
    const updated = await updateChannel(params.id, body);
    if (!updated) return apiError("通道不存在", 404);
    recordAudit(req, "alerting.channel.update", { resourceType: "alert-channel", resourceId: params.id, detail: { name: updated.name } }).catch(() => {});
    return apiOk(redactChannel(updated));
  } catch (e: any) {
    return apiError(e.message, 400);
  }
}

// DELETE /api/alerting/channels/[id] — 删除通道(editor)。
export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const channel = await getChannel(params.id);
  if (!channel) return apiError("通道不存在", 404);
  try {
    await deleteChannel(params.id);
    recordAudit(req, "alerting.channel.delete", { resourceType: "alert-channel", resourceId: params.id, detail: { name: channel.name } }).catch(() => {});
    return apiOk({ deleted: true });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
