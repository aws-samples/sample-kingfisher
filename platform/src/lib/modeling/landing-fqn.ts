// @kf-batch 50-WP11b-shared-writer
// **建模产物物理落点 + 窄权写者身份**的唯一作者(50 SPEC v3.48–v3.51 §3.9d;WORK-PACKAGES WP-11b A 段步 1)。
//
// 🔴 为什么这四个函数必须住在同一个地方、而且只能住这里:
//   · 码表物理落点原来有**两个作者**各写一个名字(现网落地 `public.dim_code_<code>` vs admin 模板
//     `shared.code_<id>`),两者没有任何机械关系;而 `grant-shared-writer` 必须授到「真正落地的那张表」上 ——
//     它若再拼一遍名字,就是第三个作者(§3.9d.3)。
//   ⇒ `codeTableLandingFqn()` 是码表落点的唯一权威,四个消费者(落地语句 / `land-code-table` 模板 /
//     `grant-shared-writer` 模板 / 一致性矩阵 `physical`)全部经它;落点收敛(B 段)= 只改这一个返回值。
//   · 窄权写者的库用户名与 secret 名同理:执行器建它、落地路径用它,名字只能从这里派生。
//   · 落点守卫(门②)是「建模不受项目白名单约束」这条定案的**另一半**(§3.9d.8):只跳过白名单而不拦
//     `proj_<id>` = 把 fail-closed 换成 fail-open。
//
// 🔴 本文件**零 I/O、零 SDK**:客户端组件(建模页兜底显示物理落点)也 import 它 —— 两边看到的是同一个名字。

import { toTargetSlug } from "@/lib/exec-env/target-id";

/**
 * 每个 target 数仓里的**窄权写者**库用户名(§3.9d.1:target 级,不是 project 级)。
 * 建模是平台全局的、一张码表只有一个属主 ⇒ 每个数仓只有一个写者(`dms_ingest` 是同形态的既有先例)。
 */
export function sharedWriterUserName(): string {
  return "shared_writer";
}

/**
 * 窄权写者的 secret 名:`bgp/shared-writer/<targetSlug>`。
 * · `bgp/` 是平台 TaskRole 唯一放行的自管写前缀(与 `projectSecretName` 同一条理由);
 * · target 维走 `toTargetSlug()`,不自己拼;
 * · 🔴 **不进描述符资源袋**:用处按名现查(`describeSecretArnByName`),资源袋的唯一作者是部署期读 CFN Output。
 */
export function sharedWriterSecretName(targetId: string): string {
  return `bgp/shared-writer/${toTargetSlug(targetId)}`;
}

export interface LandingFqn {
  schema: string;
  table: string;
  /** `schema.table`(未加引号;显示 / 记录 / 矩阵 `physical` 用) */
  fqn: string;
}

/**
 * 码表的物理落点(§3.9d.3)。
 *
 * 🔴 **过渡期(A 段)返回值 = 现网形态 `public.dim_code_<code>`,逐字节不变** —— home 行为零变化,
 *    通道先通(E-229/E-230/E-231 不依赖改名)。收敛到 `shared.code_<id>` 是 B 段(E-232),
 *    必须连 home 存量一起迁移(矩阵 `physical` 是单值),**不许**只改非 home。
 */
export function codeTableLandingFqn(ct: { code: string }): LandingFqn {
  const schema = "public";
  const table = `dim_code_${ct.code}`;
  return { schema, table, fqn: `${schema}.${table}` };
}

export class LandingSchemaRejected extends Error {
  readonly code = "landing-schema-not-platform-global";
  constructor(message: string) {
    super(message);
    this.name = "LandingSchemaRejected";
  }
}

/**
 * 🔴 **门②:建模产物必须落平台全局 schema**(§3.9d.8)。
 *
 * 建模落地不受「授权项目」白名单约束(它没有项目维,白名单对它是 dead-closed);换上的那道真门就是这里:
 * 落点**不许**是任何项目私有 schema。项目私有 schema 的唯一形态是 `projectSchema()` 产出的 `proj_<…>`
 * (含 legacy `proj_default`),所以「以 `proj_` 开头」在形态上**闭合**覆盖了 `isSchemaOfProject(s, 任意项目)`。
 * 大小写一律折叠后判(Redshift 默认把标识符折成小写:`"PROJ_x"` 与 `proj_x` 是同一个 schema)。
 *
 * @returns 原样返回(便于链式)
 */
export function assertPlatformGlobalSchema(schema: string): string {
  const s = String(schema ?? "").trim();
  if (!s) throw new LandingSchemaRejected("建模产物的落点 schema 为空 ⇒ 拒绝(落点必须由平台定义给出)");
  if (/^proj_/i.test(s)) {
    throw new LandingSchemaRejected(
      `建模产物不许落进项目私有 schema ${JSON.stringify(s)}(建模是平台全局的,落点必须是平台全局 schema;` +
        `项目私有 schema 只属于那个项目的业务数据)`
    );
  }
  return s;
}
