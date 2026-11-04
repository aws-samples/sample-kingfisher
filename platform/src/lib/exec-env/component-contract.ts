// 探活项 ↔ 组件 的归属契约(SSOT)+「本次 green probe 是否**精确**覆盖了目标组件集」的纯判定。
//
// 【为什么单独一个低层文件】lifecycle.ts(`validateExactGreenLifecycleEvidence`)与
//   registry.ts(`reconcileAfterProbe`)都要判「本次全绿探活是否**精确**覆盖目标组件集」——
//   防 partial-green:只探了 core 全绿,却拿去把声称含 redshift 的目标晋级成 ready。
//   这是纯函数知识:塞进 lifecycle 会与 registry 形成运行时环(registry→lifecycle→此文件→registry),
//   抄两份又会漂移。⇒ 独立低层文件,**不 import registry/lifecycle 的值**(零依赖,无环)。
//
// 🔴 item 命名是 `probe-runner.ts` runProbe() 的产物(**green 态**):core 六项名无冒号;
//    非 core 组件项形如 `<comp>:<子项>`(redshift:workgroup / dms:subnet-group / agentcore:runtime …)。
//    改 probe-runner 的 item 命名必须同步此处(有单测 component-contract.test.ts 钉住两侧一致)。

/** green 态 core 探活项名(逐项与 probe-runner.ts 的 core 分支一致)。 */
const CORE_PROBE_ITEMS: ReadonlySet<string> = new Set([
  "core",
  "datalakeBucket",
  "scriptsBucket",
  "tableBucket",
  "athenaWorkgroup",
  "emrSecurityGroupId",
  "glueRoleArn",
  // EMR 执行角色(core 键,描述符有才出项)
  "emrExecutionRoleArn",
  // 零出网两项属于**底座**(base 栈),归 core。
  // 🔴 必须登记在这里:`probeItemComponent` 认不出的项会让 `isExactGreenCoverage` fail-closed
  //    ⇒ target 永远进不了 ready(整块功能被自己的覆盖判定挡死)。
  // 🔴 出项条件(probe-runner 的灰度门):**非 home ∧ 已切到零出网底座**(资源袋有 endpointIds)。
  //    还没切的存量 target **不出这两项** —— 否则平台一上线就把所有好环境判成降级;
  //    「漏切」由 net0 段 N0-1 逐 target 扫现网 NAT 兜住,不靠探活把好环境报红。
  "network:egress-none",
  "network:home-link",
  // 区级 S3 Tables 联邦目录 s3tablescatalog(数据湖直查 / 问数的前提,core 袋;home 与非 home 都出项)。
  // 🔴 2026-10-19 …7237 演练实撞:probe-runner 加了这一项、这里没登记 ⇒ 所有环境「精确 green 覆盖」恒 false ⇒
  //    新区探活全绿却停在 provisioning(「启用」灰)、存量在用区几个 tick 后全部掉成 degraded。
  //    棘轮:component-contract.test.ts 直接扫 probe-runner.ts 源码字面量 + probe-runner.test.ts 用真跑产物装配判;再加项两边必红。
  "lake:s3tablescatalog",
]);

/** 非 core 组件的探活项前缀(green 态 `<prefix>:<...>`;与 probe-runner.ts 的非 core 分支一致)。 */
const NON_CORE_PROBE_PREFIXES: readonly string[] = [
  "redshift",
  "mwaa",
  "dms",
  "flink",
  "agentcore",
  "kafka",
  "residency-api",
  "airflow-serverless",
];

/** 探活项形状(与 lifecycle.ProbeResult["items"][number] 结构兼容;此处不引值,只声明所需字段)。 */
export interface ProbeItemLike {
  name: string;
  ok: boolean;
  error?: string;
}

/**
 * 探活项 → 所属组件。
 * 🔴 归属不了返回 `null`(fail-closed):未知/畸形项名会让上层覆盖判定失败,而不是被默默算进某组件。
 */
export function componentForProbeItem(name: string): string | null {
  if (typeof name !== "string" || !name) return null;
  if (CORE_PROBE_ITEMS.has(name)) return "core";
  const prefix = name.includes(":") ? name.slice(0, name.indexOf(":")) : name;
  return NON_CORE_PROBE_PREFIXES.includes(prefix) ? prefix : null;
}

