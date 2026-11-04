// @kf-batch 54-genbi-session-cards
// 会话卡片四条路由共用的**异常 → HTTP 映射**(单一作者)。
//
// 🔴 为什么不放在 `route.ts` 里:① Next App Router 的 route 文件只许导出固定名(GET/POST/…),
//    多导出一个 helper 会被路由类型校验拒;② 分散写会让同一种失败在不同入口给出不同状态码 ——
//    而前端与验收脚本都是按 (status, code, detail.reason) 三元组分流的。
import { apiError } from "@/lib/api-response";
import { CardInputInvalid, CardQuotaExceeded, CardStoreUnavailable } from "@/lib/genbi/cards-service";
import { CardStoreContended } from "@/lib/genbi/cards-store";
import { CardBodyUnreadable } from "@/lib/genbi/cards-body-store";
import { targetNotReadyResponse } from "@/lib/exec-env/target-http";
import { AuditUnavailable, ResidencyAckRequired } from "@/lib/exec-env/residency";
// @kf-batch 50-WP28-platform-action-node(WP-29 问数)—— 刷新 / 定时刷新的两类失败
import { CardNotRefreshable, CardRefreshFailed } from "@/lib/genbi/cards-refresh";
import { ActionScheduleInvalid, ActionScheduleOfflineIncomplete } from "@/lib/scheduler/action-schedules";
import { actionScheduleError } from "@/lib/scheduler/action-schedules-http";

/** 异常 → HTTP。四条路由都只走这一个出口。 */
export function cardsError(e: unknown) {
  if (e instanceof CardQuotaExceeded) {
    return apiError(
      `已保存 ${e.used}/${e.limit} 张会话卡片,达到每人上限。平台**不会**自动删除你保存的卡片 —— 请先删掉不再需要的那几张。`,
      409,
      { code: "GENBI_CARD_QUOTA_EXCEEDED", detail: { used: e.used, limit: e.limit } }
    );
  }
  // 🔴 纯文字卡 / 没有 SQL 的轮次:用户可修(换一轮 / 换一张卡)⇒ 409,不是 500
  if (e instanceof CardNotRefreshable) return apiError(e.detail, 409, { code: "CONFLICT", detail: { reason: "card-not-refreshable" } });
  // 重跑 SQL 失败 = 数仓侧的真因(表没了 / 权限 / 超时)⇒ 502 + 原文
  if (e instanceof CardRefreshFailed) return apiError(e.detail, 502, { code: "UPSTREAM_ERROR", detail: { reason: "card-refresh-failed" } });
  if (e instanceof ActionScheduleInvalid || e instanceof ActionScheduleOfflineIncomplete) return actionScheduleError(e);
  if (e instanceof CardInputInvalid) return apiError(e.detail, 400, { code: "GENBI_CARD_TOO_LARGE" });
  if (e instanceof CardBodyUnreadable) return apiError(e.detail, 400, { code: "GENBI_CARD_TOO_LARGE" });
  if (e instanceof CardStoreUnavailable) return apiError(e.detail, 502, { code: "CARD_STORE_UNAVAILABLE" });
  // 🔴 争抢耗尽是**平台侧瞬态**,不是用户做错了什么 ⇒ 503(可重试)而不是 500(平台故障/未预期)。
  //    改动前它掉进最后那个 500 分支,文案「保存卡片失败,请稍后重试」= 把平台该做的重试推给用户。
  if (e instanceof CardStoreContended) {
    return apiError(e.message, 503, { code: "UPSTREAM_ERROR", detail: { reason: "store-contended", attempts: e.attempts } });
  }
  // 🔴 下面三类**复用平台既有口径**,不新造同义 code:`error.code` 用 union 里已有的,
  //    「具体是哪一种」放 `error.detail.reason`(字面量由 `lib/exec-env/residency.ts` 单作者导出,
  //    前端据此弹免责告知 / 提示)。另起一套 code 词表 = 前端与验收脚本要维护两份映射。
  // 🔴 委托给单一作者(`target-http.ts`)—— 这个 409 的形状只许有一处定义
  const notReady = targetNotReadyResponse(e);
  if (notReady) return notReady;
  if (e instanceof ResidencyAckRequired) {
    return apiError(e.message, 409, { code: "CONFLICT", detail: { reason: e.reason, targetId: e.targetId, disclaimer: e.disclaimer } });
  }
  if (e instanceof AuditUnavailable) {
    return apiError(
      `跨法域执行环境的区域审计当前写不成,保存已被拒绝 —— 卡片是你的资产,平台不做「假装存好了」。原因:${e.message}`,
      503,
      { code: "UPSTREAM_ERROR", detail: { reason: e.reason } }
    );
  }
  console.error("[api/genbi/cards] 未预期错误:%s", String(e));
  return apiError("保存卡片失败,请稍后重试", 500);
}
