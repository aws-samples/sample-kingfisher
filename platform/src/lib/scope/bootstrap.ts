// O1 —— 「顶栏这一刻该显示哪个执行范围」的**纯决策函数**(合同 SPEC v3.36 §2.6.5a / §2.6.5b)。
//
// 为什么单独抽出来:这段逻辑有 5 条分支、每条都有一个「做错了会很难查」的失败形态,
// 而它天然长在 React 组件里(useSearchParams / localStorage)—— 那就没法用本仓的 node 单测钉住。
// 抽成纯函数后,Provider 只负责「取参数、取 localStorage、取列表」和「照结果渲染」。
//
// 🔴 五条分支的取舍写在这里,别在组件里再解释一遍:
//   ① URL 带合法 scope           ⇒ URL 赢(§2.6.2 URL 是权威),顺手存进 localStorage
//   ② URL 带的 scope 文法非法     ⇒ **保留 URL 原样** + 渲染错误壳。绝不改写成 global —— 前端把 4xx
//                                  吃掉再自己切 global 是最隐蔽的一种回落(判据)
//   ③ URL 带的 target 不在可用列表 ⇒ 同 ②(精确拒因由服务端给:404/403/409),前端只负责别装没事
//   ④ URL 不带 + localStorage 有且仍可用 ⇒ **恢复它并把参数写回地址栏**(用户拍板:刷新不能丢选择)
//   ⑤ URL 不带 + localStorage 的值已不可用 ⇒ 落回「全部」+ **明确告知**。
//      这不违反「不许静默回落」:那条约束的是 URL **显式点名**的情形(②③);这里 URL 什么都没说,
//      回落到「全部」也不丢任何数据,而且有告知。

import { GLOBAL_SCOPE, parseScope, scopeTargets, serializeScope, type TargetScope } from "./scope";

/** localStorage 键:🔴 必须按项目 + 环境隔离,否则 dev 选的区会串到 prod。 */
export function scopeStorageKey(projectId: string, env: string): string {
  return `bgp-scope:${projectId}:${env}`;
}

export interface InitialScopeInput {
  /** `?scope=` 的原值(没有该参数就是 `null`) */
  urlParam: string | null;
  /** localStorage 里存的原值 */
  stored: string | null;
  /**
   * 当前**已安装好且本项目可见**的 targetId 列表(§2.6.5a)。
   * `null` = 还没拉回来 —— 此时**不做「不可用」判断**,免得冷启动闪一下错误壳。
   */
  available: string[] | null;
}

export type InitialScopeResult =
  /** URL 赢;`persist` = 要不要写进 localStorage */
  | { kind: "url"; scope: TargetScope; persist: true }
  /** URL 里的值有问题:保留原样、渲染错误壳、**不改 URL** */
  | { kind: "url-invalid"; raw: string; reason: "grammar" }
  | { kind: "url-unavailable"; scope: TargetScope; missing: string[]; reason: "unavailable" }
  /** 从 localStorage 恢复,并把参数写回地址栏 */
  | { kind: "restored"; scope: TargetScope; rewriteTo: string }
  /** 存的值已不可用:落回「全部」+ 告知 */
  | { kind: "restored-stale"; scope: TargetScope; staleRaw: string }
  /** 什么都没有:全部(= 现状,回滚点) */
  | { kind: "default"; scope: TargetScope };

export function resolveInitialScope(input: InitialScopeInput): InitialScopeResult {
  const { urlParam, stored, available } = input;

  if (urlParam !== null && urlParam !== "") {
    const parsed = parseScope(urlParam);
    if (!parsed) return { kind: "url-invalid", raw: urlParam, reason: "grammar" };
    const missing = missingTargets(parsed, available);
    if (missing.length > 0) return { kind: "url-unavailable", scope: parsed, missing, reason: "unavailable" };
    return { kind: "url", scope: parsed, persist: true };
  }

  if (stored) {
    const parsed = parseScope(stored);
    // 存坏了(手改 localStorage / 旧版本格式)也按「上次选择失效」处理,不报错烦用户
    if (!parsed || parsed.kind === "global") {
      return parsed && parsed.kind === "global"
        ? { kind: "default", scope: GLOBAL_SCOPE }
        : { kind: "restored-stale", scope: GLOBAL_SCOPE, staleRaw: stored };
    }
    if (missingTargets(parsed, available).length > 0) {
      return { kind: "restored-stale", scope: GLOBAL_SCOPE, staleRaw: stored };
    }
    return { kind: "restored", scope: parsed, rewriteTo: serializeScope(parsed) };
  }

  return { kind: "default", scope: GLOBAL_SCOPE };
}

/** scope 里点名了哪些 target 不在可用列表里。`available === null`(还没拉回来)⇒ 一律算「暂不判断」。 */
export function missingTargets(scope: TargetScope, available: string[] | null): string[] {
  if (available === null) return [];
  const set = new Set(available);
  return scopeTargets(scope).filter((t) => !set.has(t));
}

/**
 * 切项目 / 切环境后,对**当前**范围再过一次校验(§2.6.5b 最后一行)。
 * 返回 `null` = 仍然有效;否则给出应当切到的范围(以及那个失效的原值,用于告知)。
 */
export function revalidateScope(
  scope: TargetScope,
  available: string[] | null
): { scope: TargetScope; staleRaw: string } | null {
  if (missingTargets(scope, available).length === 0) return null;
  return { scope: GLOBAL_SCOPE, staleRaw: serializeScope(scope) };
}

/** 「上次选的执行环境 X 已不可用」的统一文案(告知必须具体到那个 id,否则用户不知道发生了什么)。 */
export function staleScopeNotice(staleRaw: string): string {
  return `上次选择的执行范围「${staleRaw}」当前不可用(可能已删除、尚未初始化完成,或本项目未获授权),已切回「全部」`;
}
