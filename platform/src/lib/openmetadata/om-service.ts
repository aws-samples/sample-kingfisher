// **OpenMetadata 服务名与执行环境的映射**(单一作者;纯函数、零依赖 AWS)。
//
// ── 为什么需要它 ──────────────────────────────────────────────────────────────
// 🔴🔴 **用户 2026-09-10 拍板(逐字)**:「治理目录必须走同一个 OpenMetaData,不然又多维护一套东西,
//    到时候极其容易出现不兼容和忘记修复的情况。」
//
// 上一版为了让非主控区的目录「实时」,给它开了第二条路(直查那个区的 Glue + 数仓)。用户否决:
// **两条路 = 两套要同步维护的呈现逻辑**,而这类分叉的失效方式正是「改了一边忘了另一边」。
// ⇒ 定案:**OM 是目录的唯一系统记录**;「哪个区」这件事表达成 **OM 里的 service 维度**:
//     · 主控区:`bgp-redshift` / `bgp-glue`(**名字不变** —— 存量实体不迁移、零 breaking)
//     · 其它区:`bgp-redshift-<targetSlug>` / `bgp-glue-<targetSlug>`
//   各区的表由**元数据镜像**(W3-e 已有的 per-region 采集)推进 OM 的对应 service。
//
// 🔴 为什么用「后缀 = targetSlug」而不是另存一个字段:OM 的 table FQN 天然是
//    `<service>.<db>.<schema>.<table>` ⇒ service 一段就够定位区,列表接口不用额外 join;
//    而 `targetSlug` 是命名 SSOT 的既有派生键(`toTargetSlug`),不是这里新造的第二套 id。

import { HOME_TARGET_ID, isHome, toTargetSlug } from "@/lib/exec-env/target-id";

/**
 * 实体种类 ↔ OM service 前缀(与 om-push 里既有的常量同名同值,不许再起第二套)。
 *
 * 🔴 原来只有 `redshift` / `glue` 两类(元数据镜像用);同步推送(源表 → S3 Tables → 数仓 + 物理端点)
 *    的另外三类 service(`bgp-sources` / `bgp-s3tables` / `bgp-physical`)在 om-push 里各自是常量 ——
 *    非主控区一推就只能推进主控区的 service(= 把该区的表当成主控区的挂进 OM),于是原来干脆不推(登记 o4-REG)。
 *    现在五类都在这一张表里,per-target 的规则(home 无后缀 / 其它区 `-<slug>`)对五类**同一条**。
 */
export const OM_SERVICE_PREFIX = {
  redshift: "bgp-redshift",
  glue: "bgp-glue",
  s3tables: "bgp-s3tables",
  sources: "bgp-sources",
  physical: "bgp-physical",
} as const;

/** 全部实体种类(service 维度的单一事实源)。 */
export type OmServiceKind = keyof typeof OM_SERVICE_PREFIX;
/** 元数据镜像的两类来源(镜像 / 对账只认这两类;类型上收窄,不让镜像去碰同步推送的 service)。 */
export type OmMirrorSource = Extract<OmServiceKind, "redshift" | "glue">;

/**
 * 某种实体在某执行环境上的 OM service 名。
 * 🔴 home **不带后缀** —— 存量 OM 里已经有 `bgp-redshift` 的库/表(sync / 建模 / 血缘推的),
 * 给它改名等于把历史资产搬家:FQN 全变、血缘断、收藏与标签全丢。零迁移是硬要求。
 */
export function omServiceFor(kind: OmServiceKind, targetId: string): string {
  const base = OM_SERVICE_PREFIX[kind];
  return isHome(targetId) ? base : `${base}-${toTargetSlug(targetId)}`;
}

/**
 * service 名去掉 per-target 后缀后的**基名**(图标 / 来源标签按基名判;认不出的原样返回)。
 * 🔴 单一作者:目录 / 血缘 / 影响分析三个读路由原来各写一份 switch,只有目录认后缀 ——
 *    每加一个区,另两页那个区的节点图标就退化成默认值。
 * 判法:基名是已登记前缀之一,且后缀是合法 targetSlug 形态(`tgt-…`,`toTargetSlug` 的产物)。
 */
export function omServiceBase(service: string): string {
  const s = String(service || "");
  for (const base of Object.values(OM_SERVICE_PREFIX)) {
    if (s === base) return base;
    if (s.startsWith(`${base}-tgt-`) && /^[a-z0-9-]+$/.test(s.slice(base.length + 1))) return base;
  }
  return s;
}

/**
 * 一个 service 名属于哪个执行环境。
 *
 * 判法:带 `-<slug>` 后缀的归那个 target;**没有任何已知 target 后缀的一律归 home** ——
 * 这条兜底不是偷懒:OM 里还有 `bgp-sources` / `bgp-s3tables` / `bgp-physical` 这些
 * **平台级**(非 per-region)服务,它们的资产今天全在主控区(数据源 `ownerTargetId` 恒 home)。
 * 把它们判成 home = 与数据事实一致;判成「未知」则会在主控区视角凭空少掉半个目录。
 */
export function omServiceTargetOf(service: string, knownTargetIds: readonly string[]): string {
  for (const t of knownTargetIds) {
    if (isHome(t)) continue;
    if (service.endsWith(`-${toTargetSlug(t)}`)) return t;
  }
  return HOME_TARGET_ID;
}

/** 该 service 是否属于给定视角(target 视角 = 只要属于它的;`null` = 全部视角,全要)。 */
export function omServiceInScope(
  service: string,
  scopeTargetId: string | null,
  knownTargetIds: readonly string[]
): boolean {
  if (!scopeTargetId) return true;
  return omServiceTargetOf(service, knownTargetIds) === scopeTargetId;
}
