// Copilot 执行引擎(泛化补数 runner.ts 的幂等推进内核)。
//
// tick(projectId, planId) 一次推进(可被前端刷新/定时多次触发而不重复提交):
//  1) reconcile:对 running 步骤读 bgp-task-runs 终态 → 回写 succeeded/failed(+超时兜底判 failed)
//  2) unblock:blocked 步骤若 dependsOn 全 succeeded → 转 awaiting-confirmation(【不是 pending】——
//     解锁后仍要等人工确认!这是与补数的关键差异);任一上游 failed/skipped → 转 skipped
//  3) claim+execute:【两道门控】
//       门控A(autoExecute):plan.autoExecute=false(本期 L2 默认)→ 整个 claim 段 no-op,引擎不代执行。
//       门控B(gated):只有 status=confirmed 的步骤才 claim→running(awaiting-confirmation 绝不自动推进)。
//     这两道门控就是"AI 永不擅自执行"落到状态机层的铁律。
//  4) 回写计划 progress + 派生终态
//
// 幂等三保证(同补数):① confirmed→running 条件写(只一个赢)② runToken(僵尸执行者无法覆盖)
// ③ running 超天花板且引擎查无 → reconcile 判 failed(绝不永久卡 running)。
//
// 本期(L2):autoExecute 恒 false → 引擎存在但不 claim 任何步骤(execute 段是死代码路径,留给 L3)。
// 执行落 run 一律打 triggeredBy="copilot"(在线隔离;消费端排除见 baseline/learn + finops/anomaly)。

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { getPlan, listSteps, refreshPlanProgress } from "./plan-service";
import { getStepHandler } from "./step-handlers/registry";
import { STEP_CEILING_MS } from "./types";
import type { CopilotCaller } from "../tools/types";
import type { CopilotPlanRow, CopilotStepRow, StepType } from "./types";

function isConditionalFail(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: string }).name === "ConditionalCheckFailedException";
}

const ceilingFor = (stepType: StepType): number => STEP_CEILING_MS[stepType] ?? 2 * 3600 * 1000;

// 领取 confirmed→running(条件写,赢返回 runToken;null=被他人领走/非 confirmed)。
// 【与补数差异】领取条件是 status=confirmed(而非 pending)——门控B:只有确认过的步骤能被执行。
async function claimStep(planId: string, stepId: string): Promise<string | null> {
  const runToken = ulid();
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.COPILOT_STEPS,
      Key: { planId, stepId },
      UpdateExpression: "SET #s = :running, runToken = :tok, startedAt = :now, attempts = attempts + :one",
      ConditionExpression: "#s = :confirmed",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":running": "running", ":confirmed": "confirmed", ":tok": runToken, ":now": new Date().toISOString(), ":one": 1 },
    }));
    return runToken;
  } catch (e) {
    if (isConditionalFail(e)) return null;
    throw e;
  }
}

// 回写步骤终态(仅当仍是当前 owner 的 running,防僵尸覆盖)。
async function finalizeStep(planId: string, stepId: string, runToken: string, status: "succeeded" | "failed", error?: string): Promise<void> {
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.COPILOT_STEPS,
      Key: { planId, stepId },
      UpdateExpression: error !== undefined
        ? "SET #s = :st, finishedAt = :now, lastError = :e"
        : "SET #s = :st, finishedAt = :now",
      ConditionExpression: "#s = :running AND runToken = :tok",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: error !== undefined
        ? { ":st": status, ":running": "running", ":tok": runToken, ":now": new Date().toISOString(), ":e": String(error).slice(0, 500) }
        : { ":st": status, ":running": "running", ":tok": runToken, ":now": new Date().toISOString() },
    }));
  } catch (e) {
    if (isConditionalFail(e)) return;
    throw e;
  }
}

// reconcile 单个 running 步骤:优先用 handler.reconcile,否则通用读 bgp-task-runs 终态(权威回收,无 owner 条件)。
async function reconcileRunning(step: CopilotStepRow): Promise<CopilotStepRow> {
  if (step.status !== "running") return step;
  let real: "succeeded" | "failed" | null = null;
  let error: string | undefined;

  const handler = getStepHandler(step.stepType);
  if (handler?.reconcile) {
    try { real = await handler.reconcile(step); } catch { /* 保留 */ }
  } else if (step.runTaskId && step.runId) {
    try {
      const { Item: run } = await docClient.send(new GetCommand({ TableName: TABLES.TASK_RUNS, Key: { taskId: step.runTaskId, runId: step.runId } }));
      const st = run?.status;
      if (st === "succeeded") real = "succeeded";
      else if (st === "failed" || st === "stopped") { real = "failed"; error = run?.error || "run failed"; }
    } catch { /* 查不到保留 */ }
  }
  // 超天花板兜底:running 太久且引擎仍未回写终态 → 判失败,不永久卡。
  if (!real) {
    const startedMs = Date.parse(step.startedAt || "");
    if (Number.isFinite(startedMs) && Date.now() - startedMs > ceilingFor(step.stepType)) {
      real = "failed"; error = "步骤超时(引擎未回写终态)";
    }
  }
  if (real) {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.COPILOT_STEPS,
      Key: { planId: step.planId, stepId: step.stepId },
      UpdateExpression: real === "failed"
        ? "SET #s = :st, finishedAt = :now, lastError = :e"
        : "SET #s = :st, finishedAt = :now",
      ConditionExpression: "#s = :running",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: real === "failed"
        ? { ":st": real, ":running": "running", ":now": new Date().toISOString(), ":e": String(error || "").slice(0, 500) }
        : { ":st": real, ":running": "running", ":now": new Date().toISOString() },
    })).catch(() => {});
    return { ...step, status: real, lastError: error };
  }
  return step;
}

