// @kf-batch 54-genbi-session-cards
// 「执行目标现在不能承接」→ HTTP 的**唯一作者**。
//
// 🔴 为什么必须单一作者(2026-09-13 全量门实测):建模落地路由
// `/api/modeling/codetables/[id]/land` 对同一件事回的是 **500**
// (「执行目标不可用:tgt_usw2_a —— 描述符校验不通过:core 资源缺失…」),
// 而平台别处回 **409 + `reason: "target-not-ready"`**(卡片路由 / 运行路由 / add-components)。
// 500 = 平台故障 ⇒ 把人引去查平台;而这件事是**用户可修**的(选错 target / 那个区没装好)。
// 同一种失败在不同入口给出不同状态码,前端与验收脚本就得维护两份映射 —— 那是分叉的开始。
// ⇒ 映射只写在这里;新入口一律调它,不许再拷一份。
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-response";
import { TargetNotReadyError } from "@/lib/exec-env/registry";

/**
 * 是 `TargetNotReadyError` 就回 409 响应;不是则回 `null`(调用方继续走自己的分支)。
 * 形状与卡片路由逐字一致:`code: "CONFLICT"` + `detail.reason = "target-not-ready"`。
 */
export function targetNotReadyResponse(e: unknown): NextResponse | null {
  if (!(e instanceof TargetNotReadyError)) return null;
  return apiError(`执行环境 ${e.targetId} 现在不能承接:${e.why}`, 409, {
    code: "CONFLICT",
    detail: { reason: "target-not-ready", targetId: e.targetId, why: e.why },
  });
}
