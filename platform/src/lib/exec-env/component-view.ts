/**
 * **呈现面「这个组件到底装出来了没有」的唯一判断**（纯函数，好钉判据）。
 *
 * 【为什么需要它（2026-09-20，用户从页面复制给我的那三行之一）】
 * ```
 * eu-west-1 不承接新工作 已注册 tgt_euw1_a  core redshift  法域 eu-sim  探活 09-20 12:09
 * ```
 * 它**列出了** `core` `redshift` 两个组件、还显示了新鲜的探活时间，看起来像装好了。真值：
 * ```
 * tgt_euw1_a  status=registered  顶层 components=['core','redshift']
 *             spec={}  observed={}  resources 键数=0  probe.ok=False
 * ```
 * ⇒ 界面宣称了**两个根本没有载体的组件**（与那条「界面宣称了没有载体的能力」同族）。
 *
 * 【根因分两层，而且**第二层是我改了一版之后才量出来的**】
 * 第一层：顶层 `components` 本该是 observed 的镜像（`lifecycle.materializedProjection()`：
 *   `components: [...observed.components]`，双轴）。2026-09-20 量到 `tgt_euw1_a` 的
 *   `spec` 与 `observed` **都是空 map**，只有旧顶层字段有值 ⇒ 页面信了顶层就等于宣称没有的组件。
 *   ⇒ 第一版修成「以 observed 为准」。
 * 🔴🔴 第二层（2026-09-21 同一个描述符**再量一次**，它变了）：
 * ```
 * status=failed  顶层 components=['core','redshift']
 * observed.components=['core','redshift']   ← 观测态**也**说装了
 * observed.phase=provisioning  observed.health=unknown  resources=null
 * ```
 *   `observed.components` 本该是「**真读到栈的组件**」，却被写成了期望清单
 *   —— **观测态被期望态污染了**。于是「以 observed 为准」这一层**照样会撒谎**。
 *
 * 【所以呈现面要 fail-closed 两层】
 *   ① 以 `observed.components` 为准（不信顶层）；
 *   ② **再加一道**：只有这个环境真的走到 `phase=ready` 才谈得上「已装」（见 `targetIsReady`）。
 * 🔴 反过来（读不到就当装好了）才是危险的 —— 本仓「读不到不许回落成有」那条铁律：
 *   这里「读不到」必须落到**更保守**的一侧。
 */

/** 一行组件在呈现面的状态。 */
export interface ComponentViewItem {
  name: string;
  /** 真的建出来了 = `observed.components` 含它 **且** 这个环境走到了 `phase=ready`（两个条件都要，见文件头第二层） */
  installed: boolean;
}

export interface ComponentViewInput {
  /** 顶层兼容字段（正常情况下 = observed.components 的镜像） */
  components?: string[] | null;
  observed?: { components?: string[] | null; phase?: string | null } | null;
  /** 顶层投影 `deriveReady(observed)`；旧描述符可能只有这个 */
  ready?: boolean | null;
}

/**
 * 这个环境**真的装完并验过**了吗 —— 「已装」的必要条件。
 *
 * 🔴🔴 **为什么光看 `observed.components` 不够**（2026-09-21 真值坐实，该缺陷的第二层）：
 * ```
 * tgt_euw1_a  status=failed
 *             顶层 components      = ['core','redshift']
 *             observed.components  = ['core','redshift']   ← 观测态**也**说装了
 *             observed.phase       = provisioning          ← 其实还在装
 *             observed.health      = unknown
 *             resources            = null                  ← 一个资源都没建出来
 * ```
 * `observed.components` 本该是「**真读到栈的组件**」（`lifecycle.ts` 那一行的原话），
 * 但它被写成了期望清单 —— **观测态被期望态污染了**。
 * 于是「以 observed 为准」这一层也会照样撒谎：卡片上两个组件都显示成已装，
 * 而那个区连一个资源都没有（用户 2026-09-20 就是这么在页面上发现它的）。
 *
 * ⇒ 呈现面必须再 fail-closed 一层：**只有这个环境走到 `phase=ready` 才谈得上「已装」**。
 *   `phase` 是成功栅栏写的（部署 + 探活全绿才 ready），它是「真的有载体」最接近的可读真值。
 *   兼容：`phase` 缺失（旧描述符）时认顶层投影 `ready` —— 那是同一件事的镜像，不是回落到期望态。
 */
export function targetIsReady(target: ComponentViewInput): boolean {
  const phase = target.observed?.phase;
  if (typeof phase === "string" && phase) return phase === "ready";
  return target.ready === true;
}

/**
 * 卡片上要逐个显示的组件行。
 *
 * 并集语义：顶层声称的 ∪ 观测到的 —— 两边都要列出来，因为
 *   · 只在顶层里（observed 没有）= **声称了却没建出来** ⇒ 待部署（那个形态）；
 *   · 只在 observed 里（顶层没有）= 投影落后了，但它**真的在**  ⇒ 已装（不许因为投影漏了就不显示）。
 */
export function componentViewItems(target: ComponentViewInput): ComponentViewItem[] {
  const claimed = (target.components ?? []).filter((x): x is string => typeof x === "string" && !!x);
  const observed = (target.observed?.components ?? []).filter(
    (x): x is string => typeof x === "string" && !!x
  );
  const obsSet = new Set(observed);
  // 🔴 两个条件**都要**:observed 里有它 **且** 这个环境真的 ready(见 targetIsReady 的整段理由)。
  //   少了后半条,`observed.components` 被污染的那一刻界面就又开始宣称没有载体的组件。
  const ready = targetIsReady(target);
  const names: string[] = [];
  for (const n of [...claimed, ...observed]) if (!names.includes(n)) names.push(n);
  return names.map((name) => ({ name, installed: ready && obsSet.has(name) }));
}

/** 一个组件都没建出来（而且确实声称了要装）—— 卡片上要说清「尚未部署」。 */
export function claimsNothingInstalled(target: ComponentViewInput): boolean {
  const items = componentViewItems(target);
  return items.length > 0 && items.every((x) => !x.installed);
}
