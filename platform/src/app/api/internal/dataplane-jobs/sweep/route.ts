export const dynamic = "force-dynamic";
// @kf-batch 50-WP9a-durable-jobs
// POST /api/internal/dataplane-jobs/sweep —— 「绑定即自动供给」的补队(WORK-PACKAGES WP-9 ⑨-6;systemActor)。
//
// 唯一调用方:本进程的推进泵(每 10 分钟一次,只在持 leader 租约的副本上)。
// 做的事:对凭证状态在 provisioning / isolated 的每个执行环境,按**唯一口径** `listProjectsWithBindings`
// 列在用项目,缺供给作业的就入队(确定性 jobId ⇒ 重复补队不会多一条;失败过的不自动重开,要人看见)。
// 🔴 鉴权与 step 端点同一道(来源 `dataplane-job-pump` + 共享密钥);补队本身写一条审计(谁在什么时候补了几条)。
import { NextRequest, NextResponse } from "next/server";
import { writeAuditRecord } from "@/lib/audit";
import { verifyInternalCaller, DATAPLANE_JOB_PUMP_PRINCIPAL, INTERNAL_SOURCE_DATAPLANE_JOB_PUMP } from "@/lib/scheduler/internal-guard";
import { sweepAutoSupply } from "@/lib/exec-env/project-cred-supply";
// 序 61 B-133 —— 同一 tick 顺带巡检数据源外部网络对象(平台自建组 / 连接被平台外删除 ⇒ 在没人用之前自愈;覆盖不经 TS 启动核心的调度运行时路径)
import { sweepDatasourceNetwork, type NetworkSweepSummary } from "@/lib/datasource/network-sweep";
import { SWEEP_ENDPOINT_PATH, dataplaneJobsPaused } from "@/lib/dataplane-jobs/schema";

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status });
}

export async function POST(req: NextRequest) {
  const verdict = await verifyInternalCaller(req.headers, { expectedSource: INTERNAL_SOURCE_DATAPLANE_JOB_PUMP });
  const audit = (action: string, detail: Record<string, unknown>) =>
    writeAuditRecord(
      { actor: DATAPLANE_JOB_PUMP_PRINCIPAL.actor },
      action,
      { resourceType: "dataplane-job", resourceId: "sweep", detail: { ...detail, via: DATAPLANE_JOB_PUMP_PRINCIPAL.via } },
      { method: "POST", path: SWEEP_ENDPOINT_PATH }
    ).catch((e) => console.error("[internal/dataplane-jobs/sweep] 审计写失败:%s", String(e)));
  if (!verdict.ok) {
    await audit("internal.dataplane-job.denied", { status: verdict.status, reason: verdict.reason });
    return json(verdict.status, { success: false, error: { message: verdict.reason } });
  }
  if (dataplaneJobsPaused()) {
    return json(503, { success: false, error: { message: "数据面作业已停泵(BGP_DATAPLANE_JOBS_PAUSED=1)" } });
  }
  try {
    const s = await sweepAutoSupply();
    if (s.enqueued > 0 || s.errors.length > 0) {
      await audit("dataplane-job.auto-supply.sweep", { targets: s.targets, enqueued: s.enqueued, existing: s.existing, errors: s.errors.slice(0, 20) });
    }
    // 序 61 B-133:数据源网络对象巡检(自愈的写审计 / 告警由核对作者自己做;这里只在有自愈或读写错误时记一条汇总,broken 首次已由核对作者记过)
    const net: NetworkSweepSummary = await sweepDatasourceNetwork().catch((e) => ({
      scanned: 0, intact: 0, healed: [], broken: [], unverifiable: 0,
      errors: [{ datasourceId: "*", error: String((e as Error)?.message ?? e).slice(0, 300) }],
    }));
    if (net.healed.length > 0 || net.errors.length > 0) {
      await audit("datasource.network.sweep", { scanned: net.scanned, healed: net.healed, broken: net.broken.length, unverifiable: net.unverifiable, errors: net.errors.slice(0, 20) });
    }
    return json(200, { success: true, data: { ...s, datasourceNetwork: net } });
  } catch (e) {
    return json(500, { success: false, error: { message: String((e as Error)?.message ?? e).slice(0, 500) } });
  }
}
