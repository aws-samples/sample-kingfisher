// @kf-batch 50-WP4-o1-scope
// WP-4 O1 —— 「执行范围」的**服务端**读取器 / 校验器 / 过滤器。
//
// 合同:SPEC v3.34 §2.6.2(readScope)· §2.6.3(写路由忽略 scope)· §2.6.4(scopeFilter 两类资源)
//      · §2.6.5(四种拒因,一律不回落)。文法在 `@/lib/scope/scope`(前后端共用,零依赖)。
//
// ── 三条不许破的规矩 ────────────────────────────────────────────────────────────
// ① **来源只有 URL**。没有第二个来源。🔴 尤其**不读任何请求头** —— `x-bgp-target-id` 全仓
//    一处都没有,定案是「永不引入」:`lib/auth/AuthProvider.tsx` 的全局 fetch 拦截器已经在按
//    localStorage 注入 `x-bgp-project` / `x-bgp-env`,顺手加第三个同款注入是最自然的下一步,
//    而那一步就把「浏览器上次选的区」变成了服务端依据。让这个头不存在 = A4 根治。
// ② **一律不回落**:非法 400 / 不存在 404 / 无权 403,**绝不**悄悄换成 home 或 global。
//    静默回落 home 在跨法域下就是数据出境;静默回落 global 会让用户以为在看一个区、其实在看全部。
// ③ **写路由不读 scope**(§2.6.3):执行目标只来自 body 显式字段 / 资源自己的绑定 / URL 路径资源身份。
//    scope 是**视图状态**,地址栏里的东西不该决定「在哪个区真跑」。门禁 `scope-write-guard` 钉住。

import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-response";
import {
  SCOPE_PARAM,
  parseScope,
  scopeTargets,
  serializeScope,
  type TargetScope,
} from "@/lib/scope/scope";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { bindingTargets } from "@/lib/exec-env/data-plane-target";

export type { TargetScope };

/** 拒因(SPEC §2.6.5)。`status` 与 `code` 成对固定,不许某处 400 某处 404。 */
export interface ScopeRejection {
  status: 400 | 403 | 404;
  code: "INVALID_SCOPE" | "TARGET_NOT_FOUND" | "TARGET_FORBIDDEN";
  message: string;
  detail?: Record<string, unknown>;
}

/**
 * 从 URL 读执行范围。**只认 query**。
 *
 * 返回 `null` = **文法非法**(调用方 400 `InvalidScope`);
 * 返回 `{kind:"global"}` = 参数缺省或显式 `global`(正常态)。
 * 🔴 这两者不是一回事,不许把 `null` 当 global 用。
 */
export function readScope(req: NextRequest): TargetScope | null {
  return parseScope(req.nextUrl.searchParams.get(SCOPE_PARAM));
}

function invalidScope(raw: string | null): ScopeRejection {
  return {
    status: 400,
    code: "INVALID_SCOPE",
    message:
      `执行范围 ?${SCOPE_PARAM}= 取值非法(收到 ${JSON.stringify(raw)})。` +
      `合法形态:global / <targetId> / cmp:<t1>,<t2>[,<t3>,<t4>](2–4 个,英文逗号分隔)`,
    detail: { received: raw },
  };
}

/** 校验一个 scope 里点名的每个 target:存在 + 本项目可见。**一个不合格就整体拒**(不做「能显示的先显示」)。 */
export async function validateScopeTargets(
  scope: TargetScope,
  projectId: string | null | undefined
): Promise<ScopeRejection | null> {
  const ids = scopeTargets(scope);
  if (ids.length === 0) return null; // global:没有 target 要校验
  // 🔴🔴 **必须用 `getTargetRaw`,不能用 `getTarget`**(2026-09-09 全量硬门当场撞到)。
  // `getTarget()` 内部走 `admit()` = 可服务性准入:target 只要**此刻**不可承接(在途部署锁 /
  // health 未确认 / 正在下线),它就返回 `null` ⇒ 本函数会回一句 **404「不存在或已删除」**。
  // 后果是:顶栏下拉里明明有这个区(那边判的是「装好了吗」),点进去却说它不存在 ——
  // 「下拉里有、选了却拒」的撕裂,而且**拒因还是假话**(它存在得很好,只是正在部署)。
  // ⇒ 范围校验与下拉**共用同一条判据**:装好了就能看。
  // 为什么看数据不需要它可承接:本包过滤的是**主控区 DDB 里的行**,压根不碰那个区的资源;
  // 真要打那个区的路由(下推 / 直查 / 调度)各自有 `requireReadyTarget`,该拒的地方一个没少。
  const { getTargetRaw, descriptorViolation } = await import("@/lib/exec-env/registry");
  const { accessAllows, accessDeniedReason } = await import("@/lib/exec-env/residency");
  for (const targetId of ids) {
    const t = await getTargetRaw(targetId);
    const notInstalled =
      !t ||
      descriptorViolation(t, targetId) !== null ||
      String(t.status) === "deleted" ||
      !(t.ready === true || t.observed?.phase === "ready");
    if (notInstalled) {
      return {
        status: 404,
        code: "TARGET_NOT_FOUND",
        message:
          `执行范围指向的执行环境 ${targetId} 不存在、已删除,或尚未初始化完成 —— ` +
          `请重新选择执行范围(不会自动切回主控区)`,
        detail: { targetId },
      };
    }
    if (!accessAllows(t as { access?: unknown }, projectId)) {
      return {
        status: 403,
        code: "TARGET_FORBIDDEN",
        message: accessDeniedReason({ targetId }, projectId),
        detail: { targetId },
      };
    }
  }
  return null;
}

