export const dynamic = "force-dynamic";

// 页面「检查权限」按钮:POST /api/exec-roles/preflight
//   body { engine, targetId, roleArn, extraS3Uris?, scriptCode? } ⇒ PreflightResult(三态:齐 / 缺 N 条 / 量不了)。
//   只是预览;保存 / 启动路径服务端自己还会再量一遍(不信客户端)。登录即可用;只读动作(GetRole / SimulatePrincipalPolicy)。

import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { TargetBindingRejected } from "@/lib/exec-env/data-plane-target";
import { preflightExecutionRole } from "@/lib/execution-role/preflight";
import { roleArnShapeRejection } from "@/lib/execution-role/resolve";
import { EXEC_ROLE_ENGINES, isExecRoleEngine } from "@/lib/execution-role/types";

export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效，请重新登录", 401, { code: "UNAUTHENTICATED" });
  let body: { engine?: unknown; targetId?: unknown; roleArn?: unknown; extraS3Uris?: unknown; scriptCode?: unknown };
  try { body = await req.json(); } catch { return apiError("请求体无效", 400, { code: "VALIDATION_FAILED" }); }
  if (!isExecRoleEngine(body.engine)) {
    return apiError(`缺少或未知 engine(可选 ${EXEC_ROLE_ENGINES.join(" / ")})`, 400, { code: "VALIDATION_FAILED" });
  }
  const roleArn = typeof body.roleArn === "string" ? body.roleArn.trim() : "";
  if (!roleArn) return apiError("缺少 roleArn(平台默认角色不需要预检,留空即可)", 400, { code: "VALIDATION_FAILED" });
  const shapeReject = roleArnShapeRejection(roleArn);
  if (shapeReject) return apiError(shapeReject, 400, { code: "VALIDATION_FAILED" });
  let targetId: string;
  try {
    targetId = requestedTargetId(body.targetId, "执行角色预检");
  } catch (e) {
    return placeErrorResponse(e) ?? apiError((e as Error)?.message ?? String(e), 400, { code: "VALIDATION_FAILED" });
  }
  const extraS3Uris = Array.isArray(body.extraS3Uris) ? body.extraS3Uris.filter((x): x is string => typeof x === "string") : [];
  const scriptCode = typeof body.scriptCode === "string" ? body.scriptCode : undefined;
  try {
    return apiOk(await preflightExecutionRole({ engine: body.engine, roleArn, targetId, extraS3Uris, scriptCode }));
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    if (e instanceof TargetBindingRejected) return apiError(e.message, 409, { code: "CONFLICT" });
    return apiError(`执行角色预检失败:${(e as Error)?.message ?? String(e)}`, 502, { code: "UPSTREAM_ERROR" });
  }
}
