// @kf-batch 50-WP4quater-reads(工单 SC-24)
/**
 * 「当前执行范围对应哪些 **AWS region 字面量**」—— 成本按区筛的唯一换算处。
 *
 * 🔴 为什么需要这一层:成本行上是 **CE 的 REGION 原文**(`us-west-2`),而执行范围里是
 * **targetId**(`tgt_usw2_a`)。两者之间必须有一次显式换算;不换算就只能拿 targetId 去比
 * region 字符串,那永远匹配不上 ⇒ 单区视角的成本恒为 0,而「0」在成本页上看起来像
 * 「这个区没花钱」而不是「我们比错了」。
 *
 * 🔴 一个 region 可能对应**多个 target**(同一区两套环境):所以是 targets → region **集合**,
 * 且反向不唯一 —— 这也是为什么成本只能算到 region 粒度、算不到 target 粒度。
 * 这件事如实登记在 WORK-PACKAGES SC-24:CE 的维度里没有「执行环境」这个概念。
 *
 * @kf-batch 50-WP6-cost-by-region —— 新增 `regionOfTargets`(target → region 的**逐个**映射,O3b 对账要用)
 * 与 `allInstalledTargetIds`(原在 advice 路由里的私有副本,搬到这里成为唯一作者)。
 * `listActiveTargetsForScope` 改为由 `regionOfTargets` 派生 —— 两者不许各写一遍解析规则。
 */
import { homeRegion as readHomeRegion } from "@/lib/place/home-region";
import { getTargetRaw } from "@/lib/exec-env/registry";
import { HOME_TARGET_ID, isHome } from "@/lib/exec-env/target-id";
import { isGlobalScope, scopeTargets, type TargetScope } from "@/lib/scope/scope";

function homeRegion(): string {
  return readHomeRegion();
}

/**
 * targetId → region。🔴 解析不到的 target **不出现在结果里**(不回落主控区):
 * 回落会把那个 target 的成本算成主控区的,而且看起来完全正常。调用方据「缺席」如实报「解析不出」。
 */
export async function regionOfTargets(targetIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const tid of Array.from(new Set(targetIds))) {
    if (isHome(tid)) {
      out.set(tid, homeRegion());
      continue;
    }
    const t = await getTargetRaw(tid).catch(() => null);
    const region = (t as { region?: unknown } | null)?.region;
    if (typeof region === "string" && region) out.set(tid, region);
  }
  return out;
}

export async function listActiveTargetsForScope(targetIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>((await regionOfTargets(targetIds)).values());
  // 空集合(全都解析不到)⇒ 返回空 ⇒ 上层筛出 0 行,并由 `unattributedNote` 把原因说清
  if (out.size === 0 && targetIds.includes(HOME_TARGET_ID)) out.add(homeRegion());
  return out;
}

/**
 * 全部已装执行环境的 targetId(全局视角下要覆盖全平台,不能只看主控区)。
 * 🔴 用 `listTargetsRaw`(不过「能不能承接」那道门):装出来的每个区都要算,
 *    包括暂时不可服务的 —— 一个坏掉的区里空转的实例照样在计费(记忆
 *    `scope-view-vs-serviceable-lesson`:呈现面别用「能不能跑」当判据)。
 * @kf-batch 50-WP6-cost-by-region —— 🔴 读不到注册表就**抛**(调用方 500),不再「读不到 ⇒ 只当有主控区」:
 *    那是「静默合法默认值」—— 页面会说「全平台无优化建议」,而实际上是别的区一个都没探。
 */
export async function allInstalledTargetIds(): Promise<string[]> {
  const { listTargetsRaw } = await import("@/lib/exec-env/registry");
  const rows = await listTargetsRaw();
  return rows.map((t: { targetId: string }) => t.targetId);
}

/**
 * @kf-batch 50-WP6-cost-by-region —— 「这个视角看哪些区的钱」的**唯一**入口;`null` = 全部视角(不按区筛)。
 *
 * 🔴 为什么必须有这一处(本包勘定时发现的现行缺陷,一并根治):overview / budgets / advice 原来各写一遍
 *    `scope ? await listActiveTargetsForScope(scopeTargets(scope)) : null`。而 `readScope` 对**缺省参数**
 *    回的是 `{kind:"global"}`(真值)而不是 null ⇒ 走进第一支 ⇒ `scopeTargets(global)` 是空数组 ⇒
 *    区集合为空 ⇒ **全部视角的大盘恒为 0、区预算全被筛掉、优化建议一个区都不探**。
 *    非法参数(null)反倒走进「不筛」那一支 —— 两个方向都错,且都没有报错。
 * 正解:全部视角显式返回 null;非法参数由调用方先用 `requireScope` 拒掉(400),走不到这里。
 */
export async function regionsInViewOf(scope: TargetScope): Promise<Set<string> | null> {
  if (isGlobalScope(scope)) return null;
  return listActiveTargetsForScope(scopeTargets(scope));
}
