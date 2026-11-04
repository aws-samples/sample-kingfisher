export const dynamic = "force-dynamic";
// @kf-batch 50-WP28-platform-action-node
// POST /api/internal/actions/run  { commandId }  —— **平台内部端点**(唯一调用方:主控区的分发 Lambda)。
//
// 链路:执行区 DAG 的 platform-action 节点 → 主控区命令表 `bgp-action-commands`(pending)
//       → DDB Streams → 分发 Lambda(平台 VPC 内)→ 本端点 → `dispatchCommand`(校验 + 抢单)
//       → 后台执行白名单动作的库函数 → 命令行写终态 → DAG 轮询到终态(failed ⇒ task 失败)。
//
// 🔴 鉴权见 `lib/scheduler/internal-guard.ts`(不经 CloudFront + 来源头 + Secrets Manager 共享密钥);
//    身份映射为系统主体 `system:action-dispatcher`,每次调用(含被拒)都进审计且带 `via=schedule`。
// 🔴 请求体里**只认 commandId**:动作与参数从命令表那一行读(IAM 授权写入),HTTP 带不进别的东西。
// 🔴 回 202 后在后台执行:动作可能跑几分钟,而 ALB 空闲超时 60s;执行体收口由状态机保证(永不停在 running)。
import { NextRequest, NextResponse } from "next/server";
import { writeAuditRecord } from "@/lib/audit";
import { verifyInternalCaller, INTERNAL_PRINCIPAL } from "@/lib/scheduler/internal-guard";
import { dispatchCommand } from "@/lib/scheduler/action-dispatch";
import { ACTION_HANDLERS } from "@/lib/scheduler/action-handlers";

const PATH = "/api/internal/actions/run";

// 🔴 审计落点是**观测到的**那个区(命令行上的章);还没读到命令时(被拒)就是 null —— 显式写出来,不留可选位。
function audit(action: string, resourceId: string, detail: Record<string, unknown>, place: { targetId: string } | null = null) {
  return writeAuditRecord(
    { actor: INTERNAL_PRINCIPAL.actor },
    action,
    { resourceType: "action-command", resourceId, ...(place ? { targetId: place.targetId } : {}), detail: { ...detail, via: INTERNAL_PRINCIPAL.via } },
    { method: "POST", path: PATH }
  ).catch((e) => console.error("[internal/actions/run] 审计写失败:%s", String(e)));
}

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status });
}

export async function POST(req: NextRequest) {
  const verdict = await verifyInternalCaller(req.headers);
  if (!verdict.ok) {
    // 🔴 被拒也要留痕(谁在用错误的密钥敲内部端点,事后要查得到)
    await audit("internal.action.denied", "-", { status: verdict.status, reason: verdict.reason });
    return json(verdict.status, { success: false, error: { message: verdict.reason } });
  }
  let commandId = "";
  try {
    const body = (await req.json()) as { commandId?: unknown };
    commandId = typeof body?.commandId === "string" ? body.commandId.trim() : "";
  } catch {
    /* 下面统一按缺参处理 */
  }
  if (!commandId || commandId.length > 80) {
    await audit("internal.action.denied", "-", { status: 400, reason: "缺 commandId" });
    return json(400, { success: false, error: { message: "缺 commandId" } });
  }

  const out = await dispatchCommand(commandId, ACTION_HANDLERS);
  if (out.kind === "missing") {
    await audit("internal.action.denied", commandId, { status: 404, reason: "命令不存在" });
    return json(404, { success: false, error: { message: "命令不存在" } });
  }
  if (out.kind === "rejected") {
    // 白名单外 / 参数不合法 / 缺项目 ⇒ 403(命令已被判 failed,DAG 那头会看到真因)
    await audit("internal.action.denied", commandId, { status: 403, reason: out.reason, action: out.action });
    return json(403, { success: false, error: { message: out.reason } });
  }
  if (out.kind === "not-pending") {
    // Streams 至少一次投递 ⇒ 重复到达是常态:已被抢 / 已终态 ⇒ 409(Lambda 视为已处理,不重试)
    return json(409, { success: false, error: { message: `命令当前状态 ${out.status},不是 pending —— 已被处理` } });
  }
  const c = out.command;
  await audit("internal.action.dispatch", commandId, { action: c.action, taskId: c.taskId, runId: c.runId, projectId: c.projectId }, { targetId: c.targetId });
  // 后台执行(不 await):收口由 runClaimedCommand 保证
  void out.execution.then(
    () => audit("internal.action.finished", commandId, { action: c.action, taskId: c.taskId }, { targetId: c.targetId }),
    (e) => console.error("[internal/actions/run] 后台执行异常(不应发生,runClaimedCommand 永不抛):%s", String(e))
  );
  return json(202, { success: true, data: { commandId, status: "running", action: c.action } });
}
