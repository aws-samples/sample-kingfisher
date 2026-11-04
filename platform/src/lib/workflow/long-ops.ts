// 编排(工作流)四种长操作的执行体:发布 / 下线 / 手动触发 / 删除。
//
// 原路由(app/api/workflow/[id]/{publish,unpublish,trigger} · app/api/workflow/[id] DELETE)的「主体」原样搬入:
// 读工作流行 / 项目鉴权 / 触发前的子集校验 · 跨法域同意 · 运行组开立 **留在路由**;这里只做「调 publish-dag / 调度器(内部等
// serverless workflow 建成 · MWAA 加载 DAG)→ 写台账 / 审计 → 回**整个响应体**」。
//
// 🔴 这四条路由的历史响应不是 apiOk 信封,而是 `NextResponse.json({ success, dagId, … })` 这种**摊平形状**(页面与验收脚本读的是
//    `data.dagId` / `data.error` / `data.runs`)⇒ 执行体用 `rawBody: true`,同步 / 异步两条分支都原样交回;错误同理装进
//    `LongOpHttpError.body`(`longOpErrorResponse` / 客户端整形都按 body 逐字还原)。
// 🔴 为什么进长操作:serverless `ensureWorkflow` 要等到 60s 才放弃重试、经典 MWAA 解挂等调度器加载最多 3 分钟、
//    `deleteWorkflow` 要等在跑的 run 停完(24 × 5s)—— 原来发布 / 下线 / 删除都在请求里原地等,撞 60s 墙就 504 而产物已落。
//    发布的「解挂」原来是 fire-and-forget(为了躲 60s 墙);现在在执行体里**等它做完**,发布结束 = DAG 真的会被触发。

import { GetCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { CreateCliTokenCommand } from "@aws-sdk/client-mwaa";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { recordAudit } from "@/lib/audit";
import type { LongOpExecutor, LongOpExecutorRegistry } from "@/lib/long-ops/executor-types";
import { httpErrorFromMappers } from "@/lib/long-ops/http-error";
import { LongOpHttpError } from "@/lib/long-ops/store";
import { awaitTerminal, LongOpWaitBudgetExceeded } from "@/lib/long-ops/await-terminal";
import { schedulerEndpointFor, isServerlessEndpoint, mwaaClientFor } from "@/lib/scheduler/mwaa-endpoint";
import { findWorkflowArnByName, startWorkflowRun } from "@/lib/scheduler/serverless/workflow-client";
import { fanoutRejection, schedulerRejectResponse, fanoutRunBody, tagFanoutFailure } from "@/lib/scheduler/fanout-reject";
import { putRunRecord, resolveRunStamp } from "@/lib/monitor/run-records";
import { noteFanoutResult } from "@/lib/monitor/run-groups";
import { publishWorkflowDag, ensureDagUnpaused, unpublishWorkflowDag } from "./publish-dag";
import type { Workflow } from "@/types/workflow";

const USER_ID = "default-user";

/** 编排路由的 404 / 500 都是摊平形状 `{ error }`(不是 apiError 信封);这里只负责把同一形状装进可落库的错误。 */
function rawError(status: number, body: Record<string, unknown>, cause?: unknown): LongOpHttpError {
  const message = typeof body.error === "string" ? body.error : String((body.error as { message?: string } | undefined)?.message ?? status);
  return new LongOpHttpError(status, message, { body, cause });
}

async function readWorkflow(workflowId: string): Promise<Record<string, any>> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.WORKFLOWS, Key: { userId: USER_ID, workflowId } }));
  if (!Item) throw rawError(404, { error: "Not found" });
  return Item;
}

/** 调度类拒因 → 原路由的 Response(单一作者 schedulerRejectResponse)⇒ LongOpHttpError;不认识 ⇒ null。 */
const SCHEDULER_MAPPER = (e: unknown) => schedulerRejectResponse(e) ?? null;

