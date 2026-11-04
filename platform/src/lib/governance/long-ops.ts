// 数据目录三种 + 审批一种长操作的执行体:新建表 / 修改表结构 / 读真实列 / 审批通过后执行建表改表。
//
// 为什么它们进第一批(55 DESIGN §2.6):与建模四种共用 landing.ts 的 queryOnTarget / execOnBinding(readLiveColumns /
// createRedshiftCatalogTable / alterModelTable 都调它们);那两个原语改经 awaitTerminal 后,**所有**请求路径调用方必须同批接入,
// 否则建表 / 改表 / 读列当场抛 LongOpContextMissing —— 闸门就是这样逼出同族路由的。
//
// 原路由(app/api/governance/tables{,/alter,/columns} · app/api/approvals/[id])的「主体」原样搬入:鉴权 / 入参校验 /
// 落点点名 / 建表的 prod 审批分流 / 审批的 decideApproval **留在路由**;改表的 prod 分流要先读一次真实列算计划(慢),所以整段进执行体。

import { recordAudit } from "@/lib/audit";
import { actorFromIdentity } from "@/lib/exec-env/admin-ddl-executor";
import { userActor } from "@/lib/exec-env/residency-audit";
import type { LongOpExecutor, LongOpExecutorRegistry } from "@/lib/long-ops/executor-types";
import { rethrowAsHttpError } from "@/lib/long-ops/http-error";
import { LongOpHttpError } from "@/lib/long-ops/store";
import { findModelTableByPhysical } from "@/lib/modeling/dimensions";
import { assertPlatformGlobalSchema } from "@/lib/modeling/landing-fqn";
import { modelColumnFromCatalog } from "@/lib/modeling/alter";
import { createApproval } from "@/lib/projects/project-service";
import {
  DDL_APPROVAL_TYPE, alterCatalogTable, createRedshiftCatalogTable, createS3Table, executeApprovedDdl, planCatalogAlter, readLiveColumns,
  type CreateActorContext,
} from "./catalog-ddl";
import { catalogDdlErrorResponse } from "./catalog-ddl-http";
import { runSchemaSyncRecorded, schemaSyncMessage } from "./schema-sync-run";
import { schemaSyncWork } from "./schema-sync-work";

const MAPPERS = [catalogDdlErrorResponse];

function actorContextOf(identity: Parameters<typeof actorFromIdentity>[0]): CreateActorContext {
  return { username: identity.username, actor: actorFromIdentity(identity), residencyActor: userActor(identity) };
}

// ── 新建表(原 app/api/governance/tables POST 的执行分支;201) ──
const catalogCreateTable: LongOpExecutor<"catalog-create-table"> = async (params, ctx) => {
  const { spec, env } = params;
  const resourceId = `${spec.kind}:${spec.schema}.${spec.table}`;
  try {
    const result = spec.kind === "redshift" ? await createRedshiftCatalogTable(spec, actorContextOf(ctx.identity)) : await createS3Table(spec);
    recordAudit(ctx.req, "governance.table.create", { resourceType: "catalog-table", resourceId, targetId: spec.targetId, detail: { env, kind: spec.kind, columns: spec.columns.length } }).catch(() => {});
    return { data: result, resultStatus: 201 };
  } catch (e) {
    return rethrowAsHttpError(e, MAPPERS);
  }
};

// ── 修改表结构(原 app/api/governance/tables/alter POST:dryRun / 执行 / prod 申请审批 三分支) ──
const catalogAlterTable: LongOpExecutor<"catalog-alter-table"> = async (params, ctx) => {
  const { mode, targetId, schema, table, desired, confirmName, env, projectId } = params;
  const resourceId = `redshift:${schema}.${table}`;
  try {
    if (mode === "dryRun") {
      const planning = await planCatalogAlter({ targetId, schema, table, desired });
      return { data: { dryRun: true, ...planning } };
    }
    if (mode === "request-approval") {
      // 审批前先把计划算一遍:拒绝项 / 空计划在申请时就拒,不让一张做不到的单子进审批箱(文案 / 状态码与接入前逐字相同)
      const planning = await planCatalogAlter({ targetId, schema, table, desired });
      if (!planning.adoptable) throw new LongOpHttpError(400, planning.reason || "这张表不能图形化改表");
      if (planning.rejected.length) {
        throw new LongOpHttpError(400, "有变更 Redshift 做不到:" + planning.rejected.map((r) => `${r.column}:${r.reason}`).join(";"), { code: "ALTER_REJECTED" });
      }
      if (!planning.statements.length) throw new LongOpHttpError(400, "列定义与现状一致,没有任何变更可执行");
      if (planning.plan.dropColumns.length && confirmName !== table) {
        throw new LongOpHttpError(409, `计划会删除列 ${planning.plan.dropColumns.join(", ")}(不可逆)⇒ 需在确认框输入物理表名「${table}」才提交`, { code: "DECISION_REQUIRED" });
      }
      const approval = await createApproval({
        projectId,
        type: DDL_APPROVAL_TYPE,
        payload: { action: "alter", env, targetId, schema, table, desired, ...(confirmName ? { confirmName } : {}), statements: planning.statements },
        targetIds: [targetId],
        requestedBy: ctx.identity.username,
        requestedBySub: ctx.identity.sub,
      });
      recordAudit(ctx.req, "governance.table.alter.request", { resourceType: "catalog-table", resourceId, targetId, detail: { env, approvalId: approval.approvalId, statements: planning.statements.length } }).catch(() => {});
      return { data: { pending: true, approvalId: approval.approvalId, env, plan: planning.plan, statements: planning.statements }, resultStatus: 202 };
    }
    const out = await alterCatalogTable({ targetId, schema, table, desired, confirmName }, actorContextOf(ctx.identity));
    recordAudit(ctx.req, "governance.table.alter", { resourceType: "catalog-table", resourceId, targetId, detail: { env, statements: out.statements, modelTableId: out.modelTableId } }).catch(() => {});
    return { data: out };
  } catch (e) {
    return rethrowAsHttpError(e, MAPPERS);
  }
};

