export const dynamic = "force-dynamic";

// 序 72 B-139(模块 56)—— 页面「执行角色」下拉的候选:GET /api/exec-roles/candidates?engine=glue|emr|flink&targetId=
//   登录即可读(与「角色顾问 → 推荐」同级);engine 不在闭合清单 / 缺 targetId ⇒ 400(落点显式,不默认主控区);
//   IAM 读失败 ⇒ 502 UPSTREAM_ERROR 如实报(平台缺 iam:ListRoles = 栈没升级到含本刀的版本,文案点名)。

import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { TargetBindingRejected } from "@/lib/exec-env/data-plane-target";
import { listExecutionRoleCandidates } from "@/lib/execution-role/candidates";
import { EXEC_ROLE_ENGINES, isExecRoleEngine } from "@/lib/execution-role/types";

export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效，请重新登录", 401, { code: "UNAUTHENTICATED" });
  const engine = req.nextUrl.searchParams.get("engine");
  if (!isExecRoleEngine(engine)) {
    return apiError(`缺少或未知 engine(可选 ${EXEC_ROLE_ENGINES.join(" / ")})`, 400, { code: "VALIDATION_FAILED" });
  }
  let targetId: string;
  try {
    targetId = requestedTargetId(req.nextUrl.searchParams.get("targetId"), "执行角色候选");
  } catch (e) {
    return placeErrorResponse(e) ?? apiError((e as Error)?.message ?? String(e), 400, { code: "VALIDATION_FAILED" });
  }
  try {
    return apiOk(await listExecutionRoleCandidates({ engine, targetId }));
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    if (e instanceof TargetBindingRejected) return apiError(e.message, 409, { code: "CONFLICT" });
    const name = (e as { name?: string })?.name || "";
    const denied = name === "AccessDenied" || name === "AccessDeniedException";
    return apiError(
      denied
        ? "平台没有读取账号 IAM 角色清单的权限(iam:ListRoles)—— 请升级平台到含「任务执行角色可选」的版本(redeploy-platform.sh);此前可切到「手动输入 ARN」填写"
        : `读取 IAM 角色清单失败:${(e as Error)?.message ?? String(e)}`,
      502,
      { code: "UPSTREAM_ERROR", detail: { name } }
    );
  }
}
