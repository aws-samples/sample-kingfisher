// 同步任务的**下线单一作者**:按 `channel` 把「真停 + 真撤」做掉,并如实报「有没有停下来」。
//
// 🔴🔴 【为什么存在(2026-09-16 全仓核实的三个洞)】
//   ① `DELETE /api/sync/[id]` 只删 DDB 行 —— **零后台清理**:通道继续跑,而平台连它的
//      identifier / integrationArn 都随行消失 ⇒ 永久孤儿(计费 + 数据继续流动);
//   ② 全仓**没有** `StopReplicationTaskCommand` ⇒ DMS 通道(全量/增量/实时 CDC)**从来没被真正停过**:
//      「停止」只把 `status` 改成 `stopped`,复制任务照搬数据、复制实例照计费。
//      多法域下这是**停不下来的跨境数据流动**(核心承诺被击穿);
//   ③ `stop` 路由里 Glue 用 `BatchStopJobRun({ JobRunIds: [] })` —— **空数组停不了任何 run**,
//      而页面显示「已停止」。
// 🔴 与同一条不变量:**撤不下来就不许把记录改成「已停止」/ 不许删记录**。
// 🔴 客户端一律用**创建时那一套**:起 sync 是 per-target 的,
//   创建(start 路由)与下线(本文件)同用「任务章 → 区」这一个解析(bindingTargets + regionOfTarget);
//   下线必须打在创建它的地方 —— 用 home 客户端去停非 home 的 run,GetJobRuns 直接 EntityNotFound,
//   改动前的行为等于把「Glue 里没有这个作业」当成「已停」(孤儿 run 继续跑继续计费)。
//   区解析不出来 = 不知道它在哪跑 ⇒ hardFailure(绝不当成「没东西可停」)。
// zero-etl / DMS 仍是主控区托管通道(原则 3),它们的服务层照旧打 home。
import { GetJobRunsCommand, BatchStopJobRunCommand, DeleteJobCommand } from "@aws-sdk/client-glue";
import { teardownReplicationTask } from "@/lib/realtime/dms-service";
import { deleteZeroEtlIntegration, dropDestinationDatabase } from "@/lib/realtime/zeroetl-service";
import { bindingTargets, regionOfTarget } from "@/lib/exec-env/data-plane-target";
import { glueClientFor } from "@/lib/exec-env/target-clients";
import type { SyncTask } from "@/types/sync-task";

/** 一次 HTTP 请求内**最多**等多久终态。
 *  🔴 默认 20s 是被**入口的 60s 边缘超时**决定的(CloudFront/ALB):等超了客户端拿到的是
 *  **504「不知道成没成」**,比任何明确的拒因都糟(真环境实测:段 wp24 第一版就栽在这)。
 *  等不到就回**可重试**的拒因(见 `teardownIsRetryable`),让用户过几十秒再点一次。
 *  `SYNC_TEARDOWN_WAIT_MS` 可调(判据里调小,免得一条测试等 20s)。 */
const IN_REQUEST_WAIT_MS = Math.max(1, Number(process.env.SYNC_TEARDOWN_WAIT_MS || 20_000));

/** Glue run 的**非终态**(这些才需要去停;终态的停了会被服务拒)。 */
const GLUE_RUNNING = ["STARTING", "RUNNING", "STOPPING", "WAITING"];

export interface SyncTeardownResult {
  channel: SyncTask["channel"];
  /** 真停掉的 Glue run 数 / DMS 是否真停下来 */
  stoppedRuns?: number;
  dms?: { found: boolean; stopped: boolean; deleted: boolean; finalStatus?: string };
  integrationDeleted?: boolean;
  glueJobDeleted?: boolean;
  /** 🔴 **硬失败**:那个东西**还在跑** ⇒ 调用方不许把记录改成已停止/删掉。
   *  `retryable` = 「它正在停的路上」(还没到终态)⇒ 调用方该回**可重试**的 409,而不是 502:
   *  「还在停,请稍后再点」与「停不下来」是两件事,混成一个码就等于把可恢复说成故障。 */
  hardFailures: Array<{ what: string; error: string; retryable?: boolean }>;
  /** 软失败:清理残留没做干净(不影响「已经停了」这个事实),如实带出但不阻塞 */
  softFailures: Array<{ what: string; error: string }>;
  /** 没有可撤的东西(不算失败) */
  skipped?: string;
}

/**
 * 把一个同步任务从它的后台通道上撤下来。
 * @param purge false = 「停止」(停跑,保留可再启动的产物);true = 「删除」(停 + 撤产物)
 */
