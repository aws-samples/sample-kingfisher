// 同步域四种长操作的执行体:向导的按预览建目标表(execute-ddl)/ 生成建表语句并探测目标表(generate-ddl),
// 与同步任务的停止(sync-stop)/ 删除(sync-delete,见文件后半)。
//
// 原路由(app/api/sync/execute-ddl · app/api/sync/generate-ddl)的「主体」原样搬入:项目鉴权 / 落点点名 / 拒收 SQL 文本 /
// buildTargetDdl(白名单 + 生成,唯一作者)**留在路由**;这里只做「解析数仓绑定 → 探测 / 建表 / 打标记(经 awaitTerminal 等终态)→ 审计 → 回 data」。
//
// 🔴 原 execute-ddl 的 `waitStatement` 是 30 × 500ms(15 秒)就放弃 ⇒ 数仓冷启动时建成了却回 504「15 秒内未完成,未打平台标记」,
//    用户去点「生成 DDL」才看到表在、标记却没打(覆盖守卫于是把平台建的表当客户的表)。现在整条路由是长操作:
//    建表语句等到 120 秒(SYNC_DDL_WAIT_POLLS × 500ms),超 45 秒自动转 202,页面右下「正在后台执行:按预览建目标表」。
// 错误口径与接入前逐字一致(409 已存在 / 409 绑定拒绝 / 500 建表失败 / 504 超预算 / 500 打标记失败)。

