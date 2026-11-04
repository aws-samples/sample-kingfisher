// 页面〔触发一次〕(ACCEPTANCE):对**已发布**的 target 立刻跑一次调度产物 —— 按台账 `deployments[targetId].scheduler` 分路
//   serverless ⇒ StartWorkflowRun(RunType ON_DEMAND);经典 mwaa ⇒ 该区 Airflow `dags trigger <dag_id>`。
// 🔴 触发 ≠ 发布:没发布过的 target 如实 skipped,不会顺手去建产物(那是〔发布到 MWAA 调度〕的地盘)。
// 🔴 ETL / EMR 两条作业线共用本文件(唯一作者);路由只做取数 → 调这里 → 记审计。
import { mwaaCli, mwaaEndpointFor, MwaaNotInstalled } from "@/lib/scheduler/mwaa-endpoint";
import { startWorkflowRun } from "@/lib/scheduler/serverless/workflow-client";
import { regionOfWorkflowArn } from "@/lib/scheduler/serverless/task-logs";
import { dagIdForTarget } from "@/lib/etl/dag-fanout";

export interface TriggerRow {
  targetId: string;
  dagId: string;
  scheduler: "mwaa" | "serverless";
  status: "ok" | "failed" | "skipped";
  /** serverless:服务侧 RunId;mwaa:无(Airflow CLI 不回 run_id) */
  runId?: string;
  error?: string;
}

type DeploymentLike = { scheduler?: string; workflowArn?: string } | undefined;

export async function triggerScheduledRuns(args: {
  baseDagId: string;
  deployments: Record<string, DeploymentLike> | null | undefined;
  /** 只触发这些 target(缺省 = 台账里全部) */
  targets?: string[];
}): Promise<TriggerRow[]> {
  const deployments = args.deployments ?? {};
  const list = args.targets && args.targets.length ? args.targets : Object.keys(deployments);
  const rows: TriggerRow[] = [];
  for (const targetId of list) {
    const dagId = dagIdForTarget(args.baseDagId, targetId);
    const rec = deployments[targetId];
    if (!rec) {
      rows.push({ targetId, dagId, scheduler: "mwaa", status: "skipped", error: "该 target 没有已发布的调度产物 —— 先发布再触发" });
      continue;
    }
    const scheduler: "mwaa" | "serverless" = rec.scheduler === "serverless" ? "serverless" : "mwaa";
    try {
      if (scheduler === "serverless") {
        if (!rec.workflowArn) throw new Error("台账缺 workflowArn(产物记录不完整,请重新发布)");
        const r = await startWorkflowRun(regionOfWorkflowArn(rec.workflowArn), rec.workflowArn);
        rows.push({ targetId, dagId, scheduler, status: "ok", runId: r.RunId ?? undefined });
      } else {
        const ep = await mwaaEndpointFor(targetId);
        const res = await mwaaCli(ep, `dags trigger ${dagId}`);
        if (!res.ok) throw new Error(res.stderr || res.stdout || "dags trigger 失败");
        rows.push({ targetId, dagId, scheduler, status: "ok" });
      }
    } catch (e) {
      if (e instanceof MwaaNotInstalled) throw e;
      rows.push({ targetId, dagId, scheduler, status: "failed", error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }
  return rows;
}