// ── 读真实列(原 app/api/governance/tables/columns GET) ──
const catalogReadColumns: LongOpExecutor<"catalog-read-columns"> = async (params) => {
  const { targetId, schema, table } = params;
  try {
    const live = await readLiveColumns(targetId, schema, table);
    const existing = await findModelTableByPhysical(schema, table);
    let adoptable = true;
    let reason = "";
    try {
      assertPlatformGlobalSchema(schema);
    } catch (e) {
      adoptable = false;
      reason = String((e as Error)?.message ?? e);
    }
    let columns: unknown[] = [];
    if (existing) {
      columns = existing.columns || [];
    } else {
      try {
        columns = live.columns.map(modelColumnFromCatalog);
      } catch (e) {
        adoptable = false;
        reason = reason || String((e as Error)?.message ?? e);
        columns = live.columns.map((c) => ({ name: c.name, dataType: c.dataType, nullable: c.nullable, comment: c.comment || undefined }));
      }
    }
    return {
      data: {
        targetId,
        schema,
        table,
        exists: live.exists,
        database: live.database,
        modelTableId: existing?.modelTableId ?? null,
        origin: existing?.origin ?? null,
        adoptable: live.exists && adoptable,
        ...(reason ? { reason } : {}),
        columns,
        live: live.columns,
      },
    };
  } catch (e) {
    return rethrowAsHttpError(e, MAPPERS);
  }
};

// ── 审批通过后执行 prod 环境的建表 / 改表(原 app/api/approvals/[id] POST 的 DDL 分支;decideApproval 已在路由完成) ──
const approvalExecuteDdl: LongOpExecutor<"approval-execute-ddl"> = async (params, ctx) => {
  const { approvalId, payload, decided } = params;
  try {
    const ddl = await executeApprovedDdl(payload, actorContextOf(ctx.identity));
    recordAudit(ctx.req, "approval.decide", {
      resourceType: "approval",
      resourceId: approvalId,
      detail: { decision: "approved", projectId: decided.projectId, type: decided.type ?? DDL_APPROVAL_TYPE },
    }).catch(() => {});
    return { data: { ...decided, ddl } };
  } catch (e) {
    return rethrowAsHttpError(e, MAPPERS);
  }
};

// ── 第二批:治理目录「同步列信息」(原 app/api/governance/sync-redshift-schema POST) ──
// 原来的治理专用 202 协议(`{ runId, state:"running" }` + 页面轮询 GET)退役:并发由对象租约 `governance:schema-sync` 挡住(第二个人点 ⇒ 409
// 「『同步列信息到数据目录』正在进行中」),超 45 秒由统一框架转 202;运行记录仍落 settings 表(GET 读「最近一次同步」不变)。
// 成功 / 失败响应与接入前逐字一致:200 `{...result, runId, state:"succeeded", startedAt, finishedAt, message}` / 500「同步失败: …」带 runId。
const governanceSchemaSync: LongOpExecutor<"governance-schema-sync"> = async (_params, ctx) => {
  const run = await runSchemaSyncRecorded({ work: schemaSyncWork, startedBy: ctx.identity.username });
  if (run.state !== "succeeded" || !run.result) {
    throw new LongOpHttpError(500, `同步失败: ${run.error || "未给出原因"}`, { detail: { runId: run.runId, stale: !!run.stale } });
  }
  return { data: { ...run.result, runId: run.runId, state: "succeeded", startedAt: run.startedAt, finishedAt: run.finishedAt, message: schemaSyncMessage(run.result) } };
};

export type GovernanceLongOpKind = "catalog-create-table" | "catalog-alter-table" | "catalog-read-columns" | "approval-execute-ddl" | "governance-schema-sync";
export const GOVERNANCE_LONG_OP_EXECUTORS: Pick<LongOpExecutorRegistry, GovernanceLongOpKind> = {
  "catalog-create-table": catalogCreateTable,
  "catalog-alter-table": catalogAlterTable,
  "catalog-read-columns": catalogReadColumns,
  "approval-execute-ddl": approvalExecuteDdl,
  "governance-schema-sync": governanceSchemaSync,
};
