// 建模产物「解绑 / 解绑并清理」的**服务端编排**(50 SPEC v3.20 §3.8)—— 唯一作者。
//
// 🔴🔴 顺序即语义:**先 DROP、观测为空、再去记录**。
//   反过来(先去记录再 DROP)一旦 DROP 失败,那个区就多了一张平台不再知道的表 = 真孤儿,
//   而「残留」这个态存在的全部意义就是**不让那种表被藏起来**。
//   所以 `save` 只在 `unlandFromTarget` 成功返回之后才会被调用;DROP 抛错 ⇒ 这里直接抛,一个字节都不写。
import type { LandedRecord } from "./landing-shared";
import { planUnbind, type UnbindPlan } from "./unbind-shared";
import { unlandFromTarget } from "./landing";
import type { AuthenticatedActor } from "@/lib/exec-env/admin-ddl-executor";
import type { ModelingObjectKind } from "@/lib/exec-env/admin-ddl-request";

export interface PerformUnbindArgs<TRow> {
  /** 当前绑定(**已归一**,缺省 home 已补) */
  boundTargets: readonly string[];
  landedByTarget: Record<string, LandedRecord | undefined> | null | undefined;
  targetId: string;
  cleanup: boolean;
  confirm?: string | null;
  schema: string;
  table: string;
  // 原 `projectId?` 已删(建模没有项目维,所有调用点都是 undefined);
  //   非主控区的 DROP 走 admin 模板 `drop-landed-table`,它只收台账 id + 具名操作者。
  kind: ModelingObjectKind;
  objectId: string;
  actor: AuthenticatedActor | null;
  /** 把新的逐 target 真值写回资源行。🔴 只会在 DROP(如需要)成功之后被调用一次。 */
  save: (patch: { targets: string[]; landedByTarget: Record<string, LandedRecord> }, dropped: boolean) => Promise<TRow>;
}

export interface UnbindOutcome<TRow> {
  row: TRow;
  /** 这次是否真的 DROP 了一张表(只解绑 / 无记录 / credential-gap 都是 false) */
  dropped: boolean;
  table: string;
  plan: UnbindPlan;
}

export async function performUnbind<TRow>(args: PerformUnbindArgs<TRow>): Promise<UnbindOutcome<TRow>> {
  const qualified = `${args.schema}.${args.table}`;
  const plan = planUnbind({
    boundTargets: args.boundTargets,
    landedByTarget: args.landedByTarget,
    targetId: args.targetId,
    cleanup: args.cleanup,
    confirm: args.confirm,
    table: qualified,
  });
  let dropped = false;
  if (plan.needsDrop) {
    const r = await unlandFromTarget(args.targetId, {
      schema: args.schema,
      table: args.table,
      kind: args.kind,
      objectId: args.objectId,
      actor: args.actor,
    });
    dropped = r.dropped;
  }
  const row = await args.save({ targets: plan.targets, landedByTarget: plan.landedByTarget }, dropped);
  return { row, dropped, table: qualified, plan };
}
