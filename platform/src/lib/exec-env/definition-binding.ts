// @kf-batch 50-WP4ter-coverage
// **定义行的执行范围章** —— 唯一作者(合同 50 SPEC §2.6.4 / WORK-PACKAGES WP-4ter ②)。
//
// ── 这个文件解决什么 ──────────────────────────────────────────────────────────
// 「按执行范围过滤」要成立,行上得先有区维。同步任务 / 编排 / 实时作业 / 质量规则这四类**定义行**
// 实测一个区维都没有(WP-4ter ①)。补维本身不难,难的是**别补出一个假的维**:
//   🔴 如果章上写 `usw2` 而执行侧仍在主控区跑(同步的 start 路由是 `process.env.AWS_REGION`),
//      那就从「没有区维」升级成「**有一个骗人的区维**」—— 后者更坏:界面、审计、成本归因会
//      一致地把这条任务算到 usw2 名下,而数据其实落在主控区(跨法域下这就是数据出境)。
//
// ⇒ 本文件的规矩只有一条:**章只能从执行侧真正会用的那个落点导出**,不许调用方自己传一个区进来。
//   · 同步任务:落点 = 它那条数据源的 `ownerTargetId`(源必须可达才谈得上同步)——
//     与 `lib/datasource/placement.ts` 是**同一个真值**,不是第二份推理;
//   · 执行侧另有 `assertDefinitionRunsHere()` 反向卡:章与真正要用的落点不一致就**拒跑**。
//     两边合起来,「章」与「真跑在哪」在结构上不可能分叉 —— 要么一致,要么当场报错。
//
// 🔴 存量行(没有本字段)由 `bindingTargets` 三级回落归 home。那**不是兜底猜测**:
//    补维之前平台只有一条执行路径,所有同步/编排都在主控区跑过,归 home 是历史事实
//    (与 `resolveRunStamp` / `placementForNewDataSource` 的同一条理由)。

import { DEFAULT_BINDING_ATTR } from "@/lib/exec-env/scope";
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
import { DATASOURCE_OWNER_TARGET_ATTR } from "@/lib/datasource/placement-shared";
import { HOME_TARGET_ID, isHome } from "@/lib/exec-env/target-id";

/** 定义行上的绑定字段名(= `targets`,与 `bindingTargets` / `filterRowsByScope` 同源)。 */
export const DEFINITION_BINDING_ATTR = DEFAULT_BINDING_ATTR;

/** 盖章结果:展开进 DDB Item 即可(形如 `{ targets: ["tgt_home"] }`)。 */
export type DefinitionBinding = { [DEFINITION_BINDING_ATTR]: string[] };

/**
 * 新建**同步任务**要盖的章。
 *
 * @param datasourceRow 该任务引用的数据源行(可空 = 建任务时还没选源)
 *
 * 🔴 取 `ownerTargetId` 而不是 `getActiveTargetId()` 之类的「当前视角」:视角是看东西的角度,
 * 不是执行落点(SPEC §2.6.3「写/执行路由不读 scope」)。源在哪个区可达,任务就只能在那个区跑。
 */
export function bindingForNewSyncTask(datasourceRow?: Record<string, unknown> | null): DefinitionBinding {
  const owner = datasourceRow?.[DATASOURCE_OWNER_TARGET_ATTR];
  const targetId = typeof owner === "string" && owner.length > 0 ? owner : HOME_TARGET_ID;
  return { [DEFINITION_BINDING_ATTR]: [targetId] };
}

/** 抛这个 = 章与执行落点不一致(调用方应回 409,并把 message 原样给用户看)。 */
export class DefinitionBindingMismatch extends Error {
  readonly conflict = true;
  constructor(
    readonly kind: string,
    readonly bound: string[],
    readonly runningIn: string
  ) {
    super(
      `这条${kind}绑定在执行环境 ${bound.join(" / ")},而当前执行通道只能在 ${runningIn} 里跑 —— ` +
        `已拒绝执行,不会替它在错误的区域跑(执行下推上线前,请在它绑定的那个区操作)`
    );
    this.name = "DefinitionBindingMismatch";
  }
}

/**
 * 执行侧反向卡:**这条定义真的能在我这个落点上跑吗**。
 *
 * 用法(同步 start / 编排 publish 这类还没做逐区下推的执行入口):
 *
 *     assertDefinitionRunsHere(task, "同步任务", HOME_TARGET_ID);
 *
 * 🔴 为什么必须有它:没有它,「加区维」这一步本身就会制造出「章说 usw2、活在 home 干」的假象。
 * 有了它,下推没上线的那段时间里,平台的行为是**拒绝**而不是**跑错区** —— 这是 fail-closed。
 * 逐区下推上线后,调用方把 `runningIn` 换成真正解析出来的落点即可,本函数不用改。
 */
export function assertDefinitionRunsHere(
  row: Record<string, unknown> | null | undefined,
  kind: string,
  runningIn: string
): void {
  const bound = bindingTargets((row ?? {}) as { targets?: unknown; targetId?: unknown });
  if (bound.includes(runningIn)) return;
  // 只绑了 home 而 runningIn 也是 home 的情形已在上面返回;走到这里就是真不一致。
  throw new DefinitionBindingMismatch(kind, bound, runningIn);
}

/** 便捷:这条定义是否**只**绑在主控区(逐区下推未上线时,只有这种才允许在 home 执行)。 */
export function boundToHomeOnly(row: Record<string, unknown> | null | undefined): boolean {
  const bound = bindingTargets((row ?? {}) as { targets?: unknown; targetId?: unknown });
  return bound.length === 1 && isHome(bound[0]);
}
