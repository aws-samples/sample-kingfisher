export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { getChannel } from "@/lib/alerting/channels";
import { dispatch } from "@/lib/alerting/notify";

// POST /api/alerting/channels/[id]/test — 向该通道发送一条测试消息,返回即时投递结果(editor)。
// 用于无头验证「通道联通性」:generic 通道指向 test-sink 时,可端到端确认收发。
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const channel = await getChannel(params.id);
  if (!channel) return apiError("通道不存在", 404);
  try {
    const { status, results } = await dispatch([channel], {
      title: "[测试] Kingfisher 告警通道联通性测试",
      severity: "P3",
      ruleName: "通道测试",
      message: "这是一条测试消息，用于验证该通知通道是否可正常收发。",
      trigger: { test: true, channelId: channel.channelId },
    });
    const result = results[0] || { ok: false, error: "无投递结果" };
    recordAudit(req, "alerting.channel.test", { resourceType: "alert-channel", resourceId: params.id, detail: { ok: result.ok } }).catch(() => {});
    return apiOk({ status, result });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
