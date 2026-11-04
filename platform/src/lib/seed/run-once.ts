// @kf-batch 50-CAPSEED-seed-dispatch
// 🔴🔴 **「在该区下发一次造数」的唯一作者**(登记 CAP-SEED 的交付)。
//
// 【谁调它】两条路,同一个函数:
//   · 手动:`POST /api/seed/run`(数据源页「立即造数」)⇒ `trigger: "manual"`:启动后**立刻返回**(Glue 跑几分钟,
//     ALB 空闲超时只有 60s),后台轮询到终态;**这次的 run 台账由本函数写**(taskType=seed、触发=手动)。
//   · 定时:该区 MWAA Serverless 上的单节点 platform-action 工作流 → 主控区命令表 → 消费端 → `seedRunHandler`
//     ⇒ `trigger: "schedule"`:**等到终态**(失败就抛 ⇒ 命令 failed ⇒ DAG 的 task 失败);run 台账由 DAG 的
//     `__start` / `__finish` 收口(taskType=seed、触发=自动),本函数**不重复写**(写两次就是两行)。
// 【在哪跑】造数作业是部署期建在**该区**的那个(名字见 seed-job.ts);客户端与参数都按该区落点解析
//   (`resolveGlueBinding`:非主控区要求可承接 + core 资源袋齐全,缺一即拒),**绝不回落主控区**。
// 【fail-closed】作业不存在(生产模式 / 该区没跑过部署期造数)⇒ `SeedJobMissing`(409,说清怎么补);
//   已有一轮在跑 ⇒ `SeedAlreadyRunning`(409,不排队、不并发);参数不合法 ⇒ `SeedInvalid`(400)。
import { ulid } from "ulid";
import { resolveGlueBinding } from "@/lib/exec-env/data-plane-target";
import { regionalClient } from "@/lib/aws/clients";
import { putRunRecord, updateRunRecord, resolveRunStamp } from "@/lib/monitor/run-records";
import { validateActionParams, SEED_ACTION_ID, type SeedDataset } from "@/lib/scheduler/action-commands";
import {
  seedJobNameFor,
  seedJobArguments,
  seedRunTaskId,
  SEED_TERMINAL_OK,
  SEED_TERMINAL_BAD,
} from "@/lib/seed/seed-job";

export class SeedInvalid extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "SeedInvalid";
  }
}
/** 该区没有部署期的造数作业(生产模式部署 / 该区还没跑过部署期造数)。 */
export class SeedJobMissing extends Error {
  constructor(readonly targetId: string, readonly region: string, readonly jobName: string) {
    super(
      `执行范围 ${targetId}(${region})没有造数作业 ${jobName} —— 造数作业由部署期的演示模式建在该区` +
        `(主控区 scripts/22-seed-game.sh · 其它区 scripts/23-seed-game-region.sh);生产模式部署不造数`
    );
    this.name = "SeedJobMissing";
  }
}
/** 该区已有一轮造数在跑(作业并发上限 1)。 */
export class SeedAlreadyRunning extends Error {
  constructor(readonly targetId: string, readonly jobName: string) {
    super(`执行范围 ${targetId} 的造数作业 ${jobName} 已有一轮在跑 —— 等它跑完再下发(不排队、不并发)`);
    this.name = "SeedAlreadyRunning";
  }
}
/** 造数作业跑失败(定时那条路据此让命令 failed)。 */
export class SeedRunFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedRunFailed";
  }
}

export interface SeedRunResult {
  targetId: string;
  region: string;
  jobName: string;
  jobRunId: string;
  /** 手动:台账行的 runId;定时:null(行由 DAG 收口)。 */
  runId: string | null;
  /** 手动:RUNNING(后台轮询收口);定时:终态 SUCCEEDED。 */
  state: string;
  executionTimeSec?: number;
}

/** 轮询节奏(定时那条路要在命令租约 40 分钟内收口 ⇒ 最多等 35 分钟)。可被单测改小。 */
export const SEED_POLL = { intervalMs: 20_000, maxWaitMs: 35 * 60_000 };

type GlueLike = { send: (c: unknown) => Promise<any> };

function errName(e: unknown): string {
  return String((e as { name?: string })?.name || "");
}

