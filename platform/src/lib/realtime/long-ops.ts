// 实时计算三种长操作的执行体:启动 / 停止 / 删除 Flink 作业。
//
// 原路由(app/api/flink/jobs/[id]/{start,stop} · app/api/flink/jobs/[id] DELETE)的「主体」原样搬入:
// 读作业行 / 项目鉴权 / 启动前的落点反向卡(章说别区而通道解析不出来 ⇒ 409,不静默落主控区)/ 用户确认令牌 **留在路由**;
// 这里只做「拿到已校验的入参 → 调 flink-service(内部经 awaitTerminal 等 MSAF 过渡态)→ 写状态 / 审计 → 回 data」。
//
// 🔴 为什么它们要进长操作:MSAF 的过渡态等待实测 1–3 分钟(STARTING / STOPPING / UPDATING),原来三条路由都在请求里原地等,
//    撞 CloudFront 60s 墙就 504,而应用其实在那个区照常启停 —— 与同一种病。
// 错误口径与接入前逐字一致(409 DECISION_REQUIRED 带诊断 / 500 真失败并标 error / 502 销毁失败不删行 / 202 已受理)。

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { recordAudit } from "@/lib/audit";
import type { LongOpExecutor, LongOpExecutorRegistry } from "@/lib/long-ops/executor-types";
import { LongOpHttpError } from "@/lib/long-ops/store";
import { FlinkDecisionRequired, outputPath, pauseFlinkJob, requestFlinkDeletion, startFlinkJob } from "./flink-service";
import { resolveFlinkPlace } from "./flink-place";
import { adviceByCode } from "./failure-advisor";

const USER_ID = "default-user";

async function readJob(jobId: string): Promise<Record<string, any>> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.FLINK_JOBS, Key: { userId: USER_ID, jobId } }));
  if (!Item) throw new LongOpHttpError(404, "作业不存在", { code: "NOT_FOUND" });
  return Item;
}

// ── 启动(原 app/api/flink/jobs/[id]/start) ──
// 🔴 启动可能因【需要用户决策】而中止(HTTP 409 + code=DECISION_REQUIRED):典型为 CDC 快照位点已被源库清理,
//    唯一出路是"丢弃进度从头重读"(会重算历史/可能重复写入)。平台绝不代劳该决策——返回诊断与后果说明,
//    由用户在页面上确认后带 `{ confirm: "discard-state" }` 重新调用。见 flink-service.ts FlinkDecisionRequired。
const flinkStart: LongOpExecutor<"flink-start"> = async (params, ctx) => {
  const { jobId, targetId: jobTarget, discardStateConfirmed } = params;
  const job = await readJob(jobId);
  // 落点在路由里已真解析过一遍(反向卡);这里再解析一次取 outputBucket(同一作者 resolveFlinkPlace,不另抄一份)
  const place = await resolveFlinkPlace(jobTarget);
  const now = new Date().toISOString();
  try {
    const { appName } = await startFlinkJob(jobId, job.sql, job.sinkType, job.sinkDatasourceId, job.connectorIds,
      { subnetIds: job.vpcSubnets, securityGroupIds: job.vpcSecurityGroups },
      {
        parallelism: job.parallelism, parallelismPerKPU: job.parallelismPerKPU, autoScalingEnabled: job.autoScalingEnabled,
        checkpointingEnabled: job.checkpointingEnabled, checkpointIntervalMs: job.checkpointIntervalMs, minPauseBetweenCheckpointsMs: job.minPauseBetweenCheckpointsMs,
        logLevel: job.logLevel, metricsLevel: job.metricsLevel, snapshotsEnabled: job.snapshotsEnabled, runtimeProperties: job.runtimeProperties,
      },
      job.sourceDatasourceId, job.executionRoleArn,
      { discardStateConfirmed, targetId: jobTarget });
    await docClient.send(new UpdateCommand({
      TableName: TABLES.FLINK_JOBS, Key: { userId: USER_ID, jobId },
      // lastStartedAt:本次运行起始时间戳,供日志查看按【当前运行】隔离历史失败运行的日志(避免旧崩溃日志混入当前视图)。
      UpdateExpression: "SET #s = :s, appName = :a, outputPath = :o, lastError = :n, lastStartedAt = :now, updatedAt = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "starting", ":a": appName, ":o": outputPath(jobId, place.outputBucket), ":n": "", ":now": now },
    }));
    recordAudit(ctx.req, "flink.start", { resourceType: "flink", resourceId: jobId, detail: { name: job.name, appName } }).catch(() => {});
    return { data: { jobId, status: "starting", appName, message: "Flink 流作业启动中(MSAF 应用 STARTING→RUNNING,约 1-3 分钟)" }, resultStatus: 202 };
  } catch (e: unknown) {
    // ① 需要用户决策 → 409,**不标 error 状态**(作业没坏,只是在等用户拍板;也不写 lastError,避免把"待决策"渲染成"失败")。附诊断与可执行选项供页面展示。
    if (e instanceof FlinkDecisionRequired) {
      throw new LongOpHttpError(409, e.message, {
        code: "DECISION_REQUIRED",
        detail: { failureCode: e.code, confirmToken: e.confirmToken, context: e.context, advice: adviceByCode(e.code) || undefined },
        cause: e,
      });
    }
    // ② 真失败 → 标 error + 记根因。
    await docClient.send(new UpdateCommand({
      TableName: TABLES.FLINK_JOBS, Key: { userId: USER_ID, jobId },
      UpdateExpression: "SET #s = :s, lastError = :e, updatedAt = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "error", ":e": String((e as Error)?.message || e).slice(0, 300), ":now": now },
    })).catch(() => {});
    throw new LongOpHttpError(500, String((e as Error)?.message || e), { cause: e });
  }
};

