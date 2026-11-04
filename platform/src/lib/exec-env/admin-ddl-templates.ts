// G2R—— admin-DDL 的**私有模板注册表**(50 SPEC §3.9a v3.3,用户拍板 B)。
//
// 这里是新的**真安全边界**:SQL 不再由调用方提供,而是由每个 operation 的私有 builder 生成。
// 调用方只能传 `{operation, targetId, projectId, …}`;产物是 branded type,模块外构造不出。
//
// 🔴 **7 个 operation 一个都不删**(用户明确要求 + 建议书 §5 拒绝清单第 5 条)。
//    也**不许**把某个 operation 实现成永久 throw / 501 / no-op 再宣称 fail-closed(第 6 条)。
//
// 🔴 **`land-code-table` 必须拆两层,否则接线即废功能**(50 SPEC §3.9a §4.6,打真码坐实):
//    `modeling/redshift.buildLandStatements` 实际生成
//      CREATE TABLE IF NOT EXISTS / DELETE FROM / DROP TABLE / INSERT INTO … VALUES
//    而旧的 `assertNotUserDataRead` **blanket 禁 INSERT/DELETE** ⇒ 直接接线会把码表落地判死。
//    定案:本 admin 模板**只管结构 + 权限**;**数据写入不走 admin**。所以 `land-code-table` 的模板里
//    **没有 INSERT/DELETE** —— 数据写入由窄权 `shared_writer` 执行(
//    SPEC §3.9d:`modeling/landing.ts` 非 home 分支用它的 secret 直调 `execOnTarget`)。
//
// 🔴 **G2R 口径**:本文件生产调用 0 处、不改现网行为;**P0-4 仍未关闭**。

import {
  type AdminDdlRequest,
  type GeneratedAdminStatement,
  type VerifiedAdminDdlContext,
} from "@/lib/exec-env/admin-ddl-request";
import { SHARED_SCHEMA, projectDbUserName, projectRoleName, projectSchema } from "@/lib/exec-env/project-schema";
// 落点 / 窄权写者名的唯一作者 + 建模 DDL 的唯一作者(模板只 brand,不再拼一遍)
import {
  assertPlatformGlobalSchema,
  codeTableLandingFqn,
  sharedWriterUserName,
  type LandingFqn,
} from "@/lib/modeling/landing-fqn";
import { buildCodeTableCreateStatement, buildCreateTableStatements } from "@/lib/modeling/redshift";
// 图形化改表的语句作者(与 home 路径同一份)
import { buildAlterTableStatements, isEmptyAlterPlan } from "@/lib/modeling/alter";
// canary 探针名的唯一作者(与判据侧 permission-canary.ts 同源)
import { CANARY_DENY_SCHEMA, CANARY_TABLE } from "@/lib/exec-env/canary-names";

/**
 * 🔴 **mint 函数(v3.5 从 `admin-ddl-request.ts` 移到这里,且不导出)**。
 *
 * 外部审核 v3 P0-B:原先它是**公开导出**的,于是任何生产模块都能
 * `brandStatement("DROP DATABASE victim")` 铸出一条"看起来是模板产物"的语句 —— 类型层的
 * branded type 被自己的 mint 函数抵消掉了。现在它是**本模块私有**:模板是唯一产出口。
 *
 * ⚠️ 如实说清上限:TS 的 brand 挡不住显式 `as unknown as` cast(那是语言特性,不是本文件的疏忽)。
 * 所以另有一条**机械门禁**扫全仓越界 cast(见 `__tests__/admin-ddl-contract.test.ts`),
 * 而真正的边界是 §3.9a 的闭合执行器 —— **它还没落地,P0-B 仍未关闭**。
 */
function brandStatement(sql: string): GeneratedAdminStatement {
  return sql as GeneratedAdminStatement;
}

/**
 * 标识符编码。
 *
 * 🔴 标识符与 literal **分开编码**(50 SPEC §3.9a):标识符走双引号 + 内部双引号翻倍,
 * literal 走单引号 + 内部单引号翻倍。绝不把两者混用一套转义 —— 那是注入的经典入口。
 * 这里的输入本来就已经过 SSOT(projectSchema/projectRoleName)与形态校验,双保险。
 */