async function waitTerminal(glue: GlueLike, jobName: string, jobRunId: string, sleep: (ms: number) => Promise<void>) {
  const { GetJobRunCommand } = await import("@aws-sdk/client-glue");
  const deadline = Date.now() + SEED_POLL.maxWaitMs;
  for (;;) {
    await sleep(SEED_POLL.intervalMs);
    const { JobRun } = await glue.send(new GetJobRunCommand({ JobName: jobName, RunId: jobRunId }));
    const state = String(JobRun?.JobRunState || "");
    if (state === SEED_TERMINAL_OK) return { state, executionTimeSec: Number(JobRun?.ExecutionTime || 0), error: "" };
    if ((SEED_TERMINAL_BAD as readonly string[]).includes(state)) {
      return { state, executionTimeSec: Number(JobRun?.ExecutionTime || 0), error: String(JobRun?.ErrorMessage || state) };
    }
    if (Date.now() >= deadline) {
      return { state: "TIMEOUT_WAITING", executionTimeSec: 0, error: `等了 ${Math.round(SEED_POLL.maxWaitMs / 60_000)} 分钟仍未结束(最后状态 ${state || "未知"})` };
    }
  }
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 解析该区落点 + 确认造数作业在(启动与「建定时任务」共用这一处判定)。 */
async function seedPlace(targetId: string) {
  const landing = await resolveGlueBinding({ targetId });
  const jobName = seedJobNameFor(landing.targetId);
  const glue = (await regionalClient("glue", landing.region)) as unknown as GlueLike;
  const { GetJobCommand } = await import("@aws-sdk/client-glue");
  try {
    await glue.send(new GetJobCommand({ JobName: jobName }));
  } catch (e) {
    if (errName(e) === "EntityNotFoundException") throw new SeedJobMissing(landing.targetId, landing.region, jobName);
    throw e;
  }
  return { landing, jobName, glue };
}

/**
 * 「这个区能造数吗」—— 建定时造数任务时先问一次(不能 ⇒ 抛 `SeedJobMissing` / 落点拒绝,不建注定失败的任务)。
 * 🔴 与 `runSeedOnce` 用同一个判定(`seedPlace`),不另写一份。
 */
export async function assertSeedJobPresent(targetId: string): Promise<{ targetId: string; region: string; jobName: string }> {
  const { landing, jobName } = await seedPlace(targetId);
  return { targetId: landing.targetId, region: landing.region, jobName };
}

/**
 * 在该区下发一次造数。
 * @param args.projectId 归属项目(台账与审计按它;定时那条来自命令行,手动那条来自当前项目)
 */
export async function runSeedOnce(args: {
  targetId: string;
  dataset: SeedDataset | string;
  projectId: string;
  trigger: "manual" | "schedule";
  /** 单测注入(生产恒用真 sleep)。 */
  sleep?: (ms: number) => Promise<void>;
}): Promise<SeedRunResult> {
  // 🔴 与建定时任务 / 消费端**同一个**参数校验(两处各判一遍就是两个作者)
  const bad = validateActionParams(SEED_ACTION_ID, { dataset: args.dataset });
  if (bad) throw new SeedInvalid(bad);
  if (!args.projectId) throw new SeedInvalid("造数必须带归属项目(台账与审计按它记)");

  const { landing, jobName, glue } = await seedPlace(args.targetId);
  const { StartJobRunCommand } = await import("@aws-sdk/client-glue");

  const startedAt = new Date().toISOString();
  let jobRunId: string;
  try {
    const out = await glue.send(
      new StartJobRunCommand({ JobName: jobName, Arguments: seedJobArguments(landing.targetId, landing) })
    );
    jobRunId = String(out?.JobRunId || "");
  } catch (e) {
    if (errName(e) === "ConcurrentRunsExceededException") throw new SeedAlreadyRunning(landing.targetId, jobName);
    throw e;
  }
  if (!jobRunId) throw new SeedRunFailed(`Glue 没有回 JobRunId(作业 ${jobName},${landing.region})`);

  const sleep = args.sleep ?? realSleep;
  const base = { targetId: landing.targetId, region: landing.region, jobName, jobRunId };

  if (args.trigger === "schedule") {
    const t = await waitTerminal(glue, jobName, jobRunId, sleep);
    if (t.state !== SEED_TERMINAL_OK) {
      throw new SeedRunFailed(`造数作业 ${jobName}(${landing.region} · run ${jobRunId})${t.state}:${t.error}`);
    }
    return { ...base, runId: null, state: t.state, executionTimeSec: t.executionTimeSec };
  }

  // ── 手动:本函数写台账(建行 running → 后台轮询收口)──
  const runId = ulid();
  const stamp = resolveRunStamp({ projectId: args.projectId, targetId: landing.targetId }, landing.targetId);
  const taskId = seedRunTaskId(landing.targetId);
  await putRunRecord({
    taskId,
    runId,
    taskType: "seed",
    stamp,
    status: "running",
    startedAt,
    triggeredBy: "manual",
    extra: { glueJobName: jobName, glueJobRunId: jobRunId, dataset: args.dataset },
  });
  void (async () => {
    let set: Record<string, unknown>;
    try {
      const t = await waitTerminal(glue, jobName, jobRunId, sleep);
      set = {
        status: t.state === SEED_TERMINAL_OK ? "succeeded" : "failed",
        finishedAt: new Date().toISOString(),
        duration: t.executionTimeSec || Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000)),
        error: t.error ? `造数作业 ${jobName} ${t.state}:${t.error}` : null,
      };
    } catch (e) {
      set = { status: "failed", finishedAt: new Date().toISOString(), error: `轮询造数作业失败:${String((e as Error)?.message ?? e)}` };
    }
    await updateRunRecord({ taskId, runId, set, stamp }).catch((e) =>
      console.error("[seed/run-once] 手动造数收口写台账失败(run %s):%s", runId, String(e))
    );
  })();
  return { ...base, runId, state: "RUNNING" };
}
