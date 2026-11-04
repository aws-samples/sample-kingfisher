export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { getActiveProjectId, getActiveEnv } from "@/lib/projects/guard";
import { resolveRole } from "@/lib/projects/project-service";
import { roleAtLeast } from "@/lib/projects/constants";
// 序 46 B-107 — 通用 AI 长调用:问答主体在 lib/ai/long-op-executors.ts(copilot-ask);45s 未出结果 ⇒ 202 + 轮询。
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";
import { getCorrelationId } from "@/lib/observability/logger";

// POST /api/copilot/ask
// Body: { prompt, conversationId? }
// 后端由 COPILOT_BACKEND 选择:agentcore(Runtime)| 默认 inprocess(进程内,零基建可用)。
// 铁律(AgentCore 标准契约 7):agentcore 启用后 try Runtime → catch 回退 inprocess;usedBackend 如实反映。
// 安全(模块44):P44.1 仅只读工具;Copilot 永不执行/运行/发布/删除(能力面 + 提示词 + 后续守卫三闸)。
// 响应:同步 200 `{ answer, steps, usage, backend }` + `_meta`(51 SPEC §3.3a 落点②);推理模型慢时 202 `{ taskId, async:true }`,
//   客户端传输层(全局 fetch 拦截器)轮询 GET /api/long-ops/[taskId] 拿同形结果(B-107)。
export async function POST(req: NextRequest) {
  let body: { prompt?: string; conversationId?: string };
  try { body = await req.json(); } catch { return apiError("请求体无效"); }

  const prompt = (body.prompt || "").trim();
  if (!prompt) return apiError("问题不能为空");

  // 鉴权:必须是已登录身份(不提权)。Copilot 只看调用者本人可见的资源。
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效,请重新登录", 401);

  const projectId = getActiveProjectId(req);
  const env = getActiveEnv(req);
  const conversationId = (body.conversationId || "").trim();

  // 闸3:调用者在当前项目的角色 ≥ editor 才装入创建工具(否则只读)。resolveRole 兜底 null=无权。
  const role = await resolveRole(identity, projectId).catch(() => null);
  const canCreate = roleAtLeast(role, "editor");

  try {
    // 🔴 用户 token 不落库:执行体从承载请求的 Authorization 取(同步 = 本次 POST;被接管 = 那次 GET 轮询)。
    const result = await submitLongOp(
      { kind: "copilot-ask", params: { prompt, conversationId, projectId, env, canCreate }, correlationId: getCorrelationId(req) },
      { req, identity },
    );
    return longOpResponse(req, result);
  } catch (err: unknown) {
    { const lo = longOpErrorResponse(err); if (lo) return lo; }
    const msg = err instanceof Error ? err.message : String(err);
    return apiError(`Copilot 处理失败: ${msg}`, 500);
  }
}