export async function teardownSyncChannel(
  task: SyncTask,
  opts: { purge: boolean; waitMs?: number } = { purge: false }
): Promise<SyncTeardownResult> {
  const out: SyncTeardownResult = { channel: task.channel, hardFailures: [], softFailures: [] };

  if (task.channel === "zero-etl") {
    // Zero-ETL 是托管常驻复制:「停止」本身就是 DeleteIntegration(成本闭环)。
    if (!task.integrationArn) {
      out.skipped = "没有 integrationArn(从未启动过 zero-etl 集成)";
      return out;
    }
    try {
      await deleteZeroEtlIntegration(task.integrationArn);
      out.integrationDeleted = true;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      // 集成本来就不在了 ⇒ 目的已达成(幂等),不算硬失败
      if (/NotFound|does not exist|ResourceNotFound/i.test(msg)) {
        out.integrationDeleted = true;
        out.softFailures.push({ what: "deleteZeroEtlIntegration", error: `集成已不存在(幂等):${msg.slice(0, 160)}` });
      } else {
        out.hardFailures.push({ what: "deleteZeroEtlIntegration", error: msg.slice(0, 240) });
        return out; // 🔴 集成还在 = 还在复制 = 还在计费 ⇒ 直接回,不许说已停
      }
    }
    const destDb = task.redshiftConfig?.database || (task as { zeroEtlConfig?: { destDb?: string } }).zeroEtlConfig?.destDb;
    // 🔴 目标库**停止时也丢**(与改动前的 `stop` 逐字一致:便于同名任务重启时干净重建;
    //   best-effort ⇒ 失败只记软失败)。不要「顺手改语义」——那会变成另一个回归。
    if (destDb) {
      try {
        await dropDestinationDatabase(destDb);
      } catch (e) {
        out.softFailures.push({ what: "dropDestinationDatabase", error: String((e as Error)?.message ?? e).slice(0, 200) });
      }
    }
    return out;
  }

  if (task.channel === "dms") {
    const r = await teardownReplicationTask(task.taskId, {
      purge: opts.purge, waitMs: opts.waitMs ?? IN_REQUEST_WAIT_MS,
    });
    out.dms = { found: r.found, stopped: r.stopped, deleted: r.deleted, finalStatus: r.finalStatus };
    if (!r.found) {
      out.skipped = "DMS 里没有这个任务的复制任务(从未启动或已被删)";
      return out;
    }
    if (r.error) {
      // 「没到终态」= 正在停的路上(可重试);其它(Stop/Delete 被服务拒)= 真失败
      const retryable = /没到终态/.test(r.error);
      out.hardFailures.push({ what: "teardownReplicationTask", error: r.error, retryable });
    }
    return out;
  }

  // glue 通道
  if (!task.glueJobName) {
    out.skipped = "没有 glueJobName(批同步作业从未创建)";
    return out;
  }
  // 停/删打在任务章说的那个区。解析不出区 = 不知道它在哪跑,
  // 按硬失败报(绝不回落 home 去停:那会「没找到 ⇒ 当已停」,孤儿 run 在别的区继续跑继续计费)。
  let glue: Awaited<ReturnType<typeof glueClientFor>>;
  try {
    const tid = bindingTargets(task as { targets?: unknown; targetId?: unknown })[0];
    glue = await glueClientFor(await regionOfTarget(tid));
  } catch (e) {
    out.hardFailures.push({ what: "resolveTargetRegion", error: String((e as Error)?.message ?? e).slice(0, 240) });
    return out;
  }
  let ids: string[] = [];
  try {
    const { JobRuns = [] } = await glue.send(new GetJobRunsCommand({ JobName: task.glueJobName, MaxResults: 50 }));
    // 🔴 只停**非终态**那些,并且必须拿到真实 runId ——
    //   改动前是 `JobRunIds: []`(空数组),等于什么都没停,而页面显示「已停止」。
    ids = JobRuns.filter((r) => GLUE_RUNNING.includes(String(r.JobRunState || "")))
      .map((r) => String(r.Id))
      .filter(Boolean);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/EntityNotFound/i.test(msg)) {
      out.skipped = `Glue 里没有作业 ${task.glueJobName}(已被删)`;
      return out;
    }
    out.hardFailures.push({ what: "GetJobRuns", error: msg.slice(0, 240) });
    return out; // 🔴 读不到就不知道有没有在跑 ⇒ 绝不当成「已停」
  }
  out.stoppedRuns = 0;
  if (ids.length) {
    try {
      const r = await glue.send(new BatchStopJobRunCommand({ JobName: task.glueJobName, JobRunIds: ids }));
      const errs = r.Errors ?? [];
      out.stoppedRuns = ids.length - errs.length;
      if (errs.length) {
        out.hardFailures.push({
          what: "BatchStopJobRun",
          error: errs.map((x) => `${x.JobRunId}: ${x.ErrorDetail?.ErrorMessage ?? ""}`).join(" | ").slice(0, 240),
        });
        return out;
      }
    } catch (e) {
      out.hardFailures.push({ what: "BatchStopJobRun", error: String((e as Error)?.message ?? e).slice(0, 240) });
      return out;
    }
  }
  if (opts.purge) {
    try {
      await glue.send(new DeleteJobCommand({ JobName: task.glueJobName }));
      out.glueJobDeleted = true;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/EntityNotFound/i.test(msg)) out.glueJobDeleted = true;
      else out.hardFailures.push({ what: "DeleteJob", error: msg.slice(0, 240) });
    }
  }
  return out;
}

/** 全部硬失败都只是「还在停的路上」⇒ 调用方该回可重试的 409(而不是 502 故障)。 */
export function teardownIsRetryable(r: SyncTeardownResult): boolean {
  return r.hardFailures.length > 0 && r.hardFailures.every((f) => f.retryable === true);
}

/** 硬失败的统一人话(两个路由共用;要改口径只改这里)。 */
export function teardownFailureMessage(r: SyncTeardownResult, tail: string): string {
  return (
    `同步通道没能真正停下来(${r.channel}):` +
    r.hardFailures.map((f) => `${f.what} — ${f.error}`).join(" | ") +
    `。${tail}`
  );
}