/**
 * 🔴 组件清单的**规范键**(去重 + 排序 + 逗号拼)—— 组件清单的语义是**集合**,不是序列。
 *
 * 【为什么必须有这个函数(2026-09-03 真环境 P0)】完成栅栏原来用 `JSON.stringify(a) === JSON.stringify(b)`
 * 比 desired / observed / probeInput 三份组件清单。而同一份清单在系统里有**两种排序**:
 *   · `orderComponents()` 的规范序(已实现组件按 `IMPLEMENTED_COMPONENTS` 次序,未实现的按字母序排尾);
 *   · 生产者的原始序(legacy 收养直接 `[...t.components]`;broker 直接存**客户端传来的**次序)。
 * 真实数据:home 是 `['core','redshift','mwaa','dms','flink','agentcore']`,规范序是
 * `['core','redshift','dms','flink','agentcore','mwaa']` ⇒ 逐字节比**永不相等** ⇒
 * **页面「检测初始化」必炸、周期收养永远写不进 observed**(用户真环境实测)。
 * 同族缺陷在 modern 路径同样潜伏:客户端只要按非规范次序传 components,**部署完成栅栏永久失败**。
 *
 * 🔴 修法刻意选在**比较点**而不是"每个生产者补一句 orderComponents":后者要求每个未来的生产者都记得,
 *    忘一个就复发;在比较点归一 ⇒ 这类 bug **结构上不可能**。归一只吃掉"次序/重复",
 *    **集合不同照样判不等**(partial-green 的防线一分不减)。
 */
export function componentSetKey(components: readonly string[]): string {
  // 🔴 `Array.from` 而非 `[...set]`:本仓 tsconfig 的 target 不允许迭代 Set(TS2802)——
  //    与 implemented-components.ts 的 `orderComponents` 同款写法(那边也是 Array.from)。
  return Array.from(new Set(components)).sort().join(",");
}

/** 两份组件清单是否**同一集合**(次序/重复无关)。见 `componentSetKey` 的根因说明。 */
export function sameComponentSet(a: readonly string[], b: readonly string[]): boolean {
  return componentSetKey(a) === componentSetKey(b);
}

/**
 * 🔴 本次探活是否 **精确 green 覆盖** 给定组件集。三条全满足才 true(否则 fail-closed):
 *   ① items 非空且**全绿**(任一项 ok≠true 即否);
 *   ② 每个 item 都归属到**声明组件集里的**某个组件(无杂项、无归属不了的项、无属于未声明组件的项);
 *   ③ 声明组件集里**每个**组件都至少被一项覆盖(杜绝「声称了却没探」的 partial green)。
 */
/**
 * 🔴 **这一份探活是否positively 证明「某个组件已经不在了」**。
 *
 * 为什么要单独一个谓词:`isGreenProbeForComponents` 问的是**完全不同**的问题 ——
 * 「整份探活全绿**且恰好只覆盖**这个组件集合」。拿它当「某个组件绿不绿」用是**语义错**:
 *   · 只要探活里有**别的**组件红着,它就回 false;
 *   · 只要探活里有**不在**入参集合里的项,它也回 false。
 * 2026-09-14 真环境实测:我在「摘除组件」的守卫里这么用了 ⇒ 守卫等于没有 ⇒
 * **一个还活着的 redshift 被摘掉了**(而且我的门禁把那个错误实现钉住了,是**真环境的负向控制**逮到的)。
 *
 * 判据(fail-closed):
 *   · 该组件**有**探活项且**全绿** ⇒ 它还活着 ⇒ **不许摘**;
 *   · 该组件**有**探活项且**至少一项红** ⇒ 探活positively 说它坏了/没了 ⇒ 可以摘;
 *   · 该组件**一个探活项都没有** ⇒ **不知道** ⇒ 一律**不许摘**(拿「没消息」当「没了」是最坏的一种静默)。
 */
export function probeSaysComponentGone(component: string, items: readonly ProbeItemLike[]): boolean {
  if (!Array.isArray(items)) return false;
  const mine = items.filter((it) => it && typeof it.name === "string" && componentForProbeItem(it.name) === component);
  if (mine.length === 0) return false; // 没有任何探活项 ⇒ 不知道 ⇒ 不许摘
  return mine.some((it) => it.ok !== true);
}

export function isGreenProbeForComponents(
  components: readonly string[],
  items: readonly ProbeItemLike[]
): boolean {
  if (!Array.isArray(components) || components.length === 0) return false;
  if (!Array.isArray(items) || items.length === 0) return false;
  if (!items.every((it) => it && typeof it.name === "string" && it.ok === true)) return false;
  const declared = new Set(components);
  const covered = new Set<string>();
  for (const it of items) {
    const comp = componentForProbeItem(it.name);
    if (comp === null || !declared.has(comp)) return false;
    covered.add(comp);
  }
  for (const c of components) if (!covered.has(c)) return false;
  return true;
}