function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    // 到这一步还不合法,说明 SSOT 或校验被绕过了 —— 宁可炸,不要拼出一条奇怪的 SQL。
    throw new Error(`模板拒绝非法标识符:${JSON.stringify(name)}`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

function literal(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** DMS 增量同步的固定摄入身份(与 realtime/redshift-target 现状同名,便于后续迁移对齐)。 */
const DMS_INGEST_USER = "dms_ingest";
const DMS_INGEST_SCHEMA = "dms_ingest";

/**
 * 每个 operation 一个 builder。
 * 🔴 用 mapped type 绑定,**新增 operation 时 TypeScript 会强制你补一项**(穷尽性由类型系统保证,
 *    不靠"记得改")。
 */
type TemplateBuilders = {
  [K in AdminDdlRequest["operation"]]: (
    request: Extract<AdminDdlRequest, { operation: K }>,
    context: VerifiedAdminDdlContext
  ) => GeneratedAdminStatement[];
};

/**
 * 建模类 operation 的落点:**只**来自执行器第 2 步服务端读台账得到的 `context.modelingObject`,
 * 且必须与 request 里的 id 对得上(防「拿 A 的台账行去建 B」)、必须过门② 落点守卫。
 * 🔴 缺 / 对不上 ⇒ 抛 —— 宁可炸,不许回落任何默认名(那就是第三个作者)。
 */
function modelingLanding(
  ctx: VerifiedAdminDdlContext,
  expect: { kind: "code-table" | "model-table"; id: string }
): LandingFqn {
  const o = ctx.modelingObject;
  if (!o || o.kind !== expect.kind) {
    throw new Error(`模板缺少服务端解析的 ${expect.kind} 台账对象(执行器第 2 步没跑或被绕过)⇒ 拒绝生成`);
  }
  const id = o.kind === "code-table" ? o.codeTableId : o.modelTableId;
  if (id !== expect.id) {
    throw new Error(`台账对象 ${id} 与请求的 ${expect.id} 不符 ⇒ 拒绝生成`);
  }
  const fqn: LandingFqn =
    o.kind === "code-table"
      ? codeTableLandingFqn({ code: o.code })
      : { schema: o.schema, table: o.physicalTable, fqn: `${o.schema}.${o.physicalTable}` };
  assertPlatformGlobalSchema(fqn.schema);
  return fqn;
}

/** 🔴 一律用 context 里**服务端解析出的** schema 名,不用 request 里的任何名字。 */
function schemaOf(ctx: VerifiedAdminDdlContext, projectId: string): string {
  return ctx.projectSchemaName ?? projectSchema(projectId);
}

const builders: TemplateBuilders = {
  "create-project-schema": (req, ctx) => {
    const schema = schemaOf(ctx, req.projectId);
    // 🔴🔴 **真环境第一次执行就逮到的真 bug(原来这里写的是 `OWNER TO role_proj_…`)**:
    // Redshift 的 `ALTER SCHEMA … OWNER TO <name>` 里 `<name>` 必须是 **user**,**role 不能当属主**。
    // 真环境报错原文:`ERROR: user "role_proj_proj_01m1…" does not exist` ——
    // 它把 role 名当用户名去查,自然查不到。
    //
    // 为什么 1801 个单测一个都没抓到:本模板在 G2R 落地时**零生产调用方**,单测只断"产物里出现了
    // role 名",而 mock 不会真跑 Redshift(memory `unwired-code-is-unverified`:
    //「没生产调用方 = 从未验证过的代码」;`assertProjectId` 那次是同一类)。
    //
    // 改成登录用户后**原始意图反而更准**:注释本来写的是"使该项目自己建的表天然属主一致" ——
    // 而在 per-project 凭证下,该项目的每条连接都是 `user_proj_<id>`,让它当属主才真的一致;
    // role 是权限集合,不是连接主体。
    // 🔴 连带约束:登录用户必须**先存在** ⇒ 供给顺序里 `provision-login` 排在本步之前
    //    (见 `project-cred-supply.ts` 的六步说明)。
    const owner = projectDbUserName(req.projectId);
    return [
      brandStatement(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)}`),
      brandStatement(`ALTER SCHEMA ${ident(schema)} OWNER TO ${ident(owner)}`),
    ];
  },

  "create-shared-schema": () => [
    brandStatement(`CREATE SCHEMA IF NOT EXISTS ${ident(SHARED_SCHEMA)}`),
    // 🔴 shared 只给**只读**;写入由窄权 shared-writer 承担(§4.6)。
    // 🔴 绝不 `GRANT ... TO PUBLIC`(那是要撤的 6 处存量授权的形状)。
  ],

  "create-role": (req) => [brandStatement(`CREATE ROLE ${ident(projectRoleName(req.projectId))}`)],

  grant: (req, ctx) => {
    const schema = schemaOf(ctx, req.projectId);
    const role = projectRoleName(req.projectId);
    return [
      brandStatement(`GRANT USAGE ON SCHEMA ${ident(schema)} TO ROLE ${ident(role)}`),
      brandStatement(`GRANT ALL ON ALL TABLES IN SCHEMA ${ident(schema)} TO ROLE ${ident(role)}`),
      // shared 只读:USAGE + SELECT,不给写。
      brandStatement(`GRANT USAGE ON SCHEMA ${ident(SHARED_SCHEMA)} TO ROLE ${ident(role)}`),
      brandStatement(`GRANT SELECT ON ALL TABLES IN SCHEMA ${ident(SHARED_SCHEMA)} TO ROLE ${ident(role)}`),
    ];
  },

  // 把项目 role 授给该项目的**登录用户**。两个名字都来自 SSOT(`project-schema.ts`),
  // 语句里**没有任何字面量** ⇒ 产物进审计完全安全,这正是它能留在模板里、
  // 而 `CREATE USER … PASSWORD '…'` 不能的原因(见 `admin-ddl-request.ts` 同名分支的说明)。
  "grant-role-to-login": (req) => [
    brandStatement(
      `GRANT ROLE ${ident(projectRoleName(req.projectId))} TO ${ident(projectDbUserName(req.projectId))}`
    ),
  ],

  "drop-project-schema": (req, ctx) => {
    const schema = schemaOf(ctx, req.projectId);
    // 🔴 CASCADE 是删项目回收的既有语义(52 §3.9);approvalId / bindings=0 / draining 的前置
    // 由执行器在生成模板**之前**校验(50 SPEC §3.9a 第 4 步),模板本身不做授权。
    return [brandStatement(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`)];
  },

  "dms-ingest-bootstrap": () => [
    // 现状(realtime/redshift-target.ts)是 `CREATE USER dms_ingest PASSWORD '<随机>' CREATEDB`
    // + `CREATE SCHEMA ... AUTHORIZATION dms_ingest`。
    // 🔴 口令**不进模板**:模板产物会进审计,口令绝不能落审计/日志。
    // 定案:用户创建与口令设置由执行器在函数内调 `CREATE USER ... PASSWORD` 的**参数化路径**完成
    // (交付);本模板只负责**幂等的 schema + 授权**部分,故 DMS bootstrap 功能保留、
    // 但口令那一段不经模板。
    brandStatement(`CREATE SCHEMA IF NOT EXISTS ${ident(DMS_INGEST_SCHEMA)} AUTHORIZATION ${ident(DMS_INGEST_USER)}`),
  ],

  // 🔴 改造(原来落 `shared.code_<id>`、列 `code/label/sort_order`,零生产调用方):
  //   落点走 `codeTableLandingFqn()`,建表语句**就是** home 落地用的那一条(`buildCodeTableCreateStatement`)
  //   ⇒ 列定义只有一个作者;home 建出来的表与非 home 建出来的表逐字节同构。
  //   🔴 见文件头:admin 通道只做**结构 + 权限**,不做数据写入(灌数由窄权 shared_writer 做)。
  "land-code-table": (req, ctx) => {
    const f = modelingLanding(ctx, { kind: "code-table", id: req.codeTableId });
    const o = ctx.modelingObject as { code: string };
    return [
      brandStatement(`CREATE SCHEMA IF NOT EXISTS ${ident(f.schema)}`),
      brandStatement(buildCodeTableCreateStatement(o.code, f.schema)),
      brandStatement(`COMMENT ON TABLE ${ident(f.schema)}.${ident(f.table)} IS ${literal(`code-table:${req.codeTableId}`)}`),
    ];
  },

  // (SPEC §3.9d.2)—— **逐表**授权给窄权写者。
  // 🔴 只有 USAGE(没有 CREATE)+ 这一张码表的四个 DML 权;**绝不** `ON ALL TABLES IN SCHEMA`
  //    (那会让它能写将来任何进这个 schema 的表 —— 枚举违规写法式的思路,漏的一定是第 N+1 张)。
  //    ⇒ 「admin 模板显式授过的那几张表」就是它能写的全集;负向判据因此可判。
  "grant-shared-writer": (req, ctx) => {
    const f = modelingLanding(ctx, { kind: "code-table", id: req.codeTableId });
    const w = ident(sharedWriterUserName());
    return [
      brandStatement(`GRANT USAGE ON SCHEMA ${ident(f.schema)} TO ${w}`),
      brandStatement(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${ident(f.schema)}.${ident(f.table)} TO ${w}`),
    ];
  },

  // (SPEC §3.9d.6)—— 维度/事实表建表(纯 DDL)。
  // 🔴 DDL **直接 brand `buildCreateTableStatements` 的产物**,绝不自己再拼(否则类型归一化 / 主键子句 /
  //    COMMENT 转义各一份 ⇒「home 建出来的表和非 home 不一样」,而两边各自看都是对的;对照判据钉它)。
  // 末尾两条 GRANT 是**只读**观测权:落地后要「再观测一次」(§3.8),而 information_schema 只列出当前用户
  //    有权的表 ⇒ 窄权写者对这张表**只有 SELECT**(没有任何写权;它不是这张表的写者)。
  "land-model-table": (req, ctx) => {
    const f = modelingLanding(ctx, { kind: "model-table", id: req.modelTableId });
    const o = ctx.modelingObject as { columns: import("@/lib/modeling/types").ModelColumn[] };
    const w = ident(sharedWriterUserName());
    return [
      ...buildCreateTableStatements({ schema: f.schema, physicalTable: f.table, columns: o.columns }).map(brandStatement),
      brandStatement(`GRANT USAGE ON SCHEMA ${ident(f.schema)} TO ${w}`),
      brandStatement(`GRANT SELECT ON ${ident(f.schema)}.${ident(f.table)} TO ${w}`),
    ];
  },

  // 图形化改表(非主控区)。语句**只**从台账上的 `pendingAlter` 计划生成
  //   (调用方 `lib/modeling/alter-service.ts` 先把计划写进台账再调执行器;home 路径用同一个 `buildAlterTableStatements`)。
  //   没有计划 / 空计划 ⇒ 抛(no-op 不许冒充 fail-closed)。DROP COLUMN 的不可逆确认在路由层(输入表名)。
  "alter-model-table": (req, ctx) => {
    const f = modelingLanding(ctx, { kind: "model-table", id: req.modelTableId });
    const o = ctx.modelingObject as { pendingAlter?: import("@/lib/modeling/alter").AlterPlan };
    if (!o.pendingAlter || isEmptyAlterPlan(o.pendingAlter)) {
      throw new Error(`modelTableId=${req.modelTableId} 的台账上没有待执行的改表计划(pendingAlter)⇒ 拒绝生成`);
    }
    return buildAlterTableStatements({ schema: f.schema, physicalTable: f.table, plan: o.pendingAlter }).map(brandStatement);
  },

  // 建模落地表的 DROP(强制重建 / 解绑并清理)。
  // 窄权写者刻意没有 DROP 权,所以这一步只能是 admin 模板;要删的表只来自台账(不收调用方的表名)。
  "drop-landed-table": (req, ctx) => {
    const f = modelingLanding(ctx, { kind: req.kind, id: req.objectId });
    return [brandStatement(`DROP TABLE IF EXISTS ${ident(f.schema)}.${ident(f.table)}`)];
  },

  // permission canary 的探针(④-3)。
  // 三张同名空表,各自的授权就是判据要测的东西:
  //   · `proj_<id>.bgp_canary` —— 授本项目 role **SELECT**(C-2 正控制:读自己的必须成功);
  //   · `shared.bgp_canary`    —— 授本项目 role **SELECT**(C-4 读 shared 成功;C-5 往里写必须被拒);
  //   · `bgp_canary_deny.bgp_canary` —— 🔴 **不授任何人**(C-3 读它必须 permission denied)。
  // 🔴 必须显式逐表 GRANT:`grant` 模板的 `ON ALL TABLES IN SCHEMA` 只覆盖**授权那一刻已存在**的表
  //    (② 第 11 行),探针表是后建的 ⇒ 不补这两条,C-2 / C-4 会因为「没授权」而红,判据就测错了东西。
  // 🔴 只建结构 + 只读授权:没有 INSERT / DELETE / DROP(表空着即可,`count(*)` 就是读)。
  "create-canary-probes": (req, ctx) => {
    const schema = schemaOf(ctx, req.projectId);
    const role = ident(projectRoleName(req.projectId));
    const t = ident(CANARY_TABLE);
    return [
      brandStatement(`CREATE SCHEMA IF NOT EXISTS ${ident(CANARY_DENY_SCHEMA)}`),
      brandStatement(`CREATE TABLE IF NOT EXISTS ${ident(CANARY_DENY_SCHEMA)}.${t} (probe INTEGER)`),
      brandStatement(`CREATE TABLE IF NOT EXISTS ${ident(SHARED_SCHEMA)}.${t} (probe INTEGER)`),
      brandStatement(`CREATE TABLE IF NOT EXISTS ${ident(schema)}.${t} (probe INTEGER)`),
      brandStatement(`GRANT SELECT ON ${ident(schema)}.${t} TO ROLE ${role}`),
      brandStatement(`GRANT SELECT ON ${ident(SHARED_SCHEMA)}.${t} TO ROLE ${role}`),
    ];
  },

  // 进 isolated 的前置(⑨-7)。
  // Redshift 默认给 PUBLIC 授 `CREATE ON SCHEMA public` ⇒ 不撤的话,项目身份照样能往 public 里建表,
  // 「新写入不再落 public」就只是约定。撤掉之后 C-6 才可能判 pass。
  // 🔴 这是**收紧**而不是放开;但它会让依赖「往 public 建表」的非 admin 身份当场报错 ⇒ 只由管理员显式触发
  //    (canary 路由的 revoke-public-create 动作,输 targetId 确认),绝不随供给 / canary 自动执行。
  "revoke-public-create": () => [brandStatement(`REVOKE CREATE ON SCHEMA ${ident("public")} FROM PUBLIC`)],
};

/**
 * 按 operation 生成语句。**这是获得 `GeneratedAdminStatement` 的唯一途径。**
 * 执行器只接受本函数的产物;任何"调用方自己拼的字符串"在类型层进不来。
 */
export function buildAdminDdlStatements(
  request: AdminDdlRequest,
  context: VerifiedAdminDdlContext
): GeneratedAdminStatement[] {
  const builder = builders[request.operation] as (
    r: AdminDdlRequest,
    c: VerifiedAdminDdlContext
  ) => GeneratedAdminStatement[];
  const out = builder(request, context);
  if (!out.length) {
    // 空模板意味着"这个 operation 什么也不做" —— 那正是拒绝清单第 6 条的 no-op 伪 fail-closed。
    throw new Error(`operation=${request.operation} 的模板产出为空(no-op 不允许冒充 fail-closed)`);
  }
  return out;
}

/** 供单测枚举:每个 operation 都必须有 builder(与 union 穷尽性互为双保险)。 */
export function registeredOperations(): string[] {
  return Object.keys(builders).sort();
}
