// 删除执行环境的错误 → HTTP **唯一映射**(五个路由 + 审批路由共用;各写一份就会出现同一种拒绝两个状态码)。
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-response";
import { DecommissionRefused } from "@/lib/exec-env/decommission";
import { LifecycleConflictError, PhaseTransitionError } from "@/lib/exec-env/lifecycle";
import { sanitizeAwsErrorMessage } from "@/lib/exec-env/deploy-control";

export function decommissionErrorResponse(e: unknown, what: string): NextResponse {
  if (e instanceof DecommissionRefused) {
    return apiError(e.message, e.httpStatus, { code: e.code, ...(e.detail ? { detail: e.detail } : {}) });
  }
  // 状态机拒绝 / 并发条件写冲突 = 用户可修(刷新重试 / 先做前一步)⇒ 409,不是平台故障
  if (e instanceof PhaseTransitionError || e instanceof LifecycleConflictError) {
    return apiError(e.message, 409, { code: "CONFLICT" });
  }
  return apiError(`${what}失败:${sanitizeAwsErrorMessage(String((e as Error)?.message ?? e)).slice(0, 300)}`, 500, { code: "INTERNAL" });
}
