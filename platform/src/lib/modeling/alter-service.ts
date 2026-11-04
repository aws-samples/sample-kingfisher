// 图形化改表的**编排作者**(计划 → 确认 → 审计 → 执行 → 回写台账 → 再观测)。
//
// 两条执行路:home = 现网绑定(admin secret)直接跑 `lib/modeling/alter.ts` 生成的语句(与建表 `landOne` 同一条 `execOnBinding`);
// 非主控区 = 先把计划写进台账行 `pendingAlter`,再调 admin 受控执行器 `alter-model-table`(模板从台账读计划,语句同一个作者),
// 执行完清掉计划。两边语句逐字节同源。
//
// 🔴 不可逆:计划含 DROP COLUMN 时必须带 `confirmName === 物理表名`(PRINCIPLES §D-裁决「重档」),否则 409 DECISION_REQUIRED。
// 🔴 拒绝项(改类型 / 改可空 / 改主键 …)一条都有就整单拒(400),不做「能做的先做」—— 用户看到的是半张表改了半张没改。
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { isHome } from "@/lib/exec-env/target-id";
import type { AuthenticatedActor } from "@/lib/exec-env/admin-ddl-executor";
import type { ResidencyActor } from "@/lib/exec-env/residency-audit";
import { getModelTable, updateModelTable, applyModelTableById } from "./dimensions";
import { planAlter, buildAlterTableStatements, isEmptyAlterPlan, type AlterAddColumn, type AlterPlan, type AlterRejection } from "./alter";
import type { ModelTable } from "./types";
import type { LandedRecord } from "./landing-shared";

const MODELTABLE_PK = "modeltable";

export class AlterRejected extends Error {
  constructor(public readonly rejected: AlterRejection[]) {
    super(`有 ${rejected.length} 项变更 Redshift 做不到:` + rejected.map((r) => `${r.column}:${r.reason}`).join(";"));
    this.name = "AlterRejected";
  }
}
export class AlterDecisionRequired extends Error {
  constructor(public readonly physicalTable: string, public readonly dropColumns: string[]) {
    super(`计划会删除列 ${dropColumns.join(", ")}(不可逆)⇒ 需在确认框输入物理表名「${physicalTable}」才执行`);
    this.name = "AlterDecisionRequired";
  }
}
export class AlterNothingToDo extends Error {
  constructor() {
    super("列定义与现状一致,没有任何变更可执行");
    this.name = "AlterNothingToDo";
  }
}

export interface AlterOutcome {
  modelTableId: string;
  plan: AlterPlan;
  statements: string[];
  executed: boolean;
  /** 执行后再观测的那一格(dryRun 时无) */
  landed?: LandedRecord;
  table: ModelTable;
}

async function setPendingAlter(modelTableId: string, plan: AlterPlan | null): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.MODEL_TABLES,
      Key: { pk: MODELTABLE_PK, modelTableId },
      ...(plan
        ? { UpdateExpression: "SET pendingAlter = :p, updatedAt = :u", ExpressionAttributeValues: { ":p": plan, ":u": new Date().toISOString() } }
        : { UpdateExpression: "REMOVE pendingAlter SET updatedAt = :u", ExpressionAttributeValues: { ":u": new Date().toISOString() } }),
    })
  );
}

/**
 * 对台账里的一张模型表做无损结构变更。
 * @param desired 想要的**完整**列清单(不在清单里的现有列 = 要删)
 */
export async function alterModelTable(
  modelTableId: string,
  desired: readonly AlterAddColumn[],
  opts: {
    targetId: string;
    confirmName?: string;
    dryRun?: boolean;
    /** 非主控区必填(admin 受控通道要具名操作者);home 可为 null */
    actor: AuthenticatedActor | null;
    residencyActor?: ResidencyActor;
    /** 血缘归属 / 台账 createdBy 用的用户名 */
    username?: string;
  }
): Promise<AlterOutcome> {
  const t = await getModelTable(modelTableId);
  if (!t) throw new Error("模型表不存在");
  const { plan, rejected } = planAlter(t.columns || [], desired);
  if (rejected.length) throw new AlterRejected(rejected);
  if (isEmptyAlterPlan(plan)) throw new AlterNothingToDo();
  const statements = buildAlterTableStatements({ schema: t.schema, physicalTable: t.physicalTable, plan });
  if (plan.dropColumns.length && String(opts.confirmName || "") !== t.physicalTable) {
    throw new AlterDecisionRequired(t.physicalTable, plan.dropColumns);
  }
  if (opts.dryRun) return { modelTableId, plan, statements, executed: false, table: t };

  // 落地之前写区域审计(与建表同一个 entry;sqlText 让审计里看得见要跑什么)
  const { residencyAudit, auditActorOrService } = await import("@/lib/exec-env/residency-audit");
  await residencyAudit({ ...auditActorOrService(opts.residencyActor), targetId: opts.targetId, entry: "modeling-land", sqlText: statements.join(";\n") });

  if (isHome(opts.targetId)) {
    const { resolveRedshiftBinding } = await import("@/lib/exec-env/data-plane-target");
    const { execOnBinding } = await import("./landing");
    const b = await resolveRedshiftBinding({ targetId: opts.targetId });
    await execOnBinding(b, statements);
  } else {
    if (!opts.actor) throw new Error("非主控区的图形化改表要经 admin 受控通道,必须带具名操作者(调用方未传 actor)⇒ 一条语句都没执行");
    const { executeAdminDdl } = await import("@/lib/exec-env/admin-ddl-executor");
    await setPendingAlter(modelTableId, plan);
    try {
      await executeAdminDdl(opts.actor, { operation: "alter-model-table", targetId: opts.targetId, modelTableId });
    } finally {
      await setPendingAlter(modelTableId, null).catch(() => {});
    }
  }

  // 台账列 = 想要的列(剥掉 defaultValue 这类只在 ALTER 里用的字段由 validateModelTable 完成);再观测该 target 回写 landedByTarget
  const stripped = desired.map(({ defaultValue: _d, ...c }) => c);
  await updateModelTable(modelTableId, { columns: stripped }, opts.username);
  const after = await applyModelTableById(modelTableId, opts.username, { targets: [opts.targetId], probeOnly: true, actor: opts.actor });
  return { modelTableId, plan, statements, executed: true, landed: after.landedByTarget?.[opts.targetId], table: after };
}