// ── 发布(原 app/api/workflow/[id]/publish POST) ──
const workflowPublish: LongOpExecutor<"workflow-publish"> = async (params, ctx) => {
  const { workflowId } = params;
  const item = await readWorkflow(workflowId);
  const workflow = item as unknown as Workflow;
  try {
    // 生成+下发 DAG 走【共享权威实现】(与 schedule/enable 同一份);含 flag 分派 + 能力门 + runtime-lib 固定库下发 + assertSpecValid fail-loud。
    let dagId: string;
    let scheduler: "mwaa" | "serverless";
    // 逐区发布结果必须**透出去**:界面/验收要看得见「哪个区发成了、哪个没」
    let perTarget: Array<{ targetId: string; ok: boolean; scheduler?: string; artifact?: string; error?: string; code?: string }> = [];
    try {
      ({ dagId, scheduler, perTarget } = await publishWorkflowDag(workflow));
    } catch (e: unknown) {
      // 能力门 / spec 校验失败 ⇒ 400;那个区没装调度组件 ⇒ 409 + 直达补装(刻意不回落主控区);图里有服务侧表达不了的节点 ⇒ 400。
      const mapped = await httpErrorFromMappers(e, [SCHEDULER_MAPPER]);
      if (mapped) throw mapped;
      throw e;
    }
    await docClient.send(new UpdateCommand({
      TableName: TABLES.WORKFLOWS,
      Key: { userId: USER_ID, workflowId },
      UpdateExpression: "SET #s = :s, airflowDagId = :d, updatedAt = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "active", ":d": dagId, ":now": new Date().toISOString() },
    }));
    // 解挂走单一作者(端点解析不再各写一遍);🔴 原来是 fire-and-forget 躲 60s 墙,长操作里**等它做完**(best-effort,错误收进 perTarget 不抛)
    await ensureDagUnpaused(item as never, dagId);
    recordAudit(ctx.req, "workflow.publish", { resourceType: "workflow", resourceId: workflowId, detail: { dagId, scheduler } }).catch(() => {});
    // 🔴 逐区结果一并回:一次发布可能「一个区成、一个区没成」,只回一个 dagId 会把这件事藏起来
    return {
      data: { success: true, dagId, scheduler, perTarget, ...(perTarget.some((x) => !x.ok) ? { partial: true } : {}) },
      rawBody: true,
    };
  } catch (e: unknown) {
    if (e instanceof LongOpHttpError) throw e;
    throw rawError(500, { error: (e as Error)?.message ?? String(e) }, e);
  }
};

// ── 下线(原 app/api/workflow/[id]/unpublish POST):pause DAG + 删 S3 DAG 文件 + 状态回 draft、关调度 ──
// 幂等:未发布(无 airflowDagId)按已下线处理;DAG 文件不存在不报错。
const workflowUnpublish: LongOpExecutor<"workflow-unpublish"> = async (params, ctx) => {
  const { workflowId } = params;
  const item = await readWorkflow(workflowId);
  try {
    const result = await unpublishWorkflowDag(item as never);
    // 🔴🔴 有区撤不下来 ⇒ **不许**把记录改成 draft:记录留着用户还能重试;记录一改 draft,那个区的产物就成了平台再也定位不到的孤儿调度。
    if (!result.allRemoved) {
      throw rawError(502, {
        error: `下线失败(这些执行范围没撤下来:${result.failures.map((f) => `${f.targetId}: ${f.error}`).join(" | ")});`
          + `记录**保持已发布**,请重试`,
        code: "DAG_CLEANUP_FAILED", failures: result.failures, perTarget: result.perTarget,
      });
    }
    // 🔴 台账要清**每一个**真撤下来的区
    const removedTargets = result.perTarget.filter((x) => x.removed).map((x) => x.targetId);
    const depNames: Record<string, string> = {};
    const depRemove = removedTargets.map((t, i) => { depNames[`#t${i}`] = t; return `deployments.#t${i}`; });
    await docClient.send(new UpdateCommand({
      TableName: TABLES.WORKFLOWS,
      Key: { userId: USER_ID, workflowId },
      // 产物撤了,`deployments[该 target]` 也必须撤:留着旧 ARN 会让下一次发布拿它去 UpdateWorkflow 一个已经不存在的 workflow
      UpdateExpression: "SET #s = :s, scheduleEnabled = :e, updatedAt = :now REMOVE airflowDagId"
        + (depRemove.length ? `, ${depRemove.join(", ")}` : ""),
      ExpressionAttributeNames: { "#s": "status", ...depNames },
      ExpressionAttributeValues: { ":s": "draft", ":e": false, ":now": new Date().toISOString() },
    }));
    recordAudit(ctx.req, "workflow.unpublish", { resourceType: "workflow", resourceId: workflowId, detail: { ...result } }).catch(() => {});
    return { data: { success: true, ...result }, rawBody: true };
  } catch (e: unknown) {
    if (e instanceof LongOpHttpError) throw e;
    // 那个区没装调度组件 ⇒ 409 + 直达补装(判定收在单一作者里)
    const mapped = await httpErrorFromMappers(e, [SCHEDULER_MAPPER]);
    if (mapped) throw mapped;
    // 撤不下来就**不许**把记录改成 draft
    throw rawError(502, { error: `下线失败: ${(e as Error)?.message ?? e}`, code: "DAG_CLEANUP_FAILED" }, e);
  }
};

