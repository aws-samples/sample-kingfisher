export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { listSinkHits } from "@/lib/alerting/test-sink";

// GET /api/alerting/test-sink — 查看最近收到的自测投递(viewer),验收/回看用。
// 接收端(POST)是公开的 /api/public/alerting-sink(webhook 靶不带登录态,见该文件说明)。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  try {
    return apiOk(await listSinkHits());
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
