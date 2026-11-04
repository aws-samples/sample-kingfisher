export const dynamic = "force-dynamic";

// @kf-batch 50-WP5-rungroup
// POST /api/run-groups/[id]/retry-failed —— **权威地**算出「这一组里哪些区失败了」(50 SPEC v3.44 §2.7)。
//
// 🔴 它**刻意不自己扇出**:运行路由里有驻留同意前置 / 绑定校验 / 逐 target 审计 / 运行锁四段逻辑,
//    在这里复制一遍就是第二个作者(本仓 `schedule/enable` 硬编码 legacy 生成器那个事故的同族)。
//    ⇒ 本端点回一份**重试计划**,调用方拿着它打原来那条运行路由并带上 `retryOfRunGroupId`,
//    由那个唯一作者去建新组、扇出、记账。链子(`retryOfRunGroupId`)因此只有一个地方会写。
// 🔴 「哪些区算失败」由**服务端**判(不许客户端自己挑):客户端挑就可能把成功的区也重跑一遍。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { loadRunGroupForRequest } from "@/lib/monitor/run-group-http";

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let loaded;
  try {
    loaded = await loadRunGroupForRequest(req, params.id, "editor");
  } catch (e) {
    return apiError(`读取联动运行失败:${e instanceof Error ? e.message : String(e)}`, 500, { code: "UPSTREAM_ERROR" });
  }
  if (loaded instanceof NextResponse) return loaded;
  const { view } = loaded;

  if (view.derivedStatus === "running" || view.derivedStatus === "submitting") {
    return apiError("这一组还在跑,先等它跑完或先取消未完成的区", 409, {
      code: "CONFLICT",
      detail: { reason: "still-running", derivedStatus: view.derivedStatus },
    });
  }
  const failedTargets = Array.from(
    new Set(view.children.filter((c) => c.status === "failed").map((c) => c.targetId))
  );
  // 跳过的区(压根没提交出 run)同样属于「这次没跑成」⇒ 一并纳入重试
  for (const t of Object.keys(view.group.skipped ?? {})) if (!failedTargets.includes(t)) failedTargets.push(t);

  if (failedTargets.length === 0) {
    return apiError("这一组没有失败的执行范围,无需重试", 409, {
      code: "CONFLICT",
      detail: { reason: "nothing-failed", derivedStatus: view.derivedStatus },
    });
  }
  return apiOk({
    retryOfRunGroupId: params.id,
    definitionKind: view.group.definitionKind,
    definitionId: view.group.definitionId,
    targets: failedTargets,
  });
}