import { ExecuteStatementCommand, DescribeStatementCommand } from "@aws-sdk/client-redshift-data";
import { recordAudit } from "@/lib/audit";
import { redshiftDataClientFor } from "@/lib/exec-env/target-clients";
import { resolveRedshiftBinding, TargetBindingRejected } from "@/lib/exec-env/data-plane-target";
import { awaitTerminal, LongOpWaitBudgetExceeded } from "@/lib/long-ops/await-terminal";
import type { LongOpExecutor, LongOpExecutorRegistry } from "@/lib/long-ops/executor-types";
import { LongOpHttpError } from "@/lib/long-ops/store";
import { issueHandle } from "@/lib/security/query-handle";
import { probeTables, markPlatformTableSql } from "./target-table-guard";
import { GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
// 停 / 删共用**同一个**下线作者
import { teardownSyncChannel, teardownFailureMessage, teardownIsRetryable, TEARDOWN_LONG_OP_WAIT_MS, type SyncTeardownResult } from "./teardown";
import { updateSyncTaskIfExists } from "./task-write";
// task-runs 唯一写通道
import { settleRunningRuns, resolveRunStamp } from "@/lib/monitor/run-records";
// 最后一条 DMS 任务删掉之后,懒创建的复制实例就没人引用了 ⇒ 登记一条持久回收作业(实例上仍有任务时作业自己收口为「在用」)
import { enqueueDmsInstanceReclaim, type DmsReclaimEnqueueResult } from "@/lib/realtime/dms-instance-reclaim-job";
import { REPLICATION_INSTANCE_ID } from "@/lib/realtime/dms-service";
import { getTarget } from "@/lib/exec-env/registry";
import { bindingTargets } from "@/lib/exec-env/data-plane-target";

/** 建表 / 打标记语句最多等多少轮(× 500ms;原路由 30 轮 = 15 秒,长操作里放到 120 秒覆盖数仓冷启动)。 */
export const SYNC_DDL_WAIT_POLLS = 240;
const SYNC_DDL_WAIT_INTERVAL_MS = 500;

type StatementOutcome = { ok: true } | { ok: false; error: string } | { ok: null };

/** 等一条 Redshift Data 语句到终态(唯一原语 awaitTerminal;超预算 ⇒ `ok: null`,文案由调用方定)。 */
async function waitStatement(rs: ReturnType<typeof redshiftDataClientFor>, Id: string, what: string): Promise<StatementOutcome> {
  try {
    return await awaitTerminal<StatementOutcome>({
      what,
      maxPolls: SYNC_DDL_WAIT_POLLS,
      initialMs: SYNC_DDL_WAIT_INTERVAL_MS,
      backoff: 1,
      probe: async () => {
        const desc = await rs.send(new DescribeStatementCommand({ Id }));
        if (desc.Status === "FINISHED") return { done: true, value: { ok: true } };
        if (desc.Status === "FAILED" || desc.Status === "ABORTED") return { done: true, value: { ok: false, error: String(desc.Error || desc.Status) } };
        return { done: false, state: String(desc.Status ?? "") };
      },
    });
  } catch (e) {
    if (e instanceof LongOpWaitBudgetExceeded) return { ok: null };
    throw e;
  }
}

const waitSeconds = Math.round((SYNC_DDL_WAIT_POLLS * SYNC_DDL_WAIT_INTERVAL_MS) / 1000);

// ── 按预览建目标表(原 app/api/sync/execute-ddl POST) ──
const syncExecuteDdl: LongOpExecutor<"sync-execute-ddl"> = async (params, ctx) => {
  const { targetId, projectId, spec } = params;
  try {
    const rsb = await resolveRedshiftBinding({
      targetId,
      projectId,
      workgroupOverride: params.workgroupOverride,
      databaseOverride: params.databaseOverride,
    });
    // 建之前先看在不在:已存在的表**不打标记**(否则客户的表会被冒认成平台建的,覆盖守卫就失效了)。
    const [before] = await probeTables(rsb, [spec.fq]);
    if (before.exists) {
      throw new LongOpHttpError(409, `目标表 ${spec.fq} 已存在${before.platformCreated ? "(平台建的)" : "(不是平台建的)"},未重复建表`, { code: "CONFLICT" });
    }
    const rs = redshiftDataClientFor(rsb.region);
    const SecretArn = rsb.secretArn;
    const { Id } = await rs.send(new ExecuteStatementCommand({
      Sql: spec.ddl, WorkgroupName: rsb.workgroup, Database: rsb.database, ...(SecretArn ? { SecretArn } : {}),
    }));
    const handleId = Id
      ? await issueHandle({ statementId: Id, identity: ctx.identity, projectId, engine: "redshift" })
      : undefined;
    recordAudit(ctx.req, "sync.execute-ddl", {
      resourceType: "redshift-statement",
      targetId: rsb.targetId,
      resourceId: Id,
      detail: { projectId, workgroup: rsb.workgroup, targetId: rsb.targetId, table: spec.fq, ddl: spec.ddl.slice(0, 2000) },
    });
    const done = await waitStatement(rs, Id!, `建表语句 ${spec.fq}`);
    if (done.ok === false) throw new LongOpHttpError(500, `建表失败: ${done.error}`);
    if (done.ok === null) throw new LongOpHttpError(504, `建表语句已提交但 ${waitSeconds} 秒内未完成,未打平台标记;请稍后点「生成 DDL」确认`);
    const mark = await rs.send(new ExecuteStatementCommand({
      Sql: markPlatformTableSql(spec.fq), WorkgroupName: rsb.workgroup, Database: rsb.database, ...(SecretArn ? { SecretArn } : {}),
    }));
    const marked = await waitStatement(rs, mark.Id!, `平台标记 ${spec.fq}`);
    if (marked.ok !== true) {
      throw new LongOpHttpError(500, `表已建成,但打平台标记失败(${marked.ok === false ? marked.error : "超时"}):首次全量覆盖会被守卫拦下,请重试建表或在任务里确认覆盖`);
    }
    return { data: { success: true, statementId: Id, handleId, table: spec.fq, ddl: spec.ddl } };
  } catch (e: unknown) {
    if (e instanceof TargetBindingRejected) throw new LongOpHttpError(409, e.message, { code: "CONFLICT", cause: e });
    throw e;
  }
};

// ── 生成建表语句并探测目标表(原 app/api/sync/generate-ddl POST) ──
// 探测打到该章的数仓(区/workgroup/库/凭证四样一起解析)。
// 🔴 分两层错:**绑定拒绝**是用户可修的冲突,按 409 报出去;其余探测失败 = 「不知道」,如实回 null,
//    绝不说成「表不存在」(那正是原来那个恒为假的检测造成的事故形态)。
const syncGenerateDdl: LongOpExecutor<"sync-generate-ddl"> = async (params) => {
  const { targetId, projectId, spec } = params;
  let tableExists: boolean | null = null;
  let platformCreated: boolean | null = null;
  try {
    const rsb = await resolveRedshiftBinding({
      targetId,
      projectId,
      workgroupOverride: params.workgroupOverride,
      databaseOverride: params.databaseOverride,
    });
    try {
      const [st] = await probeTables(rsb, [spec.fq]);
      tableExists = st.exists;
      platformCreated = st.exists ? st.platformCreated : null;
    } catch { /* 探不到 ⇒ 保持 null(不知道) */ }
  } catch (e: unknown) {
    if (e instanceof TargetBindingRejected) throw new LongOpHttpError(409, e.message, { code: "CONFLICT", cause: e });
  }
  return { data: { ddl: spec.ddl, table: spec.fq, tableExists, platformCreated, columns: spec.mapped } };
};

// ── 同步任务的停止 / 删除(原 app/api/sync/[id]/stop POST 与 app/api/sync/[id] DELETE 的主体) ──
//
// 2026-11-12 真环境:DMS 任务页面「启动」后立刻「删除」,用户要点 3–4 次 —— 第 1 次 409(复制任务还在创建),第 2 次 502
// (对启动中的任务发 Stop 被 DMS 拒,被当成「撤不下来」),第 3 次 409(停止中),之后才删掉。两条路由原来都在一次请求里做完,
// 只敢等 20 秒;而「等它启动完 → 停 → 等停稳」本来就是分钟级的事。现在两条路由都是长操作:点一次,执行体等到通道真正到终态
// (预算 TEARDOWN_LONG_OP_WAIT_MS),超 45 秒自动转 202、页面右下「正在后台执行:删除同步任务」,做完列表自动刷新。
// 不变量照旧:**撤不下来就不许改状态 / 不许删行**(留着行,平台才还定位得到那条通道)。

const USER_ID = "default-user";

async function readSyncTask(taskId: string): Promise<Record<string, unknown>> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId } }));
  if (!Item) throw new LongOpHttpError(404, "任务不存在", { code: "NOT_FOUND" });
  return Item as Record<string, unknown>;
}

