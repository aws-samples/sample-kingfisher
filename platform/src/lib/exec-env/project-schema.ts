// @kf-batch 50-G2R
// G4(提前并入 G2R)—— 项目 schema / 项目 DB role / shared schema 的**唯一权威**命名。
//
// 设计合同:52 SPEC §3.0(权威 `projectSchema()`)、§1 数据面对象表。
//
// ── 为什么提前 ────────────────────────────────────────────────────────────────
// G2R 要交付 7 个 admin-DDL 私有模板,而模板里的 schema / role 名**必须**来自这里。
// 若先用占位符、等 G4 再换,就是"同一个函数被两期各改一次",违 50 SPEC §6.6 的"一次改齐"铁律。
//
// ── 为什么必须只有一处 ────────────────────────────────────────────────────────
// 52 SPEC §3.0 坐实现状有**三套互不兼容**的 sanitize:
//   · `sync/s3tables-identifier.ts` sanitizeS3TablesIdentifier(小写、有损、无长度上限)
//   · `modeling/redshift.ts` safeIdent(保大小写、非法即抛)
//   · glue-script-generator 内的 python `re.sub`
// 三套并存 ⇒ 建表用一套、查询用另一套 ⇒ "建好的表查不到"。故定死唯一 SSOT,
// **建表 / 写入 / 查询 / S3Tables namespace 四处共用**。
//
// 🔴 G2R 阶段本文件**没有生产调用方**(只被 admin-DDL 模板与单测使用)⇒ 现网行为变化为 0。
// 收编现有三套散点是 **G0/P52.5a** 的事,不在本批。

import { createHash } from "node:crypto";
// @kf-batch 52-P52.5a-supply — target 维一律取自 SSOT,不在本文件自己拼 slug。
import { assertTargetId, toTargetSlug } from "@/lib/exec-env/target-id";

/** 全局知识类物理表所在 schema(52 SPEC §1:码表/一致性维度等"企业统一语言")。 */
export const SHARED_SCHEMA = "shared";

/** Redshift 标识符上限 127 字节(52 SPEC §3.0)。 */
const IDENT_MAX = 127;
/** 需要截断时保留的前缀长度,余量留给 `_<6位哈希>`。 */
const TRUNCATE_TO = 120;

/**
 * `proj-default` 特例:schema 名定为 `proj_default`,**不是** `proj_proj_default`
 * (52 SPEC §3.0 明写"写死于映射表,消 P2-2 二义)。
 */
const EXPLICIT_MAP: Readonly<Record<string, string>> = { "proj-default": "proj_default" };

function sanitize(projectId: string): string {
  return projectId.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

function shortHash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 6);
}

/**
 * 项目私有 schema 名(52 SPEC §3.0 权威实现)。
 *
 * 🔴 **逐字按合同实现,不"顺手优化"**:合同是 `proj_<sanitize(projectId)>`,而 projectId 形如
 * `proj-<ulid>` ⇒ 产物会是 `proj_proj_<ulid>`(前缀看起来重复)。这**不是 bug**,是合同原文,
 * 且合同专门为 `proj-default` 写了特例说明"不是 `proj_proj_default`" —— 说明作者知道会重复。
 * 我**不在实现里偷偷改掉它**:若要去掉重复,那是改 52 SPEC §3.0 的合同变更,须单独立批
 * (悄悄改 = 建表用新名、存量元数据用旧名,正是本文件要消除的那类分叉)。
 *
 * 唯一性不变量:projectId 由平台生成 = `^proj-[0-9A-HJKMNP-TV-Z]{26}$`(ULID = Crockford base32,
 * **大写**,已排除易混的 I/L/O/U)⇒ `sanitize` 只做一次全局小写化,在"只有大写形态被接受"的前提下
 * 是**双射**、无损。若将来允许自定义 projectId,须维护 projectId→schema 台账 + 碰撞检测。
 */
