export const dynamic = "force-dynamic";
// @kf-batch 50-WP13-mwaa-region —— MWAA 环境 / 桶只经解析器(home 逐字节不变)
// @kf-batch 50-WP4quater-reads(工单 SC-3)—— 🔴 手动触发要打**这个工作流自己那个区**的 Airflow。
// 打主控区去 trigger 一个别区的 DAG,回的是「dag 不存在」;更坏的情况是主控区恰好有同名 DAG ⇒
// **触发了另一个区的同名工作流**(用户明令禁止的跨区域调度,而且完全无声)。
// 🔴 `MwaaNotInstalled` / `mwaaErrorResponse` 的判定与转换已收进 `schedulerRejectResponse`(单一作者)
// 模块 55 / 序 50 第二批:逐区触发主体(serverless StartWorkflowRun / 经典 MWAA 等调度器加载 DAG 再 trigger)在 lib/workflow/long-ops.ts(workflow-trigger);
//   路由只做读行 / 鉴权 / 子集校验 / 跨法域同意 / 运行组开立。超 45 秒由统一框架转 202;响应体保持摊平形状(rawBody)。
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
import { NextRequest, NextResponse } from "next/server";
// @kf-batch 50-WP31-place-first-class —— targets 子集的唯一解析作者
import { requestedSubset } from "@/lib/place/resolve";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { guardResourceAccess } from "@/lib/projects/guard";
// @kf-batch 52-P52.2-W2a-run-stamp — task-runs 唯一写通道(50 SPEC §6 S10)。
import { resolveRunStamp } from "@/lib/monitor/run-records";
// @kf-batch 50-WP18-workflow-fanout —— 编排的手动触发要**按全部绑定 target 扇出**(与离线作业同一条通道)
import { runGroupIdFor, isRunGroupId } from "@/lib/monitor/run-group";
import { openRunGroupIfFanout } from "@/lib/monitor/run-groups";
import { runGroupWriteErrorResponse } from "@/lib/monitor/run-group-http";
import { requireResidencyAckForTargets, residencyErrorResponse } from "@/lib/exec-env/residency-audit";
import { getCorrelationId } from "@/lib/observability/logger";
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";

const USER_ID = "default-user";

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.WORKFLOWS, Key: { userId: USER_ID, workflowId: params.id } })
  );
  if (!Item) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const guard = await guardResourceAccess(req, Item, "editor");
  if (guard instanceof NextResponse) return guard;
  if (!Item.airflowDagId) return NextResponse.json({ error: "请先发布工作流" }, { status: 400 });

  // @kf-batch 50-WP18-workflow-fanout
  // 🔴🔴 用户 2026-09-15 逐字点名:「我不是让你在美东1 发布执行多个区域吗?」
  //    这里原来是 `bindingTargets(...)[0]` —— **手动触发只取第一个绑定 target,压根不扇出**:
  //    界面上两个区都亮着、点一次「触发」只有一个区真跑,而另一个区**什么都没发生**且不报错。
  //    与离线作业那条已经跑通的通道对齐:缺省 = **全部绑定**,`targets` 可给子集但必须是绑定的子集
  //    (不在绑定里的直接拒,不静默忽略);多区共享一个 `runGroupId`,逐区各自 try、各自记台账。
  const body = (await req.json().catch(() => ({}))) as { targets?: unknown; retryOfRunGroupId?: unknown };
  const bound = bindingTargets(Item as { targets?: unknown; targetId?: unknown });
  let runTargets = bound.length ? bound : ["tgt_home"];
  const want = requestedSubset(body);
  if (want) {
    const unknownT = want.filter((t) => !runTargets.includes(t));
    if (unknownT.length) {
      return NextResponse.json(
        { error: `以下执行目标不在该工作流的绑定里,已拒绝:${unknownT.join("/")}(当前绑定:${runTargets.join("/")})`, code: "CONFLICT" },
        { status: 409 }
      );
    }
    if (want.length === 0) {
      return NextResponse.json({ error: "targets 传了空列表:没有可运行的执行目标", code: "VALIDATION_FAILED" }, { status: 400 });
    }
    runTargets = want;
  }
  // 跨法域同意前置:**先判全部 target 再触发任何一个**(与离线作业同款,SPEC §3.2)
  try {
    await requireResidencyAckForTargets(guard.identity, runTargets);
  } catch (e) {
    const r = residencyErrorResponse(e);
    if (r) return r;
    throw e;
  }
  const retryOf = typeof body?.retryOfRunGroupId === "string" ? body.retryOfRunGroupId : undefined;
  if (retryOf !== undefined && !isRunGroupId(retryOf)) {
    return NextResponse.json({ error: `retryOfRunGroupId 形态非法:${String(retryOf)}`, code: "VALIDATION_FAILED" }, { status: 400 });
  }
  const runGroupId = runGroupIdFor(runTargets, { forceGroup: !!retryOf });
  try {
    await openRunGroupIfFanout({
      runGroupId,
      definitionKind: "workflow",
      definitionId: params.id,
      projectId: resolveRunStamp(Item).projectId,
      requestedTargets: runTargets,
      triggeredBy: "manual",
      ...(retryOf ? { retryOfRunGroupId: retryOf } : {}),
    });
  } catch (e) {
    const r = runGroupWriteErrorResponse(e);
    if (r) return r;
    throw e;
  }

  try {
    const result = await submitLongOp(
      {
        kind: "workflow-trigger",
        params: { workflowId: params.id, targets: runTargets, ...(runGroupId ? { runGroupId } : {}) },
        correlationId: getCorrelationId(req),
      },
      { req, identity: guard.identity },
    );
    return longOpResponse(req, result);
  } catch (e: any) {
    const lo = longOpErrorResponse(e);
    if (lo) return lo;
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
