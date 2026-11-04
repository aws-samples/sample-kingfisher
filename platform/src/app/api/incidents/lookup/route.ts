export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { lookupIncident } from "@/lib/incidents/lookup";

// POST /api/incidents/lookup  body { signature? , taskType?, errorText? }
// 给定 signature(或由 taskType+errorText 现算),返回该签名的"已验证修复手册" + 复发次数 +
// 最近修复时间。RBAC: viewer。检索逻辑集中在 lib/incidents/lookup.ts(诊断编排 grounding 与本
// 端点复用同一实现,零漂移)。
// A.1 阶段本端点已可用(供页面"套用历史修复"探测);A.2 由诊断证据构造(evidence.ts)在进程内
// 直接调 lookupIncident() 注入历史修复到 DevOps Agent 证据 prompt(不经此 HTTP 端点)。
export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));

  const signature = (body?.signature || "").trim();
  const errorText = String(body?.errorText || "");
  if (!signature && !errorText) return apiError("需提供 signature 或 errorText", 400, { code: "VALIDATION_FAILED" });

  try {
    const result = await lookupIncident({
      projectId: ctx.projectId,
      signature,
      taskType: String(body?.taskType || ""),
      errorText,
    });
    return apiOk(result);
  } catch (e: any) {
    return apiError(e.message || String(e), 500);
  }
}
