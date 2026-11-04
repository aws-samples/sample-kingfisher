// 「取消**一条** run,在它自己那个执行目标上」—— 单一作者(50 SPEC v3.44 §2.7 cancel 行)。
//
// 🔴 为什么必须单一作者:平台此前只有三个**各自独立**的停止入口(引擎 SPI `stop` / 同步任务的
//    `BatchStopJobRun` / 即席查询的 `CancelStatement`),没有任何一处能「拿着一条 run 行去停它」。
//    组取消要停 N 条**分属不同引擎、不同 target** 的 run ⇒ 在路由里写一个 switch 就等于第四份副本。
// 🔴 客户端一律按**这条 run 自己的 targetId** 建(`redshiftClientForTarget` / `glueClientForTarget`)。
//    拿 home 的客户端去停非 home 的 run 不会报错,只会**什么都没停掉**却回成功
//    —— 与「拿 home 客户端查非 home 的 JobRun 必然查不到」同一个坑(data-plane-target.ts 已记)。
import { CancelStatementCommand } from "@aws-sdk/client-redshift-data";
import { BatchStopJobRunCommand } from "@aws-sdk/client-glue";
import { redshiftClientForTarget, glueClientForTarget } from "@/lib/exec-env/data-plane-target";
import { getProvider } from "@/lib/engines/registry";
import { updateRunRecord } from "@/lib/monitor/run-records";

export interface CancellableRun {
  taskId: string;
  runId: string;
  taskType: string;
  targetId: string;
  status: string;
  statementId?: string;
  glueJobName?: string;
  glueJobRunId?: string;
  nativeRunId?: string;
}

export interface CancelOutcome {
  targetId: string;
  runId: string;
  cancelled: boolean;
  /** 没取消的**人话**原因(已终态 / 缺原生标识 / 平台不认识这种 run / 后端报错)。 */
  reason?: string;
}

/** 只有这个状态才可能被取消;其余一律**不连坐**(把 succeeded 改成 stopped 是伪造历史)。 */
const CANCELLABLE_STATUS = "running";

/**
 * 取消一条 run。
 *
 * · 已终态 ⇒ `{cancelled:false, reason:"已终态…"}`,**绝不动它**(负向半边)。
 * · 平台不认识这个 `taskType` ⇒ 如实说「不知道怎么取消」,**不静默当成功**
 *   (静默成功会让页面显示「已取消」而后端还在烧钱)。
 * · 引擎 SPI 那一支由 provider 自己收口 `stopped`(它已经这么做了);
 *   Redshift / Glue 两支由本函数收口 —— **取消是用户的意图**,台账要立刻反映成 `stopped`,
 *   否则组会一直停在 `running`(轮询器可能早就随进程退出了)。
 */
export async function cancelRunOnItsTarget(
  run: CancellableRun,
  opts: { job?: Record<string, unknown> } = {}
): Promise<CancelOutcome> {
  const base = { targetId: run.targetId, runId: run.runId };
  if (run.status !== CANCELLABLE_STATUS) {
    return { ...base, cancelled: false, reason: `已终态(${run.status})—— 不连坐` };
  }
  try {
    if (run.taskType.startsWith("etl-redshift")) {
      if (!run.statementId) return { ...base, cancelled: false, reason: "该运行记录没有 statementId,无法定位要取消的语句" };
      const client = await redshiftClientForTarget(run.targetId);
      await client.send(new CancelStatementCommand({ Id: run.statementId }));
      await settleStopped(run);
      return { ...base, cancelled: true };
    }
    if (run.taskType === "etl-glue") {
      if (!run.glueJobName || !run.glueJobRunId) {
        return { ...base, cancelled: false, reason: "该运行记录缺 Glue 作业名或 JobRunId,无法定位要停的作业运行" };
      }
      const glue = await glueClientForTarget(run.targetId);
      await glue.send(new BatchStopJobRunCommand({ JobName: run.glueJobName, JobRunIds: [run.glueJobRunId] }));
      await settleStopped(run);
      return { ...base, cancelled: true };
    }
    if (run.taskType === "emr-serverless") {
      if (!run.nativeRunId) return { ...base, cancelled: false, reason: "该运行记录缺 nativeRunId(EMR jobRunId)" };
      if (!opts.job) return { ...base, cancelled: false, reason: "缺作业定义,无法解析 EMR 应用" };
      // provider.stop 自己会把 run 收口成 stopped(不重复写,免两个作者)
      await getProvider("emr-serverless").stop(opts.job as never, run.runId, run.nativeRunId);
      return { ...base, cancelled: true };
    }
    return {
      ...base,
      cancelled: false,
      reason: `平台还不知道怎么取消这种运行(taskType=${run.taskType})—— 请到该执行环境的控制台手动停止`,
    };
  } catch (e) {
    return { ...base, cancelled: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

async function settleStopped(run: CancellableRun): Promise<void> {
  await updateRunRecord({
    taskId: run.taskId,
    runId: run.runId,
    set: { status: "stopped", finishedAt: new Date().toISOString() },
  });
}
