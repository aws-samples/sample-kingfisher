// **轻量**的 target 位置解析层 —— 只回答「这个 target 在哪个 region」+ 绑定被拒的错误类型。
//
// ── 🔴 为什么必须单独一个文件(被真部署咬出来的)────────────────────────────
// W3-e 把元数据镜像挂到周期 reconciler 上之后,`npm run build` **直接失败**:
//   `Module not found: Can't resolve 'crypto'`
//   import trace: instrumentation → reconciler-loop → metadata-mirror → data-plane-target
//                 → privileged-cred → project-schema(它要 `createHash`)
// 根因:`instrumentation.ts` 会被 Next **同时**编进 nodejs 与 **edge** 两个 bundle。
// edge 那个编译**没有 node 内置模块**,而 `project-schema` 需要 `crypto` ⇒ 编译期就炸。
// 🔴 **`await import()` 救不了**:动态 import 只是拆 chunk,webpack **照样要 build 那个模块**
//    (`instrumentation.ts` 里那句"动态 import 避免拉进 edge bundle"的注释是**运行期**成立、
//     **编译期不成立** —— 这正是它没挡住这次的原因)。
// 🔴 也不是"把 `node:crypto` 写成 `crypto`"能解决的:两种写法在 edge 编译里都解析不了
//    (我先试了这条,错误只是从 `UnhandledSchemeError` 变成 `Module not found`)。
// ⇒ 唯一稳的办法是**切断可达性**:周期任务这一侧只依赖本文件,
//   而本文件**只 import `target-id` 与 `registry`**(两者早就在这条图里、且不碰 node 内置)。
//
// `data-plane-target.ts` 把这两个出口**re-export** 出去 ⇒ 既有调用方一个字都不用改,
// 而且 `TargetBindingRejected` 仍是**同一个类对象**,现有的 `instanceof` 判据继续成立。

import { homeRegion as readHomeRegion } from "@/lib/place/home-region";
import { HOME_TARGET_ID, isHome, isValidTargetId } from "@/lib/exec-env/target-id";
// 区解析的唯一作者**顺手记落点决策**(观测器据此归因;
//   context.ts 已在 instrumentation 可达面上 —— observer.ts 早就 import 它,不新增 edge 编译风险)
import { notePlaceDecision } from "@/lib/place/context";

/** 决策记账里的作者名(观测清单按它归类;判据按它过滤)。 */
export const REGION_OF_TARGET_VIA = "regionOfTarget";

/**
 * 绑定被拒 —— 全是**用户可修**的原因(目标没装组件 / 落点冲突 / 缺凭证 / 非法 id)。
 * 路由据此回 4xx 而不是 500(混进 500 会把人引去查平台故障,而正确处置是换目标或清字段)。
 */
export class TargetBindingRejected extends Error {
  constructor(
    readonly reason:
      | "invalid-target"
      | "missing-component"
      | "warehouse-conflict"
      | "no-credential"
      // 项目白名单(SPEC §3.12 v3.22,通用)—— 用户可修(让管理员加白名单),不是 500
      | "project-not-allowed",
    message: string
  ) {
    super(message);
    this.name = "TargetBindingRejected";
  }
}

/**
 * **只解析 region**(给「按 statementId 所在 region 取结果 / 取消」与元数据镜像用)。
 *
 * 🔴 **为什么单独开这个口、而且允许缓存**:
 * · Redshift Data API 的 `statementId` 是 **region 内**的 —— 拿 home 的客户端去 Describe
 *   us-west-2 的 statement 会一直查不到,前端就永远停在「执行中」(W3-a 已被这条咬过一次)。
 * · SPEC §3.1 禁的是「**准入判定**不许缓存」(draining 后 60s 内仍放行 = 安全判定被绕过)。
 *   这里**不做任何准入判定**:能不能取这份结果由 `requireQueryHandle` 判、能不能提交由
 *   `requireProject` + `resolveRedshiftBinding` 判。本函数只回答「这个 target 在哪个 region」。
 * · region 是 target 的**不可变身份属性**(targetId 一经创建不可改、不可复用)。
 * · 🔴 **最坏情况的爆炸半径**:缓存给出过期 region ⇒ Describe 查不到 ⇒ 前端显示失败。
 *   **绝不会**造成"打到错误的 region 执行" —— 执行 region 在提交那一刻就定死了。
 */
const REGION_CACHE_TTL_MS = 60_000;
const _regionCache = new Map<string, { region: string; at: number }>();

export function __resetRegionCache(): void {
  _regionCache.clear();
}

export async function regionOfTarget(targetId: string): Promise<string> {
  const homeRegion = readHomeRegion();
  // 第四十轮 observe 的「未归因在途调用榜」里,同步任务的日志 / Glue 状态 / 输出、数仓工作组清单、
  //   统一结果 / 取消 … 全是「经本函数拿到了正确的区、客户端也建对了,却没有一笔决策」⇒ 观测器判不了。
  //   区解析就是落点决策 ⇒ 在这里记(第一个 await 之前;请求外无账本则 no-op)。
  //   🔴 `targetId` 为空 ⇒ 如实记 `null`:那是「调用方没传、按老规矩回主控区」(原形),观测器在非主控区视角下
  //   会据此报 implicit-home-under-target-view —— 这正是下一批要收的静默默认值,不许在这里替它洗白成 tgt_home。
  if (!targetId || isHome(targetId)) {
    notePlaceDecision({ targetId: targetId || null, via: REGION_OF_TARGET_VIA });
    return homeRegion;
  }
  if (!isValidTargetId(targetId)) {
    throw new TargetBindingRejected("invalid-target", `非法 targetId:${JSON.stringify(targetId)}`);
  }
  notePlaceDecision({ targetId, via: REGION_OF_TARGET_VIA });
  const hit = _regionCache.get(targetId);
  if (hit && Date.now() - hit.at < REGION_CACHE_TTL_MS) return hit.region;
  const { getTargetRaw } = await import("@/lib/exec-env/registry");
  const t = await getTargetRaw(targetId);
  const region = String(t?.region || "").trim();
  if (!region) {
    // 🔴 **不回落 home**:回落等于"拿 home 的客户端去查另一个区的 statement",
    // 症状是永远查不到 + 前端卡在「执行中」,离根因极远。宁可当场说清。
    throw new TargetBindingRejected("invalid-target", `执行目标 ${targetId} 不存在或没有 region 属性`);
  }
  _regionCache.set(targetId, { region, at: Date.now() });
  return region;
}

export { HOME_TARGET_ID };
