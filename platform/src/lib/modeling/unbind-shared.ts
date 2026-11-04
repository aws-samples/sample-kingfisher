// 建模产物「解绑 / 清理 / 删定义受控」的**纯函数部分**(50 SPEC v3.20 §3.8;INTERACTION v2.16 §4ter)—— 唯一作者。
//
// 🔴 为什么单独一个客户端可用的文件:落地面板与删除弹窗都要列「哪些区还有物理表」、判「确认串对不对」,
//    而 `unbind.ts` 依赖 AWS SDK。判据两边各写一份 = 界面说「可以删」而服务端 409(或反过来)。
//
// 三条纪律(施工包 ④):
//   ① 「只解绑」保留落地记录 ⇒ 矩阵 / 面板照实画「残留」(那个区的物理表还在,**绝不隐藏**);
//   ② 「解绑并清理」= 先 DROP、观测为空、**再**去记录(顺序在 `unbind.ts`;这里只算计划);
//      DROP 有损 ⇒ 确认串必须逐字等于物理表名(机制 A,与强制重建同一条纪律);
//   ③ `credential-gap` 记录从未执行过任何语句 ⇒ 清理 = 只删记录、不连库(连不上,也没有表)。
import type { LandedRecord } from "./landing-shared";

/** 一个仍留在某区的落地产物(给 DELETE 409 与删除弹窗列清单用)。 */
export interface LandedArtifact {
  targetId: string;
  table: string;
  status: LandedRecord["status"];
  at?: string;
}

export type UnbindRejectReason = "invalid-target" | "confirm-mismatch" | "nothing-to-unbind";

export class UnbindRejected extends Error {
  constructor(
    readonly reason: UnbindRejectReason,
    message: string
  ) {
    super(message);
    this.name = "UnbindRejected";
  }
}

/** DELETE 定义时仍有落地产物 ⇒ 平台不代劳,把清单交给用户决定(409 DECISION_REQUIRED)。 */
export class DeleteDecisionRequired extends Error {
  constructor(readonly artifacts: LandedArtifact[]) {
    super(
      `该定义仍有 ${artifacts.length} 个区留着落地产物(${artifacts.map((a) => `${a.targetId}:${a.table}`).join(", ")})` +
        ` —— 先到落地面板逐区〔解绑并清理〕,或带 keepTables=1 并输入确认串显式保留物理表、只删定义`
    );
    this.name = "DeleteDecisionRequired";
  }
}

/**
 * 仍留在各区的落地产物清单。
 * 🔴 `credential-gap` 不算产物(那条记录从未执行过语句,库里没有表);其余状态(ok/stale/drift/failed)
 *    一律算 —— `failed` 也可能是「建了表、灌数失败」,宁可让用户多看一眼。
 */
export function landedArtifacts(row: { landedByTarget?: Record<string, LandedRecord | undefined> | null }): LandedArtifact[] {
  const by = row.landedByTarget || {};
  return Object.entries(by)
    .filter((e): e is [string, LandedRecord] => Boolean(e[1]) && e[1]!.status !== "credential-gap")
    .map(([targetId, r]) => ({ targetId, table: r.table, status: r.status, ...(r.at ? { at: r.at } : {}) }))
    .sort((a, b) => (a.targetId === "tgt_home" ? -1 : b.targetId === "tgt_home" ? 1 : a.targetId.localeCompare(b.targetId)));
}

export interface UnbindPlanInput {
  /** 当前绑定(**已归一**:调用方先过 `bindingTargets`,缺省 home 已补上) */
  boundTargets: readonly string[];
  landedByTarget: Record<string, LandedRecord | undefined> | null | undefined;
  targetId: string;
  cleanup: boolean;
  confirm?: string | null;
  /** 物理落点 `schema.table`(确认串要逐字等于它) */
  table: string;
}

export interface UnbindPlan {
  /** 新绑定;可能为空 ⇒ 按 §1.3a S1 缺省语义回到 home(界面须写明) */
  targets: string[];
  /** 新落地记录(只解绑 = 原样;清理 = 去掉该区) */
  landedByTarget: Record<string, LandedRecord>;
  /** 要不要真去连库 DROP */
  needsDrop: boolean;
  skipDropReason?: "no-record" | "credential-gap";
  lastTargetRemoved: boolean;
  table: string;
}

export function planUnbind(input: UnbindPlanInput): UnbindPlan {
  const targetId = String(input.targetId || "").trim();
  if (!targetId) throw new UnbindRejected("invalid-target", "缺少 targetId");
  const by: Record<string, LandedRecord> = {};
  for (const [k, v] of Object.entries(input.landedByTarget || {})) if (v) by[k] = v;
  const rec = by[targetId];
  const bound = input.boundTargets.includes(targetId);
  if (!rec && !bound) {
    throw new UnbindRejected("nothing-to-unbind", `执行目标 ${targetId} 既未绑定、也没有落地记录 —— 没有可解绑的东西`);
  }
  const targets = input.boundTargets.filter((t) => t !== targetId);
  const lastTargetRemoved = bound && targets.length === 0;
  if (!input.cleanup) {
    // 只解绑:记录**原样保留** ⇒ 残留可见
    return { targets, landedByTarget: by, needsDrop: false, lastTargetRemoved, table: input.table };
  }
  if (String(input.confirm ?? "") !== input.table) {
    throw new UnbindRejected(
      "confirm-mismatch",
      `解绑并清理会 DROP 该区的 ${input.table}(有损)⇒ 确认串必须逐字等于物理表名 ${input.table}`
    );
  }
  const rest = { ...by };
  delete rest[targetId];
  if (!rec) return { targets, landedByTarget: rest, needsDrop: false, skipDropReason: "no-record", lastTargetRemoved, table: input.table };
  if (rec.status === "credential-gap") {
    return { targets, landedByTarget: rest, needsDrop: false, skipDropReason: "credential-gap", lastTargetRemoved, table: input.table };
  }
  return { targets, landedByTarget: rest, needsDrop: true, lastTargetRemoved, table: input.table };
}

/**
 * DELETE 定义前的受控判定。
 * @returns 被**刻意保留**的产物清单(空 = 没有产物,直接删)。
 * @throws DeleteDecisionRequired 有产物且未带 keepTables;UnbindRejected 带了 keepTables 但确认串不对
 */
export function assertDeletable(
  row: { landedByTarget?: Record<string, LandedRecord | undefined> | null },
  opts: { keepTables?: boolean; confirm?: string | null; expectedConfirm: string }
): LandedArtifact[] {
  const artifacts = landedArtifacts(row);
  if (artifacts.length === 0) return [];
  if (!opts.keepTables) throw new DeleteDecisionRequired(artifacts);
  if (String(opts.confirm ?? "") !== opts.expectedConfirm) {
    throw new UnbindRejected(
      "confirm-mismatch",
      `保留物理表、只删定义 ⇒ 确认串必须逐字等于 ${opts.expectedConfirm}(审计会逐表登记「刻意保留」)`
    );
  }
  return artifacts;
}
