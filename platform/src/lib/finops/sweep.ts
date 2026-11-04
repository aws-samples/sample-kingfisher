// L3 归因扫描器(拉模式,隔离架构核心)。
// 【零 hook】:不改任何现有状态机——按水位增量【只读】扫共享台账 bgp-task-runs,
// 对每个已终态、可归因的 run 调引擎 API 取计量 → 价目折算 → 条件写 bgp-cost-runs(幂等)。
// 现有表只 Scan/Get,绝不写回;重复扫描/并发触发都安全(attribute_not_exists 去重)。

import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { GetJobRunCommand } from "@aws-sdk/client-glue";
import { GetJobRunCommand as EmrGetJobRunCommand } from "@aws-sdk/client-emr-serverless";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { WATERMARK_SK, SWEEP_PAGE_LIMIT } from "./constants";
import { costOfUsage, roundUsd, PRICE_VERSION } from "./pricing";
import { getWatermark, setWatermark, putCostRunIfNew } from "./store";
import type { CostEngine, EngineUsage } from "./types";
// 🔴 **模块级 home 客户端已删**(硬门 W3f-8 真环境抓到):原来 `new GlueClient({ region: AWS_REGION })` 拿 home 的客户端
// 去 GetJobRun 一条跑在 us-west-2 的 Glue run ⇒ EntityNotFound ⇒ 被下面的 catch 吞成 null ⇒ 「skipped」。
// 症状:**别的区的成本永远归不上、而扫描器报得一切正常**(W3-g 删掉 job-service / 日志 / EMR 的模块级客户端时漏了这一处)。
// 现在按 run 的章(targetId)解析 region、从工厂拿该 region 的客户端 —— 与 provider / 日志路径同一手法。
import { glueClientFor, emrServerlessClientFor } from "@/lib/exec-env/target-clients";
import { regionOfTarget } from "@/lib/exec-env/target-region";

// 共享台账里一条 run 的形状(只取归因需要的字段;字段名以各写入点实测为准)。
interface TaskRunItem {
  taskId: string;
  runId: string;
  taskType?: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string;
  triggeredBy?: string;
  channel?: string; // sync: glue/dms/zeroetl
  glueJobName?: string; // sync-glue & etl-glue
  glueJobRunId?: string;
  applicationId?: string; // emr-serverless
  nativeRunId?: string;
  // run 行的归属章(W2-a 起唯一写通道保证每条新 run 都有)
  projectId?: string;
  targetId?: string;
}

const TERMINAL = new Set(["succeeded", "failed", "stopped"]);

/** 计量结果三分:有计量 / 本就不计量(dms、workflow…)/ **取计量出错**(与「不计量」分开数,否则错永远藏在 skipped 里)。 */
type UsageProbe =
  | { kind: "metered"; engine: CostEngine; usage: EngineUsage }
  | { kind: "unmetered" }
  | { kind: "error"; reason: string };

/** 这条 run 是不是计量型引擎(Glue / EMR Serverless)——只有它们才需要去引擎侧取计量。 */
function isMeterable(run: TaskRunItem): boolean {
  return Boolean((run.glueJobName && run.glueJobRunId) || (run.taskType === "emr-serverless" && run.applicationId && run.nativeRunId));
}