// ── 停止(原 app/api/flink/jobs/[id]/stop):仅 StopApplication 停 KPU 计费,【保留 MSAF 应用与日志组】 ──
const flinkStop: LongOpExecutor<"flink-stop"> = async (params, ctx) => {
  const { jobId, targetId } = params;
  const job = await readJob(jobId);
  try {
    // 停止前抓真实根因错误(若有),持久化到 lastError —— 这样停止后 AI 诊断仍能直接拿到根因。
    const { lastError } = await pauseFlinkJob(jobId, targetId);
    // 🔴 StopApplication 是**异步**的(实测 STOPPING → READY 约 44s):
    //   写 `stopping`(不短路),读取时对账到 READY 才变 `stopped`;原来直接写 `stopped` 让用户据此去删,正撞上过渡态。
    const values: Record<string, unknown> = { ":s": "stopping", ":now": new Date().toISOString() };
    if (lastError) values[":e"] = lastError;
    await docClient.send(new UpdateCommand({
      TableName: TABLES.FLINK_JOBS, Key: { userId: USER_ID, jobId },
      UpdateExpression: `SET #s = :s, updatedAt = :now${lastError ? ", lastError = :e" : ""}`,
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: values,
    }));
    recordAudit(ctx.req, "flink.stop", { resourceType: "flink", resourceId: jobId, detail: { name: job.name } }).catch(() => {});
    return { data: { jobId, status: "stopping", message: "正在停止 Flink 作业(约 1 分钟停稳;停稳后 KPU 计费停止,后台应用与日志保留,可再启动/诊断)" } };
  } catch (e: unknown) {
    throw new LongOpHttpError(500, String((e as Error)?.message || e), { cause: e });
  }
};

// ── 删除(原 app/api/flink/jobs/[id] DELETE):真正销毁 MSAF 应用(+删日志组)再删记录 ──
// 🔴🔴 销毁失败**不许删记录**:流式作业「一区一个」,记录一删,那个区的应用就成了
//   继续消费、继续写数、继续计费、平台再也看不见的孤儿(不变量)。`requestFlinkDeletion` 抛出来的就是真失败。
const flinkDelete: LongOpExecutor<"flink-delete"> = async (params, ctx) => {
  const { jobId, targetId } = params;
  const job = await readJob(jobId);
  let outcome: "deleted" | "accepted";
  try {
    outcome = await requestFlinkDeletion(jobId, targetId);
  } catch (e: unknown) {
    throw new LongOpHttpError(
      502,
      `删除前销毁该区的 Flink 应用失败:${String((e as Error)?.message ?? e).slice(0, 240)}。` +
        `作业**未删除** —— 先删记录会让那个应用变成再也无法从平台停掉的孤儿(它仍在消费与写数,并继续计费)。请重试。`,
      { code: "UPSTREAM_ERROR", cause: e },
    );
  }
  // 应用还在停:删除**已受理**(202),后台停稳后销毁并删行;列表上显示「删除中」直到消失
  if (outcome === "accepted") {
    recordAudit(ctx.req, "flink.delete.accepted", { resourceType: "flink", resourceId: jobId, detail: { name: job.name } }).catch(() => {});
    return {
      data: { deleted: false, deleting: true, message: "删除已受理:该区的 Flink 应用还在停止中,停稳后会自动销毁并从列表移除(无需再点)" },
      resultStatus: 202,
    };
  }
  recordAudit(ctx.req, "flink.delete", { resourceType: "flink", resourceId: jobId, detail: { name: job.name } }).catch(() => {});
  return { data: { deleted: true } };
};

export type RealtimeLongOpKind = "flink-start" | "flink-stop" | "flink-delete";
export const REALTIME_LONG_OP_EXECUTORS: Pick<LongOpExecutorRegistry, RealtimeLongOpKind> = {
  "flink-start": flinkStart,
  "flink-stop": flinkStop,
  "flink-delete": flinkDelete,
};