// ── 删除(原 app/api/workflow/[id] DELETE):**先收走 DAG,再删记录** ──
// 反过来(先删记录)会永久失去落点信息(章在记录上),那个 DAG 就再也没人能定位到它在哪个区的桶里 ⇒ 继续按 cron 跑一个平台上已不存在的工作流。
const workflowDelete: LongOpExecutor<"workflow-delete"> = async (params, ctx) => {
  const { workflowId } = params;
  const item = await readWorkflow(workflowId);
  let dagCleanup: { removed: boolean; bucket?: string; key?: string } = { removed: false };
  try {
    const r = await unpublishWorkflowDag(item as never);
    dagCleanup = r;
    // 🔴🔴 **逐区**都得撤干净才允许删记录
    if (!r.allRemoved) {
      throw rawError(502, {
        success: false,
        error: { code: "DAG_CLEANUP_FAILED", message: `删不掉该工作流在这些执行区的产物(${r.failures.map((f) => `${f.targetId}: ${f.error}`).join(" | ")});记录保留,请重试` },
        failures: r.failures,
      });
    }
  } catch (e: unknown) {
    if (e instanceof LongOpHttpError) throw e;
    // 那个区没装调度组件 ⇒ 本来就没发过 DAG,不阻塞删除(MwaaNotInstalled 由解析器抛)。
    if ((e as { name?: string })?.name !== "MwaaNotInstalled") {
      throw rawError(502, {
        success: false,
        error: { code: "DAG_CLEANUP_FAILED", message: `删不掉该工作流在执行区的 DAG 文件(${String((e as Error)?.message || e).slice(0, 200)});记录保留,请重试` },
      }, e);
    }
  }
  await docClient.send(new DeleteCommand({ TableName: TABLES.WORKFLOWS, Key: { userId: USER_ID, workflowId } }));
  recordAudit(ctx.req, "workflow.delete", {
    resourceType: "workflow", resourceId: workflowId,
    detail: { dagRemoved: dagCleanup.removed, dagBucket: dagCleanup.bucket, dagKey: dagCleanup.key },
  }).catch(() => {});
  return { data: { success: true, dagRemoved: dagCleanup.removed }, rawBody: true };
};