// 解锁 blocked:全上游 succeeded → awaiting-confirmation(【仍需人工确认,不直接 pending】);
// 任一上游 failed/skipped → skipped(级联跳过)。
async function resolveBlocked(step: CopilotStepRow, byId: Map<string, CopilotStepRow>): Promise<CopilotStepRow> {
  if (step.status !== "blocked") return step;
  const deps = step.dependsOn.map((id) => byId.get(id)).filter(Boolean) as CopilotStepRow[];
  const anyBad = deps.some((d) => d.status === "failed" || d.status === "skipped");
  const allOk = deps.length === step.dependsOn.length && deps.every((d) => d.status === "succeeded");
  const next: "awaiting-confirmation" | "skipped" | null = anyBad ? "skipped" : allOk ? "awaiting-confirmation" : null;
  if (next) {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.COPILOT_STEPS,
      Key: { planId: step.planId, stepId: step.stepId },
      UpdateExpression: "SET #s = :n",
      ConditionExpression: "#s = :blocked",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":n": next, ":blocked": "blocked" },
    })).catch(() => {});
    return { ...step, status: next };
  }
  return step;
}

export interface PlanTickResult {
  planStatus: string;
  progress: CopilotPlanRow["progress"];
  submitted: number;
  running: number;
  autoExecute: boolean;
}

// tick 一次推进。caller 仅在 L3 execute 时用(本期 autoExecute=false,不会走到 execute)。
export async function tick(projectId: string, planId: string, caller?: CopilotCaller): Promise<PlanTickResult> {
  const plan = await getPlan(projectId, planId);
  if (!plan) throw new Error("执行计划不存在");

  let steps = await listSteps(planId);

  // 1) reconcile running。
  steps = await Promise.all(steps.map((s) => reconcileRunning(s)));

  // 2) 解锁 blocked(一轮传播,下游靠下次 tick 继续)。解锁后落到 awaiting-confirmation(等确认)。
  const byId = new Map(steps.map((s) => [s.stepId, s]));
  steps = await Promise.all(steps.map((s) => resolveBlocked(s, byId)));

  let submitted = 0;
  const runningNow = steps.filter((s) => s.status === "running").length;

  // 3) claim+execute —— 【两道门控】
  //   门控A:仅 autoExecute=true(L3)且计划未暂停/取消时才代执行。本期 L2 恒 false → 整段跳过。
  //   门控B:只领取 status=confirmed 的步骤(awaiting-confirmation 绝不自动推进)。
  const canDispatch = plan.autoExecute === true && plan.status !== "paused" && plan.status !== "cancelled";
  if (canDispatch && caller) {
    // 顺序执行,一次一个(Copilot 计划步骤通常少且有依赖;不设并发,稳妥)。
    const candidates = steps.filter((s) => s.status === "confirmed").sort((a, b) => a.seq - b.seq);
    for (const step of candidates) {
      const handler = getStepHandler(step.stepType);
      if (!handler?.execute) continue; // 无 execute(如 query-only)→ 不代执行
      const runToken = await claimStep(planId, step.stepId);
      if (!runToken) continue; // 被他人领走 → 跳过(幂等)
      try {
        const res = await handler.execute({ ...step, status: "running", runToken }, caller);
        if ("done" in res && res.done) {
          await finalizeStep(planId, step.stepId, runToken, "succeeded");
        } else if ("runTaskId" in res) {
          await docClient.send(new UpdateCommand({
            TableName: TABLES.COPILOT_STEPS,
            Key: { planId, stepId: step.stepId },
            UpdateExpression: "SET runTaskId = :rt, runId = :rid",
            ConditionExpression: "#s = :running AND runToken = :tok",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":rt": res.runTaskId, ":rid": res.runId, ":running": "running", ":tok": runToken },
          })).catch(() => {});
        }
        submitted += 1;
      } catch (e: any) {
        await finalizeStep(planId, step.stepId, runToken, "failed", e?.message || "步骤执行提交失败").catch(() => {});
      }
    }
  }

  // 4) 回写 progress + 派生终态。
  const fresh = await listSteps(planId);
  const updated = await refreshPlanProgress(plan, fresh);
  return {
    planStatus: updated.status,
    progress: updated.progress,
    submitted,
    running: fresh.filter((s) => s.status === "running").length,
    autoExecute: plan.autoExecute,
  };
}
