/**
 * 「这个分析看板 / 这张报表**取了哪些区的数**」—— 从视觉对象的落点**派生**,不另存一份。
 *
 * 用户 2026-09-10 原话:「**这个我没看懂,到底是做了分区过滤还是没做?我觉得可以增加一个过滤能力,
 * 默认不过滤。**」上一版的回答(「取数落点已到视觉对象级」)答的不是他问的问题 ——
 * 他问的是**列表能不能按区筛**。定案:
 *   · 列表**默认不过滤**(顶栏切区不该悄悄藏掉别区的报表 —— 那才是「丢东西」);
 *   · 但要能**主动筛**,而且每行要显示它涉及哪些区。
 *
 * 🔴 为什么派生而不是在定义行上另存一个 `targets[]`:落点的真值在 widget 上(SPEC §8.3
 * 明确是 widget 级 —— 一张仪表盘可以并排放两个区的图)。另存一份就有两个真值源,
 * 改了 widget 的落点而没同步那份冗余字段,列表就会按**过时的区**筛 —— 而且完全无声。
 *
 * 🔴 没有落点的 widget 归主控区(与平台其它「无章 ⇒ 主控区」一致):它就是在主控区取的数。
 */
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import type { BiWidget } from "./types";

/** 一个 widget 的取数落点(无章 ⇒ 主控区)。 */
export function widgetTarget(w: { source?: { targetId?: unknown } } | null | undefined): string {
  const t = (w?.source as { targetId?: unknown } | undefined)?.targetId;
  return typeof t === "string" && t.length > 0 ? t : HOME_TARGET_ID;
}

/** 分析看板涉及的区(去重升序)。空看板 ⇒ 空数组(它还没取任何区的数,不硬塞主控区)。 */
export function analysisRegions(a: { widgets?: unknown }): string[] {
  const ws = Array.isArray(a?.widgets) ? (a.widgets as BiWidget[]) : [];
  if (ws.length === 0) return [];
  return Array.from(new Set(ws.map((w) => widgetTarget(w as unknown as { source?: { targetId?: unknown } })))).sort();
}

/**
 * 单张报表涉及的区(它只有一个 source ⇒ 恒一个元素)。
 * 🔴 `source` 是判别联合,其中 `dataapi` 变体**没有 targetId**(它走数据 API,不直连数仓)——
 * 那种报表归主控区(API 网关在主控区),由 `widgetTarget` 的统一回落给出,这里不另写分支。
 */
export function reportRegions(r: { source?: unknown }): string[] {
  return [widgetTarget(r as { source?: { targetId?: unknown } })];
}

/**
 * **可选**的按区过滤。🔴 `enabled=false`(缺省)⇒ 原样返回 —— 这是用户明确要的「默认不过滤」。
 * 🔴 涉及区为空的行(空看板)在过滤开启时**保留**:它没取任何区的数,藏掉它等于让用户
 * 「新建的空看板一切区都看不见」。
 */
export function filterDefinitionsByRegions<T>(
  rows: T[],
  regionsOf: (row: T) => string[],
  wanted: readonly string[],
  enabled: boolean
): T[] {
  if (!enabled || wanted.length === 0) return rows;
  const want = new Set(wanted);
  return rows.filter((r) => {
    const list = regionsOf(r);
    return list.length === 0 || list.some((t) => want.has(t));
  });
}
