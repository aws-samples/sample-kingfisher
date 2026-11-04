// @kf-batch 50-WP4-o1-scope   ← 审核用批次标签
// WP-4 O1 —— 「执行范围」(scope)的**唯一文法作者**。
//
// 合同:docs/design/50-multi-region-execution/SPEC.md §2.6.1(文法)· §2.6.2(读取器)。
// 交互:INTERACTION-DESIGN.md §9(三态 · URL 权威 · 六条护栏)· §9.6(路由能力矩阵)。
//
// ── 本文件为什么必须是纯函数、零依赖 ──────────────────────────────────────────
// 顶栏选择器(客户端)与服务端 `readScope()` **必须用同一份文法**,否则会出现
// 「前端认为合法、服务端 400」或更坏的「前端拒了、服务端却接受」。所以文法只放这一处,
// 不引任何 AWS SDK / next/server,客户端与服务端都能 import。
//
// 🔴 **targetId 的合法性不在本文件判定** —— 复用 `lib/exec-env/target-id.ts` 的
// `isValidTargetId()`(SPEC §1.1a 正则的唯一权威,该文件同样零 import)。本文件**不得**
// 自带第二份 targetId 正则:两份正则迟早各自漂移(change-safety A1)。
//
// ── 严格解析,不做「善意猜测」──────────────────────────────────────────────
// 非法输入一律返回 `null`,由调用方按 SPEC §2.6.5 处置(400 `InvalidScope`),
// **绝不回落 global、绝不回落 home**。不 trim 空白、不转小写、不接受分号/空格分隔:
// 每加一条「宽容」就等于在别处多一份归一化逻辑,而那正是漂移的来源。

import { HOME_TARGET_ID, isValidTargetId } from "@/lib/exec-env/target-id";

/** URL 参数名。🔴 全平台唯一含义 = 执行范围(SPEC §2.6.0:模型设置作用域已改名 `settingScope`)。 */
export const SCOPE_PARAM = "scope";

/** 「全部」的字面量。 */
export const SCOPE_GLOBAL = "global";

/** 对比态前缀与个数上下限(SPEC §2.6.1;护栏 6 限 2–4 个区)。 */
export const SCOPE_COMPARE_PREFIX = "cmp:";
export const SCOPE_COMPARE_MIN = 2;
export const SCOPE_COMPARE_MAX = 4;

export type ScopeKind = "global" | "target" | "compare";

/**
 * 三态。**选中值恒为 `targetId`**(不是 region、不是 slug)——
 * 同 region 可有多账号 / 多 cell,按 region 键会串身份(INTERACTION §9.2)。
 */
export type TargetScope =
  | { kind: "global" }
  | { kind: "target"; targetId: string }
  | { kind: "compare"; targetIds: string[] };

/** 缺省态 = 全部 = 现状行为(本包的回滚点)。 */
export const GLOBAL_SCOPE: TargetScope = { kind: "global" };

export function isGlobalScope(scope: TargetScope): scope is { kind: "global" } {
  return scope.kind === "global";
}

/**
 * 解析 URL 里的 `?scope=`。
 *
 * · `null` / `undefined` / `""`  ⇒ `{kind:"global"}`(**参数缺省即全部**,= 现状)
 * · `"global"`                    ⇒ `{kind:"global"}`
 * · `"tgt_xxx"`                   ⇒ `{kind:"target"}`
 * · `"cmp:t1,t2[,t3,t4]"`         ⇒ `{kind:"compare"}`(**去重保序**后须 2–4 个)
 * · 其它一切                       ⇒ **`null`(非法)**
 *
 * 🔴 返回 `null` 与返回 `{kind:"global"}` 是**两件不同的事**:前者要 400,后者是正常缺省。
 * 调用方不许把 `null` 当 global 用 —— 那就是 SPEC §2.6.5 禁止的「静默回落 global」。
 */
export function parseScope(raw: string | null | undefined): TargetScope | null {
  if (raw === null || raw === undefined || raw === "") return GLOBAL_SCOPE;
  if (raw === SCOPE_GLOBAL) return GLOBAL_SCOPE;

  if (raw.startsWith(SCOPE_COMPARE_PREFIX)) {
    const body = raw.slice(SCOPE_COMPARE_PREFIX.length);
    if (body === "") return null;
    const parts = body.split(",");
    // 逐段必须是合法 targetId(空段 / 大写 / 带空白 / `global` 都在这里被拒)
    for (const p of parts) {
      if (!isValidTargetId(p)) return null;
    }
    const unique = parts.filter((p, i) => parts.indexOf(p) === i);
    if (unique.length < SCOPE_COMPARE_MIN || unique.length > SCOPE_COMPARE_MAX) return null;
    return { kind: "compare", targetIds: unique };
  }

  if (isValidTargetId(raw)) return { kind: "target", targetId: raw };
  return null;
}

/**
 * 序列化回 URL 值。`parseScope(serializeScope(s))` 恒等于 `s`(**规范形式**);
 * 反向不保证逐字节相同(`cmp:a,a,b` 会被规范化成 `cmp:a,b`)。
 */
export function serializeScope(scope: TargetScope): string {
  switch (scope.kind) {
    case "global":
      return SCOPE_GLOBAL;
    case "target":
      return scope.targetId;
    case "compare":
      return SCOPE_COMPARE_PREFIX + scope.targetIds.join(",");
  }
}

/**
 * 写进 URL 的值;**global 返回 `null` = 不带该参数**。
 *
 * 🔴 这条是回滚点:不带参数的 URL 与本包上线前**逐字节相同**(判据 E-158),
 * 所以「全部」视角下不许往地址栏塞 `?scope=global`。
 */
export function toScopeParam(scope: TargetScope): string | null {
  return isGlobalScope(scope) ? null : serializeScope(scope);
}

/** 该 scope 点名的 target 列表;`global` 是**空数组**(= 不加 target 维过滤,不是「所有 target」)。 */
export function scopeTargets(scope: TargetScope): string[] {
  switch (scope.kind) {
    case "global":
      return [];
    case "target":
      return [scope.targetId];
    case "compare":
      return [...scope.targetIds];
  }
}

// @kf-batch 50-WP31-place-first-class
/**
 * 在这个视角下**新建 / 取区域资源**的落点 —— 唯一作者(原来各页各写一遍 `scope.kind === "target" ? … : undefined`,
 * 再交给后端「缺省 = 主控区」)。规则(INTERACTION §9:顶栏视角决定新建默认落点):
 * 单区视角 = 那个区;分组 / 全部 = 主控区 —— **显式**给出,后端不再有缺省。
 */
export function landingOfScope(scope: TargetScope): string {
  return scope.kind === "target" ? scope.targetId : HOME_TARGET_ID;
}

/** 某个 target 是否落在该 scope 内。`global` 恒 `true`(它不过滤)。 */
export function scopeIncludesTarget(scope: TargetScope, targetId: string): boolean {
  if (isGlobalScope(scope)) return true;
  return scopeTargets(scope).includes(targetId);
}

/** 两个 scope 是否等价(compare 的顺序不同 ⇒ **不等价**,顺序即 sheet/列序)。 */
export function isSameScope(a: TargetScope, b: TargetScope): boolean {
  return serializeScope(a) === serializeScope(b);
}