export function projectSchema(projectId: string): string {
  assertProjectId(projectId);
  const explicit = EXPLICIT_MAP[projectId];
  if (explicit) return explicit;
  const base = `proj_${sanitize(projectId)}`;
  return base.length <= IDENT_MAX ? base : `${base.slice(0, TRUNCATE_TO)}_${shortHash(projectId)}`;
}

/** 项目 DB role 名(52 SPEC §1:`role_proj_<sanitize(id)>`)。与 schema 共用同一 sanitize。 */
export function projectRoleName(projectId: string): string {
  assertProjectId(projectId);
  const explicit = EXPLICIT_MAP[projectId];
  const body = explicit ? explicit.replace(/^proj_/, "") : sanitize(projectId);
  const base = `role_proj_${body}`;
  return base.length <= IDENT_MAX ? base : `${base.slice(0, TRUNCATE_TO)}_${shortHash(projectId)}`;
}

/**
 * 数据湖 namespace(52 SPEC §1:按 **projectId** 派生、**非库名**;共用同一 sanitize)。
 * 单独导出而不是让调用方复用 `projectSchema()` —— 让"用错轴"在 code review 里看得见。
 */
export function projectLakeNamespace(projectId: string): string {
  return projectSchema(projectId);
}

/**
 * 平台生成的 projectId 形态:`proj-` + 26 位 **ULID**。
 *
 * 🔴🔴 **2026-09-03 真环境订正(P52.1-D4 施工时逮到)**:原来这里写的是
 * `^proj-[0-9a-hjkmnp-tv-z]{26}$`(**小写**),而平台真正的生成器 `project-service.createProject`
 * 用的是 `ulid()`,它按 ULID 规范返回 **大写** Crockford base32
 * ⇒ **每一个真实 projectId 都被这个校验拒掉**(真环境实测 `proj-01M1KP594D2E6DJQC8EZ8CRAES`)。
 *
 * 为什么 1600+ 单测一直全绿:`project-schema.test.ts` 的 fixture 是 `"0".repeat(26)` ——
 * **全数字、大小写同形**,恰好绕过了唯一有区别的那一维(同 memory `byte-exact-comparison-traps`
 * 里"fixture 恰好同序"那一类)。而本文件在 G4 落地时**没有任何生产调用方**(文件头自陈),
 * D4 的删项目前置校验是它的**第一个生产调用方**,一接上就炸 ——
 * 症状:`projectSchema()` 抛错 → 盘点标为"无法核实" → fail-closed ⇒ **所有项目都删不掉**。
 * ⇒ 这条 bug 若不在这里逮住,会等到 P52.5a/5b 建 `proj_` schema 时才发作(那时更贵)。
 *
 * 🔴 **刻意只接受大写**(不加 `/i`):`sanitize()` 会全局小写化,若大小写两种形态都合法,
 * `proj-ABC…` 与 `proj-abc…` 会映到**同一个 schema** = 跨项目数据混淆。
 * 只认平台真实产出的大写形态,才保住"sanitize 是双射"这个不变量。
 */
const PROJECT_ID_RE = /^proj-[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * 校验 projectId 形态。
 *
 * 🔴 **必须存在**:模板里的标识符直接来自它。若放任任意字符串进来,
 * sanitize 之后仍可能撞名(两个不同 projectId 映到同一 schema)= 跨项目数据混淆。
 * 这里只接受平台生成形态 `proj-<26位大写 ULID>` 与 legacy 常量 `proj-default`。
 */
export function assertProjectId(projectId: unknown): string {
  if (typeof projectId !== "string" || !projectId) {
    throw new Error(`非法 projectId:${JSON.stringify(projectId)}(需字符串)`);
  }
  if (projectId in EXPLICIT_MAP) return projectId;
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new Error(
      `非法 projectId:${JSON.stringify(projectId)};要求 ${PROJECT_ID_RE.source}` +
        `(平台生成的大写 ULID)或 legacy 常量 ${Object.keys(EXPLICIT_MAP).join("/")}`
    );
  }
  return projectId;
}

