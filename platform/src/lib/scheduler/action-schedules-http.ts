// 平台动作调度对象(治理定时任务 / 卡片定时刷新)的 **异常 → HTTP** 单一作者 + 呈现辅助。
// 🔴 不放在 route.ts 里:App Router 的 route 文件只许导出固定名;多处各写一份会让同一种失败在不同入口给出不同状态码。
import { apiError } from "@/lib/api-response";
import { schedulerRejectResponse } from "@/lib/scheduler/fanout-reject";
import { targetNotReadyResponse } from "@/lib/exec-env/target-http";
import { placeErrorResponse } from "@/lib/place/route";
import {
  ActionScheduleInvalid,
  ActionScheduleOfflineIncomplete,
  actionCarrierDrift,
  type ActionScheduleRow,
} from "@/lib/scheduler/action-schedules";

export function actionScheduleError(e: unknown) {
  if (e instanceof ActionScheduleInvalid) return apiError(e.detail, 400, { code: "VALIDATION_FAILED" });
  if (e instanceof ActionScheduleOfflineIncomplete) {
    return apiError(e.message, 502, { code: "CONFLICT", detail: { failures: e.failures } });
  }
  const pr = placeErrorResponse(e);
  if (pr) return pr;
  const nr = targetNotReadyResponse(e);
  if (nr) return nr;
  // 发布 / 下线的调度类拒因(该区没装调度组件 ⇒ 409 + 补装直达)走调度类单一作者
  const sr = schedulerRejectResponse(e);
  if (sr) return sr;
  if ((e as { name?: string })?.name === "ConditionalCheckFailedException") {
    return apiError("调度对象已被并发修改或已删除,请刷新后重试", 409, { code: "CONFLICT" });
  }
  return apiError(`定时任务操作失败:${String((e as Error)?.message ?? e)}`, 500, { code: "INTERNAL" });
}

/**
 * 给一批调度对象附上「载体定义是不是最新的」(`?withDrift=1` 才查;查不动如实 `unknown`,绝不省略)。
 * 🔴 走单一作者 `actionCarrierDrift`(带 ledger,否则每个载体都误报落后)。
 */
export async function attachActionCarrierDrift(rows: ActionScheduleRow[]): Promise<void> {
  await Promise.all(
    rows.map(async (r) => {
      const targets = Object.keys(r.deployments || {});
      if (!targets.length) return;
      const out: Record<string, { state: string; reason?: string }> = {};
      await Promise.all(
        targets.map(async (t) => {
          try {
            const d = await actionCarrierDrift(r, t);
            out[t] = { state: d.state, ...(d.reason ? { reason: d.reason } : {}) };
          } catch (e) {
            out[t] = { state: "unknown", reason: String((e as Error)?.message ?? e).slice(0, 200) };
          }
        })
      );
      (r as unknown as Record<string, unknown>).carrierDrift = out;
    })
  );
}
