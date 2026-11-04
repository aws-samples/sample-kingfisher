export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { readScope, filterRowsByScope } from "@/lib/exec-env/scope";
import { isValidTargetId, HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { getActiveProjectId, getActiveEnv } from "@/lib/projects/guard";
import { resolveRole } from "@/lib/projects/project-service";
import { roleAtLeast } from "@/lib/projects/constants";
import { recordAudit } from "@/lib/audit";
import { listPlans } from "@/lib/copilot/plan/plan-service";
import { createPlanTask, getPlanTask } from "@/lib/copilot/plan/plan-task-service";
import { runPlanTask } from "@/lib/copilot/plan/plan-task-runner";

// POST /api/copilot/plan  { prompt }
// 【异步提交】规划大脑(Strands+Opus 发现+结构化输出)重推理耗时可能 >CloudFront 60s 同步硬墙
// ([[genbi-async-b1plus]] 同款坑)→ 立即建 pending 任务返 taskId,后台 fire-and-forget 跑 planner,
// 前端轮询 GET /api/copilot/plan/task/[taskId] 取计划。铁律:只产计划、不执行、不建 draft(建 draft 延迟到 confirm)。
// 鉴权:登录身份 + 当前项目 editor;不提权。落 copilot.plan.submit 审计。
export async function POST(req: NextRequest) {
  let body: { prompt?: string };
  try { body = await req.json(); } catch { return apiError("请求体无效"); }
  const prompt = (body.prompt || "").trim();
  if (!prompt) return apiError("诉求不能为空");

  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效,请重新登录", 401);

  const projectId = getActiveProjectId(req);
  const env = getActiveEnv(req);

  // editor 才能产计划(计划会落库,属编辑动作)。viewer 走通用问答 Copilot(/ask)即可。
  const role = await resolveRole(identity, projectId).catch(() => null);
  if (!roleAtLeast(role, "editor")) {
    return apiError("产出执行计划需要项目编辑(editor)权限", 403, { code: "RBAC_DENIED" });
  }

  const authz = req.headers.get("authorization") || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";

  try {
    // 🔴 落点从 **body** 来(写/执行路由不读 `?scope=`,SPEC §2.6.3)。
    // 🔴 **这里是计划落点唯一的决定处**。
    //   · 带了 targetId ⇒ 必须合法,否则 400(原来非法值静默改成主控区 = fail-open);
    //   · 没带 = 页面在「全部区域」视角(计划页只在选了区时才带)⇒ **显式**定为主控区,并原样落库、写审计。
    const rawTarget = (body as { targetId?: unknown })?.targetId;
    if (rawTarget !== undefined && !(typeof rawTarget === "string" && isValidTargetId(rawTarget))) {
      return apiError("targetId 不合法 —— 不会改用主控区", 400, { code: "VALIDATION_FAILED" });
    }
    const planTarget: string = typeof rawTarget === "string" ? rawTarget : HOME_TARGET_ID;
    const taskId = await createPlanTask({ prompt, projectId, env, token, createdBy: identity.username, targetId: planTarget });
    // fire-and-forget 后台执行(不 await;planner 不受本请求 60s 约束)。轮询端点也会补触发自愈。
    const task = await getPlanTask(taskId);
    if (task) runPlanTask(task, token).catch(() => {});

    recordAudit(req, "copilot.plan.submit", {
      resourceType: "copilot-plan-task", resourceId: taskId,
      detail: { prompt: prompt.slice(0, 200), targetId: planTarget },
      targetId: planTarget,
    }).catch(() => {});

    // 立即返回 taskId(前端轮询)。status=pending。
    return apiOk({ taskId, status: "pending" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return apiError(`规划提交失败: ${msg}`, 500);
  }
}

// GET /api/copilot/plan  → 列当前项目的执行计划(最新在前)。viewer 可读。
export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效,请重新登录", 401);
  const projectId = getActiveProjectId(req);
  try {
    // 按执行范围过滤:「这个区有哪些计划要落地」。
    // 🔴 无章的存量计划回落主控区(落章之前 Copilot 建的 draft 确实都在主控区跑)。
    const plans = await listPlans(projectId);
    const scope = readScope(req);
    return apiOk(scope ? (filterRowsByScope(plans as unknown as Array<Record<string, unknown>>, scope) as unknown as typeof plans) : plans);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return apiError(`获取计划列表失败: ${msg}`, 500);
  }
}