// ══════════════════════════════════════════════════════════════════════════════
// @kf-batch 52-P52.5a-supply — per-project **凭证**相关的派生名(与 schema/role 同一作者)
//
// 🔴 **落点与 52 DESIGN §12 事实⑤ 的说法不同,理由如下(不是漏做)**:
// §12⑤ 写「per-project secret 名要在**命名 SSOT(naming.json)** 新增一个 kind,双侧逐字节一致」。
// 照它做会**撞既有门禁**:`naming-coverage.test.ts` 有一条「反向的反向:naming.json 里登记的
// home 定值名,必须真的在 infra/lib 出现过(**防登记幽灵资源**)」。而这个 secret 是
// **平台运行期**按项目创建的,CDK 侧从不产出它的名字 ⇒ 登记成 kind 必然被判成幽灵资源;
// 且 `naming.json` 的模板变量是封闭集合(account/region/slug/component),**没有 project 维**,
// 加一维要连 parity fixture 矩阵一起扩,而扩出来的那一维在部署侧永远没有对应物。
// ⇒ 正确落点是**项目派生名的既有唯一作者**(本文件:`projectSchema` / `projectRoleName` /
//   `projectLakeNamespace` 都在这儿)。target 维仍取自 SSOT 的 `toTargetSlug()`,不自己拼。
// 🔴 该偏离已回灌 52 DESIGN §13bis,不留"代码与合同各说各话"。
// ══════════════════════════════════════════════════════════════════════════════

/**
 * per-project 凭证 secret 的**名字**(不是 ARN;ARN 由 Secrets Manager 追加随机后缀,按名 Describe 换取)。
 *
 * 形态:`bgp/project/<targetSlug>/<projectId>`
 * · 前缀 `bgp/` —— 平台 TaskRole 的 secret **写**语句只允许 `bgp/*` 与 `bgp-*` 两个自管前缀
 *   (infra `platform-stack.ts`;P52.5a 把该语句翻成 execution 轴,故非 home 也能建);
 * · `targetSlug` 走 `toTargetSlug()`(target 维的唯一权威,DNS 安全形态);
 * · 🔴 项目段用**原样 projectId**(不过 `sanitize`):`assertProjectId` 只接受大写 ULID 形态
 *   ⇒ 原样即**单射**;而 `sanitize` 会全局小写化,虽然在"只收大写"的前提下也是双射,
 *   但 secret 名的查找是**逐字节**的,少一层变换就少一处将来会漂的地方。
 */
export function projectSecretName(targetId: string, projectId: string): string {
  assertProjectId(projectId);
  return `bgp/project/${toTargetSlug(assertTargetId(targetId))}/${projectId}`;
}

/**
 * per-project 的 Redshift **登录用户名**(secret 里存的就是它 + 口令)。
 *
 * 🔴 **合同缺口,已如实登记**:52 SPEC §1 的对象表只定义了「项目 DB role = `role_proj_<sanitize(id)>`」,
 * 没有定义**登录用户**。而 Redshift 的 RBAC 是 `CREATE USER` + `GRANT ROLE <role> TO <user>` 两件事:
 * role 是权限集合、user 才是能拿口令登录的主体。少了用户名的口径,供给层就得现场编一个
 * ⇒ 那正是本仓反复出现的"同一个名字两处各拼一遍"。
 * ⇒ 这里定为 `user_proj_<sanitize(id)>`(与 role 同 sanitize、同前缀风格,肉眼可对应),
 *   并回灌 52 SPEC §1 / 52 DESIGN §13bis。
 */
export function projectDbUserName(projectId: string): string {
  assertProjectId(projectId);
  const explicit = EXPLICIT_MAP[projectId];
  const body = explicit ? explicit.replace(/^proj_/, "") : sanitize(projectId);
  const base = `user_proj_${body}`;
  return base.length <= IDENT_MAX ? base : `${base.slice(0, TRUNCATE_TO)}_${shortHash(projectId)}`;
}

/** 判断某个 schema 名是否属于给定项目 —— 模板与守卫做"对象归属"校验时用。 */
export function isSchemaOfProject(schemaName: string, projectId: string): boolean {
  return schemaName.toLowerCase() === projectSchema(projectId).toLowerCase();
}
