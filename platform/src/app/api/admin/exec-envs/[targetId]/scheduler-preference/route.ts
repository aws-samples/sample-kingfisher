export const dynamic = "force-dynamic";
// @kf-batch 50-WP15-airflow-serverless(施工序 6)
// POST /api/admin/exec-envs/[targetId]/scheduler-preference —— 两者都装时走哪个调度器(INTERACTION §2.2b;SPEC §3.15)。
// 只改「之后发布」的走向;已发布作业保持原调度器直到重新发布(重新发布会先下线旧产物,见 dag-fanout.offlinePreviousSchedulerIfSwitched)。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { setSchedulerPreference, PhaseTransitionError } from "@/lib/exec-env/lifecycle";
import { isSchedulerPreference, isWritableSchedulerPreference, retiredSchedulerPreferenceMessage, SCHEDULER_PREFERENCES } from "@/lib/exec-env/scheduler-preference";

const CLIENT_FIELDS = ["schedulerPreference", "expectedVersion"];

export async function POST(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  if (!isValidTargetId(params.targetId)) return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return apiError("请求体不是合法 JSON", 400, { code: "VALIDATION_FAILED" });
  }
  const extra = Object.keys(body ?? {}).filter((k) => !CLIENT_FIELDS.includes(k));
  if (extra.length > 0) return apiError(`入参含不允许的字段:${extra.join(", ")}(只接 ${CLIENT_FIELDS.join(", ")})`, 400, { code: "VALIDATION_FAILED" });
  const pref = body.schedulerPreference;
  const expectedVersion = body.expectedVersion;
  if (!isSchedulerPreference(pref)) return apiError(`schedulerPreference 只允许 ${SCHEDULER_PREFERENCES.join(" / ")}(收到 ${JSON.stringify(pref)})`, 400, { code: "VALIDATION_FAILED" });
  // @kf-batch 50-WP20b-retire-mwaa-preference
  // 🔴🔴 **已停供的取值写不进**(用户 2026-09-20:「后面所有的调度都走 mwaa serverless」)。
  //   真根是「经典 MWAA 下线只做了一半」——入口(注册/补装)都关了,而**偏好这条旁路**还开着:
  //   实测往只装 serverless 的 target 写 `mwaa` 回 **HTTP 200** 且描述符真写成 mwaa
  //   ⇒ 章从此宣称一个不存在的调度器(与同步任务「启用调度」空壳同族)。
  //   写通道 `setSchedulerPreference` 里也有同一道(防新调用方绕过);这里早拒一次,给的是可执行的人话。
  if (!isWritableSchedulerPreference(pref))
    return apiError(retiredSchedulerPreferenceMessage(String(pref)), 400, { code: "VALIDATION_FAILED" });   // 与「停供组件」那条路径同一个码(registry 拒 retired 组件也是 400)
  if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion)) return apiError("expectedVersion 须为整数(乐观锁)", 400, { code: "VALIDATION_FAILED" });
  try {
    const r = await setSchedulerPreference(params.targetId, pref, { expectedVersion });
    recordAudit(req, "exec-env.scheduler-preference", { resourceType: "exec-env", resourceId: params.targetId, detail: { schedulerPreference: pref, changed: r.changed } }).catch(() => {});
    return apiOk({ targetId: params.targetId, schedulerPreference: pref, changed: r.changed, hint: r.changed ? "已记录;只影响之后的发布 —— 已发布作业保持原调度器,重新发布时会先下线旧产物再切" : "已是该偏好,未改" });
  } catch (e: unknown) {
    if (e instanceof PhaseTransitionError) return apiError(e.message, 409, { code: "CONFLICT" });
    return apiError(`改调度器偏好失败:${String((e as Error)?.message ?? e)}`, 500, { code: "INTERNAL" });
  }
}