// ── 手动触发(原 app/api/workflow/[id]/trigger POST 的扇出主体) ──
// 缺省在**全部绑定区**各跑一次(子集 / 跨法域同意 / 运行组开立已在路由做完)
const workflowTrigger: LongOpExecutor<"workflow-trigger"> = async (params, ctx) => {
  const { workflowId, targets: runTargets, runGroupId } = params;
  const item = await readWorkflow(workflowId);
  const fanRuns: Array<Record<string, unknown>> = [];
  const fanFailures: Array<{ targetId: string; error: string; code?: string }> = [];
  // 原始拒因对象留着(状态码分派要 instanceof / code)
  const fanCauses: unknown[] = [];
  for (const targetId of runTargets) {
    try {
      const one = await triggerOneTarget(workflowId, item, targetId, runGroupId);
      fanRuns.push(one);
      await noteFanoutResult(runGroupId, targetId, { runId: String(one.runId ?? one.serviceRunId ?? "") || undefined }).catch(() => {});
    } catch (e) {
      fanCauses.push(e);
      // 🔴 逐 target 各自 try:第 2 个区失败时第 1 个区**已经触发上去了**;整体抛错会让界面显示「触发失败」而其实有一个区正在跑。
      const msg = String((e as Error)?.message ?? e).slice(0, 400);
      const code = (e as { code?: string })?.code;
      fanFailures.push({ targetId, error: msg, ...(code ? { code } : {}) });
      await noteFanoutResult(runGroupId, targetId, { reason: msg }).catch(() => {});
    }
  }
  await docClient.send(new UpdateCommand({
    TableName: TABLES.WORKFLOWS,
    Key: { userId: USER_ID, workflowId },
    UpdateExpression: "SET #s = :s, lastRunAt = :now, lastRunStatus = :rs, updatedAt = :now",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":s": "active", ":now": new Date().toISOString(), ":rs": fanRuns.length ? "running" : "failed" },
  }));
  recordAudit(ctx.req, "workflow.trigger", {
    resourceType: "workflow", resourceId: workflowId,
    detail: { dagId: String(item.airflowDagId), targets: runTargets, ...(runGroupId ? { runGroupId } : {}), failures: fanFailures },
  }).catch(() => {});
  if (fanRuns.length === 0) {
    // 全都没起来。先让**单一作者**认一遍拒因类型:那个区没装调度器要回 409 + 补装直达。
    const summary = `全部执行范围都没触发成功:${fanFailures.map((f) => `${f.targetId}: ${f.error}`).join(" | ")}`;
    const rejected = schedulerRejectResponse(fanoutRejection(fanCauses, fanFailures, summary), { failures: fanFailures });
    if (rejected) throw await LongOpHttpError.fromResponse(rejected);
    // 拒因一致(例如都缺产物)⇒ 把那个 code 抬到顶层,前端据它给出「去重新发布」的出口。
    const codes = Array.from(new Set(fanFailures.map((f) => f.code).filter(Boolean)));
    const uniform = codes.length === 1 ? String(codes[0]) : undefined;
    throw rawError(uniform === "SCHEDULER_ARTIFACT_MISSING" ? 409 : 500, { error: summary, ...(uniform ? { code: uniform } : {}), failures: fanFailures });
  }
  // 🔴 单区扇出必须与扇出前**逐字兼容**(顶层仍有 serviceRunId / runId / scheduler)⇒ 走单一作者拼装
  return { data: fanoutRunBody({ dagId: String(item.airflowDagId), runs: fanRuns, runGroupId, failures: fanFailures }), rawBody: true };
};

/** MWAA 经典:等调度器加载到这个 DAG 再 unpause(原来 5 轮 × 8s 的本地循环,改经唯一原语 awaitTerminal;预算逐字保留)。 */
const MWAA_DAG_LOAD_POLLS = 5;
const MWAA_DAG_LOAD_INTERVAL_MS = 8000;

