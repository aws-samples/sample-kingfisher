// @kf-batch 50-P50.1-workgroup-ssot
// 数仓落点(workgroup / database)的**唯一出口** —— P50.1「收编兜底字面量」。
//
// 合同:50 SPEC §1-B(`bgp-workgroup` 兜底字面量收编)· 命名 SSOT `platform/naming.json`
//      的 `redshiftWorkgroup` kind 自己的 `$note` 就写着「这是 …`|| "bgp-workgroup"` 兜底字面量的
//      **收编目标**(收编本身属 P50.1)」。
//
// ── 为什么必须收编(不是洁癖)────────────────────────────────────────────────
// 实测全仓 `"bgp-workgroup"` 字面量 **49 处**,而它们的兜底层级**并不一致**:
//   · 多数是三级 `config || process.env.REDSHIFT_WORKGROUP || "bgp-workgroup"`;
//   · 但 `etl/dag-generator`(**调度**路径)、`om-push` 两处、`redshift/databases|schemas` 是
//     两级 `config || "bgp-workgroup"` —— **完全跳过了 env**;
//   · `workflow/dag-generator` 与 `runtime-lib` 的 Python 更是**写死** `WorkgroupName="bgp-workgroup"`,
//     连 config 都不看。
// ⇒ 一旦 `REDSHIFT_WORKGROUP` 被改成别的值(多 region 起来之后必然发生),
//    **手动运行走新 workgroup、调度运行走 bgp-workgroup** —— 同一个作业两条路径打到两个数仓,
//    症状是"手动跑有数据、定时跑没数据",而代码里看不出任何错误。
//    这正是 memory `root-fix-not-patch-mandate` 里那个元模式:
//    「部署时快照 + 运行期增长」的配置必须单一真值源派生,不能散点硬编码。
//
// ── 缺省逐字节等价(P50.1 的硬要求)────────────────────────────────────────
// `homeWorkgroup()` = `process.env.REDSHIFT_WORKGROUP || resourceName("redshiftWorkgroup", home)`,
// 而后者对 home 的模板就是字面量 `bgp-workgroup` ⇒ **与改动前完全同值**(有单测逐字节钉住)。
// `resolveWorkgroup(configured)` 刻意写成 `configured || homeWorkgroup()`(**不 trim**),
// 与存量 `a || b || c` 的真值语义逐字一致 —— 顺手"改好"空白串会让等价性宣称变成假的。
//
// ── 非 home 为什么 fail-closed ────────────────────────────────────────────
// 照 `getRedshiftSecretArn`(50 G6)立下的先例:非 home 的落点**不能从 env 猜**,
// 必须来自该 target 描述符的 `resources` 袋(registry.ts:「运行时一律读描述符实名」)。
// 猜错的后果不是报错,而是"看起来正常地连到了别的区域" —— 所以这里显式抛错。
// per-target 下发随 **P50.3**;本批只把 `target?` 这个参数位开出来(缺省不变)。

import { resourceName } from "@/lib/aws/naming";
import { HOME_TARGET_ID, isHome } from "@/lib/exec-env/target-id";

/** home 的登记名(来自命名 SSOT,不是这里写的字面量)。 */
export const HOME_WORKGROUP: string = resourceName("redshiftWorkgroup", { targetId: HOME_TARGET_ID });
export const HOME_DATABASE: string = resourceName("redshiftDatabase", { targetId: HOME_TARGET_ID });

/** 平台默认 workgroup(env 覆盖优先,与存量三级兜底的中间层逐字一致)。 */
export function homeWorkgroup(): string {
  return process.env.REDSHIFT_WORKGROUP || HOME_WORKGROUP;
}

/** 平台默认 database。 */
export function homeDatabase(): string {
  return process.env.REDSHIFT_DATABASE || HOME_DATABASE;
}

/**
 * 三级兜底的**唯一实现**:资源自带配置 → env → 命名 SSOT。
 * 传 `undefined` 即等价于 `homeWorkgroup()`。
 */
export function resolveWorkgroup(configured?: string | null): string {
  return configured || homeWorkgroup();
}

export function resolveDatabase(configured?: string | null): string {
  return configured || homeDatabase();
}

export interface WarehouseLocation {
  targetId: string;
  workgroup: string;
  database: string;
}

/**
 * 某个执行目标的数仓落点。
 *
 * 🔴 **本批(P50.1)只开参数位**:`targetId` 缺省 / 传 home ⇒ 与改动前逐字节等价;
 * 传非 home ⇒ **抛错**并指向描述符(P50.3 才有真实下发)。刻意不写 `?? home` 兜底 ——
 * 那是外部审核 P0-4 抓过的 fail-open 形状(要 A 给了 B 的连接信息)。
 */
export function warehouseLocationSync(opts?: {
  targetId?: string;
  workgroup?: string | null;
  database?: string | null;
}): WarehouseLocation {
  const targetId = opts?.targetId ?? HOME_TARGET_ID;
  if (!isHome(targetId)) {
    // 🔴 这里刻意**不复用** `assertHomeOnly` 的通用文案:数仓落点的正确出处是
    // 该 target 描述符的 `resources` 袋(不是"等 P50.3 给客户端"),报错要把人指到对的地方。
    throw new Error(
      `数仓落点只解析 home;target ${targetId} 的 workgroup/database 必须取自其描述符的 resources 袋` +
        `(50 SPEC §1.1;per-target 下发随 P50.3)`
    );
  }
  return {
    targetId,
    workgroup: resolveWorkgroup(opts?.workgroup),
    database: resolveDatabase(opts?.database),
  };
}

/**
 * 「`target?` 参数位已开、但 per-target 下发还没到」这一过渡态的**唯一守卫**。
 *
 * 50 SPEC §3.4 要求 4 个原子函数(`runSelect` / `runSelectAthena` / `introspectSchema` /
 * `introspectS3Tables`)接受 `target?`,且**缺省逐字节等价**。真正的 per-target 解析
 * (客户端 region、per-target workgroup、per-target 凭证)在 **P50.3**。
 *
 * 🔴 过渡期只有两种正确行为:缺省/home ⇒ 原样;非 home ⇒ **抛错**。
 * 绝不允许第三种"先按 home 跑着"—— 那会让"我明明选了欧洲区"变成一次静默的跨境查询。
 * 形状照 `getRedshiftSecretArn`(50 G6)与 `platform-env.defaultSgId`(G6)的先例。
 */
export function assertHomeOnly(targetId: string | undefined, what: string): string {
  const tid = targetId ?? HOME_TARGET_ID;
  if (!isHome(tid)) {
    throw new Error(
      `${what}目前只支持 home 执行目标;target ${tid} 需要 per-target 客户端与凭证` +
        `(50 SPEC §3.4;随 P50.3 下发)。这里刻意不回落 home —— 回落等于静默跨区执行。`
    );
  }
  return tid;
}
