export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { getActiveEnv } from "@/lib/projects/guard";
import { tick } from "@/lib/copilot/plan/executor";
import type { CopilotCaller } from "@/lib/copilot/tools/types";

// POST /api/copilot/plan/[planId]/tick → 推进一次计划。editor。
// 【本期 L2】:计划 autoExecute=false,tick 只做 reconcile + unblock + 进度回写,【不代执行任何步骤】
//   (executor 的 claim 段因门控 A 跳过)。前端刷新计划态时可调用,幂等安全。
// 【未来 L3】:autoExecute=true 时,tick 才会 claim confirmed 步骤并经 StepHandler.execute 代执行。
export async function POST(req: NextRequest, props: { params: Promise<{ planId: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  try {
    const authz = req.headers.get("authorization") || "";
    const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
    const caller: CopilotCaller = { token, projectId: ctx.projectId, env: getActiveEnv(req) };
    const result = await tick(ctx.projectId, params.planId, caller);
    return apiOk(result);
  } catch (e: any) {
    return apiError(e?.message || "推进失败", 500);
  }
}
