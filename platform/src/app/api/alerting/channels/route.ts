export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { listChannels, createChannel } from "@/lib/alerting/channels";
import { redactChannel } from "@/lib/alerting/redact";

// GET /api/alerting/channels — 列出通知通道(viewer)。secret 脱敏后返回(不回明文)。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  try {
    const channels = await listChannels();
    return apiOk(channels.map(redactChannel));
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

// POST /api/alerting/channels — 新建通道(editor)。
export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  try {
    const channel = await createChannel(body, { createdBy: ctx.identity.username });
    recordAudit(req, "alerting.channel.create", { resourceType: "alert-channel", resourceId: channel.channelId, detail: { name: channel.name, type: channel.type } }).catch(() => {});
    return apiOk(redactChannel(channel), 201);
  } catch (e: any) {
    return apiError(e.message, 400);
  }
}