/**
 * 读 + 校验一把梭。给**读路由**用:
 *
 *     const scope = await requireScope(req, ctx.projectId);
 *     if (scope instanceof NextResponse) return scope;
 *
 * 🔴 **写路由不许调它**(§2.6.3;`scope-write-guard` 会红)。
 */
export async function requireScope(
  req: NextRequest,
  projectId: string | null | undefined
): Promise<TargetScope | NextResponse> {
  const scope = readScope(req);
  if (!scope) return scopeErrorResponse(invalidScope(req.nextUrl.searchParams.get(SCOPE_PARAM)));
  const bad = await validateScopeTargets(scope, projectId);
  if (bad) return scopeErrorResponse(bad);
  return scope;
}

/** 拒因 → 响应。🔴 走全站 `apiError`(同一个信封 + 同一份 code 词表),不自己拼 JSON。 */
export function scopeErrorResponse(r: ScopeRejection): NextResponse {
  return apiError(r.message, r.status, { code: r.code, ...(r.detail ? { detail: r.detail } : {}) });
}

// ── §2.6.4 过滤器:🔴 两类资源两种做法,不许混 ──────────────────────────────────

/**
 * **A 类:标量章**。行上有单值属性记着「这行属于哪个 target」。
 * 🔴 属性名逐个来自各自模块的既有权威,不是我这里新起的名字。
 */
export const SCOPE_SCALAR_ATTR = {
  /** run 行(SPEC §1.2;`lib/monitor/run-records.ts` 的 `RUN_STAMP_ATTRS`) */
  run: "targetId",
  /** 成本行(WP-0 T1) */
  cost: "targetId",
  /** 数据源落点(`lib/datasource/placement-shared.ts` 的 `DATASOURCE_OWNER_TARGET_ATTR`) */
  datasource: "ownerTargetId",
  // @kf-batch 50-WP4ter-coverage —— 问数历史行(`lib/genbi/history.ts` 由 `executeGenBiAsk` 回的落点盖章;
  // 工单 SC-6)。🔴 单独一个 kind 而不是复用 `run`:属性名眼下一样,但两者的**写侧作者不同**
  // (run 是 `run-records.ts`,问数历史是 `recordGenBiHistory`),合并会让「谁盖的章」这个问题没有答案。
  genbi: "targetId",
  // @kf-batch 50-WP4ter-coverage —— 审计条目(`lib/audit.ts` 的派生规则 + 数据面显式传;工单 SC-12)
  audit: "targetId",
  // @kf-batch 50-WP4ter-coverage —— 告警事件(`lib/alerting/events.ts` 从 trigger.targetId 盖;工单 SC-10)
  alert: "targetId",
  // @kf-batch 50-WP4quater-reads —— SQL 执行历史(`app/api/redshift/history` 的 POST 从 body.targetId 盖;工单 SC-35)。
  // 🔴 同样单独一个 kind:写侧作者是那条路由自己(不是 run-records),合并 kind 就没法回答「谁盖的章」。
  sqlHistory: "targetId",
  // @kf-batch 50-WP4quater-reads —— 保存的 SQL 查询任务(工单 SC-35)。落点由 workgroup 派生后盖在行上。
  redshiftTask: "targetId",
  // @kf-batch 54-genbi-session-cards —— 问数会话卡片的**中央指针行**(写侧作者 = `lib/genbi/cards-store.ts`;
  // 章 = 这段对话取数的那个 target)。🔴 同样单独一个 kind:属性名与 run 一样,但写侧作者不同,
  // 合并 kind 就没法回答「谁盖的章」——与 `genbi` / `sqlHistory` 同一条纪律。
  genbiCard: "targetId",
} as const;

export type ScopeScalarKind = keyof typeof SCOPE_SCALAR_ATTR;