const waitedSeconds = Math.round(TEARDOWN_LONG_OP_WAIT_MS / 1000);

/** 通道没撤下来 ⇒ 该回的错误:「还在停的路上」409 可重试;「撤不下来」502。两者都不改记录。 */
function teardownRejection(td: SyncTeardownResult, retryableTail: string, hardTail: string): LongOpHttpError {
  const retryable = teardownIsRetryable(td);
  return new LongOpHttpError(
    retryable ? 409 : 502,
    teardownFailureMessage(td, retryable ? retryableTail : hardTail),
    retryable
      ? { code: "TEARDOWN_IN_PROGRESS", detail: { teardown: td, retryable: true } }
      : { code: "UPSTREAM_ERROR", detail: { teardown: td } },
  );
}

const syncStop: LongOpExecutor<"sync-stop"> = async ({ taskId }, ctx) => {
  const task = await readSyncTask(taskId);
  // 🔴🔴 真下线走**单一作者**:停不下来就**不许**把 status 改成 stopped(记录不许比现实更「已停止」;台账留着,用户还能再点一次)。
  const td = await teardownSyncChannel(task as never, { purge: false, waitMs: TEARDOWN_LONG_OP_WAIT_MS });
  if (td.hardFailures.length) {
    throw teardownRejection(
      td,
      `任务状态**保持不变** —— 已等了约 ${waitedSeconds} 秒,复制任务**还在停的路上**,稍后再点一次「停止」即可。`,
      "任务状态**保持不变** —— 它没能真正停下来,请重试或查该通道的服务侧状态。",
    );
  }
  const now = new Date().toISOString();
  // 唯一写通道
  await updateSyncTaskIfExists({
    taskId,
    UpdateExpression: "SET #s = :s, updatedAt = :now",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":s": "stopped", ":now": now },
  });
  // 实时(DMS)运行没有轮询器替它写终态 ⇒ 停止后把还挂着「运行中」的运行行收口,否则监控页的「运行中」计数永远多一条
  try {
    await settleRunningRuns({ taskId, status: "stopped", set: { finishedAt: now }, stamp: resolveRunStamp(task) });
  } catch { /* 收口失败不改变「已停止」这个事实 */ }
  recordAudit(ctx.req, "sync.stop", { resourceType: "sync", resourceId: taskId, detail: { name: task.name, teardown: td } }).catch(() => {});
  return { data: { stopped: true, teardown: td } };
};

