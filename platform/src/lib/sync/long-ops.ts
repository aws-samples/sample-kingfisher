// 同步向导两种长操作的执行体:按预览建目标表(execute-ddl)/ 生成建表语句并探测目标表(generate-ddl)。
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

export type SyncLongOpKind = "sync-execute-ddl" | "sync-generate-ddl";
export const SYNC_LONG_OP_EXECUTORS: Pick<LongOpExecutorRegistry, SyncLongOpKind> = {
  "sync-execute-ddl": syncExecuteDdl,
  "sync-generate-ddl": syncGenerateDdl,
};