// run → 引擎计量。🔴 客户端按 **run 的 target 所在 region** 取(见文件头);不可归因返回 unmetered,取不到返回 error。
async function fetchUsage(run: TaskRunItem & { targetId: string }): Promise<UsageProbe> {
  if (!isMeterable(run)) return { kind: "unmetered" }; // dms/zeroetl/workflow/flink:一期不归因(常驻或无 per-run 计量)
  try {
    const region = await regionOfTarget(run.targetId);
    if (run.glueJobName && run.glueJobRunId) {
      const glue = await glueClientFor(region);
      const { JobRun } = await glue.send(
        new GetJobRunCommand({ JobName: run.glueJobName, RunId: run.glueJobRunId })
      );
      const dpuSeconds =
        JobRun?.DPUSeconds ??
        // DPUSeconds 只在 auto-scaling 作业返回;固定容量作业用 ExecutionTime×MaxCapacity 推算
        (JobRun?.ExecutionTime && JobRun?.MaxCapacity ? JobRun.ExecutionTime * JobRun.MaxCapacity : undefined);
      if (dpuSeconds === undefined) return { kind: "unmetered" };
      return { kind: "metered", engine: "glue", usage: { dpuSeconds } };
    }
    const emr = await emrServerlessClientFor(region);
    const { jobRun } = await emr.send(
      new EmrGetJobRunCommand({ applicationId: String(run.applicationId), jobRunId: String(run.nativeRunId) })
    );
    const b = jobRun?.billedResourceUtilization;
    if (!b) return { kind: "unmetered" };
    return {
      kind: "metered",
      engine: "emr-serverless",
      usage: { vcpuHours: b.vCPUHour ?? 0, memoryGbHours: b.memoryGBHour ?? 0, storageGbHours: b.storageGBHour ?? 0 },
    };
  } catch (e: unknown) {
    // 引擎侧 run 已过保留期 / target 不存在 / 权限……:不阻塞整批,但**单独计数**——
    // 原来这里返回 null 混进 skipped,正是 W3f-8 那个「别的区成本归不上却一切正常」的藏身处。
    return { kind: "error", reason: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

export interface SweepResult {
  scanned: number;
  attributed: number;
  /** 本就不计量的 run(dms / workflow / flink …),以及已记过的 run。 */
  skipped: number;
  /** 🔴 有计量却**无章**(缺 projectId/targetId)而被拒绝归因的 run 数 —— 现网应恒为 0,>0 即有写入点绕过了写通道。 */
  unstamped: number;
  /** 🔴 计量型 run 取计量**出错**的条数(与 skipped 分开;>0 要查:多半是 region / 权限 / 引擎侧已过保留期)。 */
  errors: number;
  watermark: string;
}

// 水位增量扫描。backfill=true 时从 30 天前重扫(幂等,已记 run 条件写跳过)。
export async function sweepTaskCosts(opts?: { backfill?: boolean }): Promise<SweepResult> {
  const prev = opts?.backfill ? null : await getWatermark(WATERMARK_SK.RUN_SWEEP);
  const since = prev ?? new Date(Date.now() - 30 * 86400_000).toISOString();

  // bgp-task-runs 无 GSI,低量表(TTL 无,但 run 数百量级)→ 过滤 Scan 可接受;
  // SWEEP_PAGE_LIMIT 界定单次工作量,水位推进保证多次触发追平。
  const runs: TaskRunItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const { Items = [], LastEvaluatedKey } = await docClient.send(
      new ScanCommand({
        TableName: TABLES.TASK_RUNS,
        FilterExpression: "finishedAt > :since",
        ExpressionAttributeValues: { ":since": since },
        ExclusiveStartKey: lastKey,
      })
    );
    runs.push(...(Items as TaskRunItem[]));
    lastKey = LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey && runs.length < SWEEP_PAGE_LIMIT * 5);

  let attributed = 0;
  let skipped = 0;
  let unstamped = 0;
  let errors = 0;
  let maxFinished = since;

  for (const run of runs.slice(0, SWEEP_PAGE_LIMIT)) {
    if (!run.finishedAt || !TERMINAL.has((run.status || "").toLowerCase())) continue;
    if (run.finishedAt > maxFinished) maxFinished = run.finishedAt;

    if (!isMeterable(run)) {
      skipped++;
      continue;
    }
    // 🔴 成本行继承 run 的归属章(T1)。run 无章 ⇒ **不归因、不回落 home**,单独计数暴露出来:
    //    W2-a 之后写通道保证每条新 run 都有章(现网 310 条无一漏)。这里若还见到无章 run,
    //    说明有写入点绕过了通道 —— 那是要修的 bug,不是要兜的底;猜 home 会把它藏起来。
    //    章的 targetId 也是取计量的 region 来源 ⇒ 无章的 run 连引擎侧都不该去问。
    if (!run.projectId || !run.targetId) {
      unstamped++;
      continue;
    }
    const probe = await fetchUsage(run as TaskRunItem & { targetId: string });
    if (probe.kind === "error") {
      errors++;
      continue;
    }
    if (probe.kind === "unmetered") {
      skipped++;
      continue;
    }
    const metered = probe;
    const costUsd = roundUsd(costOfUsage(metered.engine, metered.usage));
    const wrote = await putCostRunIfNew({
      sk: run.runId,
      taskId: run.taskId,
      runId: run.runId,
      taskType: run.taskType || "unknown",
      engine: metered.engine,
      usage: metered.usage,
      costUsd,
      priceVersion: PRICE_VERSION,
      startedAt: run.startedAt || "",
      finishedAt: run.finishedAt,
      runStatus: run.status || "unknown",
      projectId: run.projectId,
      targetId: run.targetId,
      ...(run.triggeredBy ? { triggeredBy: run.triggeredBy } : {}),
    });
    if (wrote) attributed++;
    else skipped++;
  }

  // 水位推进到本批最大 finishedAt(而非 now:防止扫描窗口内仍在跑的 run 被永久跳过)。
  // 只前进不倒退(backfill 重扫旧数据时不得回拨水位)。
  const current = await getWatermark(WATERMARK_SK.RUN_SWEEP);
  if (!current || maxFinished > current) {
    await setWatermark(WATERMARK_SK.RUN_SWEEP, maxFinished);
  }
  return { scanned: runs.length, attributed, skipped, unstamped, errors, watermark: maxFinished };
}