const syncDelete: LongOpExecutor<"sync-delete"> = async ({ taskId }, ctx) => {
  const task = await readSyncTask(taskId);
  // 🔴🔴 **先把后台通道撤掉,再删行**:只删行的话 DMS 复制任务 / Glue 作业 / Zero-ETL 集成继续存在 —— 继续搬数据、继续计费,
  //   而它们的标识随行消失 ⇒ 平台再也定位不到(多法域下 = 停不下来的跨境数据流动)。撤不下来就不许删记录。
  const td = await teardownSyncChannel(task as never, { purge: true, waitMs: TEARDOWN_LONG_OP_WAIT_MS });
  if (td.hardFailures.length) {
    throw teardownRejection(
      td,
      `任务**未删除** —— 已等了约 ${waitedSeconds} 秒,通道**还在停的路上**,稍后再点一次「删除」即可(先删行会留下无法再下线的孤儿)。`,
      "任务**未删除** —— 先删行会让那条通道变成再也无法从平台停掉的孤儿(它可能仍在搬数据并计费)。请重试。",
    );
  }
  // DMS 通道:复制任务已撤 ⇒ 复制实例可能再无任务引用 ⇒ 入队回收作业;落点取任务自己绑定的执行区(实例就建在那个区),不默认主控区。
  // 入队失败不挡删除(实例仍被成本页的建议盯着),但要如实进响应与审计,不许静默。
  let reclaim: DmsReclaimEnqueueResult | { enqueued: false; error: string } | undefined;
  if ((task as { channel?: string }).channel === "dms") {
    try {
      const [boundTargetId] = bindingTargets(task as { targets?: unknown; targetId?: unknown });
      const target = boundTargetId ? await getTarget(boundTargetId) : null;
      if (!target) throw new Error("任务没有绑定可解析的执行区 ⇒ 不知道复制实例在哪个区");
      reclaim = await enqueueDmsInstanceReclaim({
        targetId: target.targetId, region: target.region, instanceId: REPLICATION_INSTANCE_ID,
        reason: "task-deleted", createdBy: `user:${ctx.identity.username}`,
      });
    } catch (e) {
      reclaim = { enqueued: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  }
  await docClient.send(new DeleteCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId } }));
  // 任务没了,它名下还挂着「运行中」的运行行也要收口(与停止同一写法):实时(DMS)运行没有轮询器替它写终态,
  // 不收口的话任务监控里永远多一条指向已删任务的「运行中」。
  try {
    await settleRunningRuns({ taskId, status: "stopped", set: { finishedAt: new Date().toISOString() }, stamp: resolveRunStamp(task) });
  } catch { /* 收口失败不改变「已删除」这个事实 */ }
  recordAudit(ctx.req, "sync.delete", { resourceType: "sync", resourceId: taskId, detail: { name: (task as { name?: string }).name, teardown: td, ...(reclaim ? { instanceReclaim: reclaim } : {}) } }).catch(() => {});
  // 响应体保持原来摊平的形状(页面与验收脚本读顶层字段)
  return { data: { success: true, teardown: td, ...(reclaim ? { instanceReclaim: reclaim } : {}) }, rawBody: true };
};

export type SyncLongOpKind = "sync-execute-ddl" | "sync-generate-ddl" | "sync-stop" | "sync-delete";
export const SYNC_LONG_OP_EXECUTORS: Pick<LongOpExecutorRegistry, SyncLongOpKind> = {
  "sync-execute-ddl": syncExecuteDdl,
  "sync-generate-ddl": syncGenerateDdl,
  "sync-stop": syncStop,
  "sync-delete": syncDelete,
};