/**
 * 标量章的**归属判定(内存侧)** —— 与下面 `scopeFilter` 生成的 DDB 表达式是**同一条规则**,
 * 由 `scope-filter-parity` 单测逐行比对。
 *
 * 🔴 **缺属性 ⇒ 归 home**:存量行(T1/T2 落章之前写的)没有这个属性,若把它们判成「不属于任何区」,
 * home 视角就会比 DDB 少报 —— 而 E-150/E-151 是拿 DDB 逐行核对的,少报即 FAIL。
 * 这条与 `projectFilter` 对默认工作区的存量兜底、`bindingTargets` 的三级回落是**同一个模式**。
 */
export function scalarTargetOf(row: Record<string, unknown>, kind: ScopeScalarKind): string {
  const v = row[SCOPE_SCALAR_ATTR[kind]];
  return typeof v === "string" && v.length > 0 ? v : HOME_TARGET_ID;
}

export interface ScopeFilter {
  clause: string;
  names: Record<string, string>;
  values: Record<string, unknown>;
}

/**
 * A 类的 DDB `FilterExpression` 片段。与 `projectFilter` / `envFilter` **并列 and**,不替代它们。
 *
 * 🔴 **`global` 返回 `null`** = 不加任何 target 维过滤(= 现状,本包的回滚点)。
 * 调用方:`const sf = scopeFilter(scope, "run"); if (sf) parts.push(sf.clause);`
 *
 * 占位符统一带 `scope` 前缀,避免与调用方既有的 `#env` / `#st` / `:uid` / `:pid` 撞名。
 */
export function scopeFilter(scope: TargetScope, kind: ScopeScalarKind): ScopeFilter | null {
  const ids = scopeTargets(scope);
  if (ids.length === 0) return null;
  const attr = SCOPE_SCALAR_ATTR[kind];
  const names = { "#scopeAttr": attr };
  const values: Record<string, unknown> = {};
  let needsEmpty = false;
  const ors = ids.map((id, i) => {
    values[`:scopeT${i}`] = id;
    if (id !== HOME_TARGET_ID) return `#scopeAttr = :scopeT${i}`;
    // 🔴 点名 home 时要多捞两种行,否则 home 视角比 DDB 少报(E-150/E-151 是逐行核对的):
    //   ① **没有该属性**的存量行(T1/T2 落章之前写的);
    //   ② **属性是空串**的行 —— 这不是理论洁癖:`attribute_not_exists` 在 DDB 里**不匹配空串**
    //      (空串是"存在且为空"),而内存侧 `scalarTargetOf` 把空串判成 home。两侧若不一致,
    //      parity 单测会红;而"改测试让它绿"就等于让一条坏行在**所有**视角里消失(fail-silent)。
    //      故这里显式把空串并进来:坏行仍然可见(落在 home,管理员能发现),且两侧逐格相等。
    needsEmpty = true;
    return `(#scopeAttr = :scopeT${i} OR attribute_not_exists(#scopeAttr) OR #scopeAttr = :scopeEmpty)`;
  });
  if (needsEmpty) values[":scopeEmpty"] = "";
  return { clause: ors.length === 1 ? ors[0] : `(${ors.join(" OR ")})`, names, values };
}

/**
 * @kf-batch 50-WP4bis-p1-scope
 * B 类绑定列表的**默认字段名**。个别模块历史上叫别的名字(实测:补数计划行是 `execTargets`,
 * 见 `lib/backfill/types.ts` 的 `BACKFILL_PLAN_BINDING_ATTR`)。
 *
 * 🔴 为什么用「换个字段名读」而不是让调用方自己 `rows.map(r => ({...r, targets: r.execTargets}))`:
 * 后者会往响应体里**塞一个合同里没有的 `targets` 字段**(前端一旦读了它,字段就再也删不掉),
 * 而且回落语义就地复制了一份。这里只换字段名,三级回落仍然只有 `bindingTargets` 一个作者。
 */
export const DEFAULT_BINDING_ATTR = "targets";

/** 按给定字段名读绑定列表(回落仍走 `bindingTargets`:`<attr>` → `targetId` → home)。 */
function bindingTargetsOf(row: Record<string, unknown>, bindingAttr: string): string[] {
  const r =
    bindingAttr === DEFAULT_BINDING_ATTR
      ? (row as { targets?: unknown; targetId?: unknown })
      : { targets: row[bindingAttr], targetId: row.targetId };
  return bindingTargets(r);
}

