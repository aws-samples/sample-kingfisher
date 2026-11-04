// 模块 44 — Copilot 规划异步任务执行体。claim → 跑 planner(Strands,不受 60s 墙)→ createPlan 落库 → finalize。
// 照 GenBI 异步执行体:挂 AbortController 到天花板主动 abort;心跳保活;终态条件写(防僵尸/防回退)。
// 由提交路由 fire-and-forget 触发(不 await),也可由轮询端点在 pending 时补触发(自愈,防执行体没起来)。

import { claimForRun, heartbeat, finalize, PLAN_CEILING_MS, type PlanTaskRow } from "./plan-task-service";
import { runPlanner } from "./planner";
import { createPlan } from "./plan-service";
import type { CopilotCaller } from "../tools/types";
import { targetOfStamp } from "@/lib/exec-env/target-id";

// 执行一个规划任务(幂等:claim 失败=已被他人认领/非 pending → 直接返回)。
// token 不落库,由触发方(提交路由)内存传入;轮询补触发时无 token(见下方 note)。
export async function runPlanTask(task: PlanTaskRow, token: string): Promise<void> {
  const runToken = await claimForRun(task.taskId);
  if (!runToken) return; // 已被认领或非 pending → 幂等跳过

  // 心跳保活:定时刷新 heartbeatAt(证明执行体活着,轮询端点据此不误判 stale)。
  const hb = setInterval(() => { heartbeat(task.taskId, runToken).catch(() => {}); }, 8_000);
  // 天花板 abort:到点主动停止 planner 的 Bedrock 调用(planner 内部 deadline 更短,通常先返回)。
  const ceiling = setTimeout(() => {
    finalize(task.taskId, runToken, { status: "timeout", error: "规划超时(执行体天花板)" }).catch(() => {});
  }, PLAN_CEILING_MS);

  try {
    // @kf-batch 50-WP4quater-reads(工单 SC-17)—— 落点随任务行走(建出来的 draft 就落这个区)
    // 🔴 @kf-batch 50-B39-plan-target:落点经唯一作者解析(B-39 之前的存量行无章 = 主控区),计划记录与发现工具用同一个值
    const targetId = targetOfStamp(task.targetId);
    const caller: CopilotCaller = { token, projectId: task.projectId, env: task.env, targetId };
    // 异步执行:planner 软上限给 200s(<240s 任务天花板),不受 CloudFront 60s 墙约束——
    // 这才是异步化的意义:重推理 planner 能跑到自然结束,不被 60s 提前掐断(此前 degraded 根因)。
    const { spec, degraded, model } = await runPlanner({ prompt: task.prompt, caller, deadlineMs: 200_000 });
    // 落库计划(即便 degraded=steps 空,也落一条计划,前端能看到"未能规划"的诚实结论)。
    const plan = await createPlan({ projectId: task.projectId, createdBy: task.createdBy, prompt: task.prompt, spec, targetId });
    // @kf-batch 50-W5-seg2-WP8:任务项落实际用的模型(模块 51 `_meta` 的异步落点⑧)。
    await finalize(task.taskId, runToken, { status: "succeeded", planId: plan.planId, degraded: !!degraded, usedModelId: model?.modelId, usedModelSource: model?.modelSource });
  } catch (e: any) {
    await finalize(task.taskId, runToken, { status: "failed", error: String(e?.message || e).slice(0, 400) }).catch(() => {});
  } finally {
    clearInterval(hb);
    clearTimeout(ceiling);
  }
}