/** 在**一个** target 上触发这个工作流(serverless / 经典两条路),回这一次的事实。 */
async function triggerOneTarget(
  workflowId: string,
  item: Record<string, any>,
  targetId: string,
  runGroupId?: string
): Promise<Record<string, unknown>> {
  // 🔴 原样抛:包成裸 Error 之后上面那层就判不出 `MwaaNotInstalled`,用户拿不到 409 + 「去执行环境补装调度」的直达链接
  const ep = await schedulerEndpointFor(targetId);
  // serverless 的手动触发 = StartWorkflowRun。
  // 🔴 这里**刻意不预写台账行**:serverless 的台账键是 `<服务侧 per-run dag_id>#<targetId>`,而 `StartWorkflowRun` 只回它自己的 `RunId`。
  if (isServerlessEndpoint(ep)) {
    const dagId = String(item.airflowDagId);
    try {
      const known = (item.deployments as Record<string, { workflowArn?: string } | undefined> | undefined)?.[ep.targetId]?.workflowArn;
      const workflowArn = known || (await findWorkflowArnByName(ep.region, dagId));
      if (!workflowArn) {
        // 🔴 机器可读的拒因**必须保住**(扇出之后它落在 `failures[].code` 里):找不到产物时给空结果 = 看起来像「没跑过」,这是最难查的一类。
        throw Object.assign(
          new Error(`${ep.region} 上找不到这个工作流的 serverless workflow(名字 ${dagId})—— 请先重新发布一次`),
          { code: "SCHEDULER_ARTIFACT_MISSING" }
        );
      }
      const r = await startWorkflowRun(ep.region, workflowArn);
      return { targetId: ep.targetId, region: ep.region, scheduler: "serverless", dagId, serviceRunId: r.RunId };
    } catch (err: unknown) {
      throw tagFanoutFailure(err, ep.targetId, ep.region);
    }
  }
  const envName = ep.envName;
  const dagId = item.airflowDagId;
  const runId = ulid();
  const now = new Date().toISOString();
  try {
    // 用 MWAA CLI token 经 Airflow REST 触发;先等 DAG 被调度器加载并 unpause(刚发布的 DAG 要等调度器扫到)。
    const cli = async (command: string) => {
      const { CliToken, WebServerHostname } = await mwaaClientFor(ep.region).send(new CreateCliTokenCommand({ Name: envName }));
      return fetch(`https://${WebServerHostname}/aws_mwaa/cli`, {
        method: "POST", headers: { Authorization: `Bearer ${CliToken}`, "Content-Type": "text/plain" }, body: command,
      });
    };
    const dagLoaded = async (): Promise<boolean> => {
      const listBody = await (await cli("dags list -o json")).json();
      const stdout = Buffer.from(listBody.stdout || "", "base64").toString();
      return stdout.includes(dagId);
    };
    // 原循环是「先查再等」:第一次查不等;之后最多再等 4 轮 × 8s
    let dagReady = await dagLoaded();
    if (!dagReady) {
      try {
        dagReady = await awaitTerminal<boolean>({
          what: `Airflow(${ep.targetId})加载 DAG ${dagId}`,
          maxPolls: MWAA_DAG_LOAD_POLLS - 1,
          initialMs: MWAA_DAG_LOAD_INTERVAL_MS,
          backoff: 1,
          probe: async () => ((await dagLoaded()) ? { done: true, value: true } : { done: false, state: "loading" }),
        });
      } catch (e) {
        if (!(e instanceof LongOpWaitBudgetExceeded)) throw e;
        dagReady = false;
      }
    }
    if (!dagReady) {
      throw new Error(`DAG 尚未在 ${ep.targetId} 的 Airflow 就绪(刚发布需等待调度器加载,约 1 分钟),请稍后重试触发`);
    }
    await cli(`dags unpause ${dagId}`);
    const res = await cli(`dags trigger ${dagId} -r ${runId}`);
    const result = await res.text();
    // 归属取工作流行;扇出时**每条 run 盖自己那个区的章**
    await putRunRecord({
      taskId: workflowId, runId, taskType: "workflow", startedAt: now, triggeredBy: "manual",
      stamp: resolveRunStamp(item, targetId),
      ...(runGroupId ? { runGroupId } : {}),
      extra: { airflowDagId: dagId, airflowRunId: runId, result: result.slice(0, 500) },
    });
    return { targetId, region: ep.region, scheduler: "mwaa", dagId, runId };
  } catch (err: unknown) {
    throw tagFanoutFailure(err, targetId, ep.region);
  }
}

export type WorkflowLongOpKind = "workflow-publish" | "workflow-unpublish" | "workflow-trigger" | "workflow-delete";
export const WORKFLOW_LONG_OP_EXECUTORS: Pick<LongOpExecutorRegistry, WorkflowLongOpKind> = {
  "workflow-publish": workflowPublish,
  "workflow-unpublish": workflowUnpublish,
  "workflow-trigger": workflowTrigger,
  "workflow-delete": workflowDelete,
};