/**
 * **B 类:绑定列表**。行上是 `targets: string[]`(离线任务 / 引擎作业 / 编排 / 同步 / 建模定义)。
 *
 * 🔴 **只许内存过滤,禁止写成 DDB 表达式**:`bindingTargets`
 * (`lib/exec-env/data-plane-target.ts`,20 处消费者 = 既成 SSOT)含**三级回落**
 * (`targets` → `targetId` 单值 → home)。把它抄成
 * `(contains(targets,:t) OR (attribute_not_exists(targets) AND :isHome))` 就是复制那套语义,
 * 抄一次就注定漂移。门禁 `scope-filter-guard` 断言全仓无 `contains(targets`。
 */
export function filterRowsByScope<T extends Record<string, unknown>>(
  rows: T[],
  scope: TargetScope,
  bindingAttr: string = DEFAULT_BINDING_ATTR
): T[] {
  const ids = scopeTargets(scope);
  if (ids.length === 0) return rows;
  const want = new Set(ids);
  return rows.filter((r) => bindingTargetsOf(r, bindingAttr).some((t) => want.has(t)));
}

/**
 * @kf-batch 50-WP4quater-reads(工单 SC-37)
 * **C 类:治理约定的「适用区」过滤** —— 与 B 类 `filterRowsByScope` 只差一点,但那一点很关键:
 *
 * 🔴 **没声明 `targets` ⇒ 对所有区可见**(不是「归主控区」)。
 * 分层 / 数据域 / 数据标准是**治理约定**,不是执行体。一条没标适用区的约定,语义上是
 * 「全平台通用」;若套 B 类那条「无章 ⇒ 主控区」的回落,存量定义会在**非主控区视角整体消失** ——
 * 用户会以为「这个区没有分层规范」,而真相是「这条规范本来就适用于所有区」。
 * 两条规则语义相反,所以刻意分成两个函数、两个名字,而不是给 `filterRowsByScope` 加个 flag
 * (加 flag 的那种写法,调用点写错一个布尔就静默换掉了语义)。
 *
 * 用户 2026-09-10 驳回了「这几块平台级定义,本身不分区(设计如此)」的说法:
 * 「**这里为什么不能做成区域维度?我认为都可以切出来的。**」⇒ 能声明适用区、能按区筛。
 */
export function filterRowsByApplicableScope<T extends Record<string, unknown>>(
  rows: T[],
  scope: TargetScope,
  attr: string = DEFAULT_BINDING_ATTR
): T[] {
  const ids = scopeTargets(scope);
  if (ids.length === 0) return rows;
  const want = new Set(ids);
  return rows.filter((r) => {
    const v = r[attr];
    const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
    if (list.length === 0) return true; // 🔴 未声明 = 全平台通用 ⇒ 任何视角都看得到
    return list.some((t) => want.has(t));
  });
}

/** B 类:按 target 统计条数。**一行绑 N 个区 ⇒ N 个 key 各计 1**(故各 key 之和 ≥ 行数)。 */
export function countRowsByBinding(
  rows: Array<Record<string, unknown>>,
  bindingAttr: string = DEFAULT_BINDING_ATTR
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    for (const t of bindingTargetsOf(r, bindingAttr)) {
      out[t] = (out[t] ?? 0) + 1;
    }
  }
  return out;
}

/**
 * @kf-batch 50-WP4ter-coverage
 * **A 类的内存过滤**(与 `scopeFilter` 的 DDB 表达式同一条规则,由 `scope-filter-parity` 覆盖)。
 *
 * 🔴 什么时候用内存版而不是下推 DDB:那张表的唯一读法是**全表 Scan 后在内存里聚合**
 * (成本 run 就是这样:`scanAllCostRuns()` + 按天窗过滤 + 按 taskId 归并)。这种路径下再拼一个
 * `FilterExpression` 等于给同一件事写第二份实现,而且**聚合的分母会与过滤前后错位** ——
 * 成本排行的「占比」会算错。故这里只提供与 `scalarTargetOf` 同一判据的内存过滤。
 */
export function filterRowsByScalar<T extends Record<string, unknown>>(
  rows: T[],
  scope: TargetScope,
  kind: ScopeScalarKind
): T[] {
  const ids = scopeTargets(scope);
  if (ids.length === 0) return rows;
  const want = new Set(ids);
  return rows.filter((r) => want.has(scalarTargetOf(r, kind)));
}

/** A 类:按 target 统计条数(一行只归一个区)。 */
export function countRowsByScalar(
  rows: Array<Record<string, unknown>>,
  kind: ScopeScalarKind
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const t = scalarTargetOf(r, kind);
    out[t] = (out[t] ?? 0) + 1;
  }
  return out;
}

/** 给日志 / 审计用的可读串(不要把整个对象塞进日志)。 */
export function describeScope(scope: TargetScope): string {
  return serializeScope(scope);
}
