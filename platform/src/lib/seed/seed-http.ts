// @kf-batch 50-CAPSEED-seed-dispatch
// 造数的 **异常 → HTTP** 单一作者(手动入口与定时任务路由共用;route.ts 只许导出固定名,所以放这里)。
import { apiError } from "@/lib/api-response";
import { placeErrorResponse } from "@/lib/place/route";
import { targetNotReadyResponse } from "@/lib/exec-env/target-http";
import { TargetBindingRejected } from "@/lib/exec-env/data-plane-target";
import { actionScheduleError } from "@/lib/scheduler/action-schedules-http";
import { SeedAlreadyRunning, SeedInvalid, SeedJobMissing, SeedRunFailed } from "@/lib/seed/run-once";

export function seedError(e: unknown) {
  if (e instanceof SeedInvalid) return apiError(e.message, 400, { code: "VALIDATION_FAILED" });
  if (e instanceof SeedJobMissing) {
    return apiError(e.message, 409, {
      code: "CONFLICT",
      detail: { reason: "seed-job-missing", targetId: e.targetId, region: e.region, jobName: e.jobName },
    });
  }
  if (e instanceof SeedAlreadyRunning) {
    return apiError(e.message, 409, { code: "CONFLICT", detail: { reason: "seed-running", targetId: e.targetId, jobName: e.jobName } });
  }
  if (e instanceof SeedRunFailed) return apiError(e.message, 502, { code: "INTERNAL" });
  const pr = placeErrorResponse(e);
  if (pr) return pr;
  const nr = targetNotReadyResponse(e);
  if (nr) return nr;
  // 落点 / 资源袋类拒绝是**可修的冲突**(与同步启动同一口径)
  if (e instanceof TargetBindingRejected) return apiError(e.message, 409, { code: "CONFLICT" });
  return actionScheduleError(e);
}
