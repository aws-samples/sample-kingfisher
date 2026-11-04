export const dynamic = "force-dynamic";
// (登记 CAP-SEED 交付)
// POST /api/seed/run  { targetId, dataset }  —— 「立即造数」:在**点名的那个执行范围**跑一次部署期的造数作业。
//
// 🔴 与定时造数**同一个作者** `runSeedOnce`(白名单 seed.run-once 的 author 就是它)。
// 🔴 权限:平台管理员(造数会重写该区的示范数据集 —— 主控区是 DROP + 重建源库 7 张表)。
// 🔴 落点只认点名(`requestedTargetId`):在哪个区造,就是页面复述的那个区;不给 ⇒ 400,绝不回落主控区。
// 🔴 202:Glue 要跑几分钟,接口只等到「启动成功 + run 台账已建」;终态由后台轮询写回台账(监控页看得见)。
import { NextRequest, NextResponse } from "next/server";
import { requireProject } from "@/lib/projects/guard";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requestedTargetId } from "@/lib/place/resolve";
import { runSeedOnce } from "@/lib/seed/run-once";
import { seedError } from "@/lib/seed/seed-http";

export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.identity.isPlatformAdmin) {
    return apiError("仅平台管理员可下发造数(会重写该区的示范数据集)", 403, { code: "RBAC_DENIED" });
  }
  let body: { targetId?: unknown; dataset?: unknown };
  try {
    body = await req.json();
  } catch {
    return apiError("请求体必须是 JSON", 400, { code: "VALIDATION_FAILED" });
  }
  try {
    const targetId = requestedTargetId(body.targetId, "下发造数");
    const r = await runSeedOnce({
      targetId,
      dataset: typeof body.dataset === "string" ? body.dataset : "",
      projectId: ctx.projectId,
      trigger: "manual",
    });
    await recordAudit(req, "seed.run", {
      resourceType: "seed",
      resourceId: r.jobName,
      targetId: r.targetId,
      detail: { jobRunId: r.jobRunId, runId: r.runId, region: r.region, dataset: body.dataset, via: "manual" },
    });
    return apiOk(r, 202);
  } catch (e) {
    return seedError(e);
  }
}
