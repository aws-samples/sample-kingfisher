// G2R—— admin-DDL 的**结构化请求合同**(50 SPEC §3.9a v3.3,用户拍板 B)。
//
// ── 这个文件替换掉了什么 ──────────────────────────────────────────────────────
// v3.2 的公开签名是 `executeAdminDdl(targetId, { operation, statements: string[] })`,
// 靠事后 `assertGeneratedByTemplate(s, op)` 比对模板。外部审核 v2 P0-4 坐实这不成立:
//   ① 公开接口一旦收自由文本,**校验与执行之间就有替换空间**("检查 A、执行 B" 的 TOCTOU);
//   ② 而那套正则守卫本身实测可绕过 —— `'--'` 遮蔽后续语句、quoted identifier 的 `UPDATE`、
//      `DROP DATABASE`、跨项目 `GRANT`、`CALL` **五条全部放行**。
// ⇒ 定案:**公开接口只收结构化参数**,SQL 由模块私有模板生成,调用方拿不到也改不了。
//
// 🔴 **功能守恒**:7 个 operation **一个都不删**,SQL 编辑器等产品功能也不受影响 ——
// 取消的是「admin 权限下的自由 SQL」,不是产品的自由 SQL 功能(SQL 编辑器走 project-context 通道)。
//
// 🔴 **G2R 交付口径(拍板 C)**:本文件与模板、守卫都是**无副作用地基**,
// **生产调用 0 处、不改现网行为**;**P0-4 仍未关闭** —— 真关闭需闭合执行器 + 真实调用面迁移 + E2E。

import { assertTargetId } from "@/lib/exec-env/target-id";
import { assertProjectId } from "@/lib/exec-env/project-schema";

/**
 * 允许的 admin-DDL 操作。
 * 🔴 新增 operation 时,`TemplateBuilders` 的穷尽性检查会**强制**你补:模板 + RBAC + 审计分类 + 测试。
 */
export type AdminDdlOperation =
  | "create-project-schema"
  | "create-shared-schema"
  | "create-role"
  | "grant"
  // 见下方 `AdminDdlRequest` 里同名分支的说明。
  | "grant-role-to-login"
  | "drop-project-schema"
  | "dms-ingest-bootstrap"
  | "land-code-table"
  // 见下方 `AdminDdlRequest` 同名分支(SPEC §3.9d.4 / §3.9d.6)
  | "grant-shared-writer"
  | "land-model-table"
  // 见下方同名分支
  | "alter-model-table"
  | "drop-landed-table"
  // permission canary 的两条(④-3 / ⑨-7)
  | "create-canary-probes"
  | "revoke-public-create";

/**
 * 结构化请求。🔴 **刻意没有 `sql` / `statements` 字段** —— 类型层就不给传自由文本的口子。
 * 名称能从 SSOT 派生的(schema / role / table / FQN)一律不许调用方指定。
 */
export type AdminDdlRequest =
  | { operation: "create-project-schema"; targetId: string; projectId: string }
  | { operation: "create-shared-schema"; targetId: string }
  | { operation: "create-role"; targetId: string; projectId: string }
  | { operation: "grant"; targetId: string; projectId: string }
  // 🔴 **为什么新增的是这个 operation,而不是 `create-project-login`**:
  // Redshift 的 RBAC 是两件事 —— `CREATE USER`(带口令的登录主体)与
  // `GRANT ROLE <role> TO <user>`(把权限集合给它)。前者**必须带口令**,而
  // `admin-ddl-templates.ts` 早已定案:「口令**不进模板**:模板产物会进审计,
  // 口令绝不能落审计/日志」。我一度想给模板加 `create-project-login` + 把口令塞进
  // `VerifiedAdminDdlContext`,那与这条已定决策直接冲突,已撤销。
  // ⇒ 拆开:**建用户 + 设口令**走执行器的第二个公开入口 `provisionProjectLogin()`
  //   (语句由执行器私有 builder 产出、不铸 branded、不进审计明细);
  //   **纯权限语句**留在这里,产物里**没有任何字面量**,进审计完全安全。
  | { operation: "grant-role-to-login"; targetId: string; projectId: string }
  | { operation: "drop-project-schema"; targetId: string; projectId: string; approvalId: string }
  | { operation: "dms-ingest-bootstrap"; targetId: string }
  // 🔴 `land-code-table` 改成 **target 级**(原来带 projectId 且落 `shared.code_<id>`,零生产调用方):
  //    码表是平台全局的、没有项目维;落点由 SSOT `codeTableLandingFqn()` 派生(过渡期 = 现网 `public.dim_code_<code>`),
  //    列定义与 home 落地**同一个作者**(`buildCodeTableCreateStatement`)。只建结构,**不灌数**(§4.6)。
  | { operation: "land-code-table"; targetId: string; codeTableId: string }
  // 逐表授权给窄权写者:`USAGE ON SCHEMA`(无 CREATE)+ 这一张码表的 SELECT/INSERT/UPDATE/DELETE。
  // 🔴 绝不 `ON ALL TABLES IN SCHEMA` / `CREATE ON SCHEMA`(§3.9d.2:逐表授权是闭合式的)。
  | { operation: "grant-shared-writer"; targetId: string; codeTableId: string }
  // 维度/事实表建表(纯 DDL)。🔴 只收 modelTableId —— schema / 表名 / 列由执行器**服务端读台账**(§3.9d.6)。
  | { operation: "land-model-table"; targetId: string; modelTableId: string }
  // 图形化改表(非主控区)。🔴 同样只收 modelTableId:变更计划由执行器服务端读台账上的 `pendingAlter`
  //    (调用方先把计划写进台账再调执行器;模板从计划生成 ALTER / COMMENT 语句,与 home 路径同一个作者 `lib/modeling/alter.ts`)。
  | { operation: "alter-model-table"; targetId: string; modelTableId: string }
  // 建模落地表的 DROP(强制重建 / 解绑并清理)。合同漏了这一项:非 home 的 DROP 只有属主(admin)做得了,
  // 而窄权写者**刻意**没有 DROP 权⇒ 必须是 admin 模板。落点同样只来自台账。
  | { operation: "drop-landed-table"; targetId: string; kind: ModelingObjectKind; objectId: string }
  // 建 canary 探针:`proj_<id>.bgp_canary`(授本项目 role 只读)/ `shared.bgp_canary`(授本项目 role 只读)/
  // `bgp_canary_deny.bgp_canary`(**不授任何项目** ⇒ 单项目环境也能做跨项目负测)。纯 DDL + 只读授权,不写数据。
  | { operation: "create-canary-probes"; targetId: string; projectId: string }
  // 进 isolated 的前置(⑨-7):撤掉 Redshift 默认给 PUBLIC 的 `CREATE ON SCHEMA public`。target 级、只此一条。
  | { operation: "revoke-public-create"; targetId: string };

/** 建模落地对象的两类(各自来自哪本台账 = 它是哪一类;§3.9d.7(a) 成员资格守卫)。 */
export type ModelingObjectKind = "code-table" | "model-table";
export const MODELING_OBJECT_KINDS: readonly ModelingObjectKind[] = ["code-table", "model-table"] as const;

/**
 * 执行器第 2 步**服务端读台账**解析出的建模对象(模板只认它,不认 request 里的任何名字)。
 * 🔴 来源是 `getCodeTable` / `getModelTable` —— 查不到就在第 2 步拒(成员资格),走不到模板。
 */
export type ResolvedModelingObject =
  | { kind: "code-table"; codeTableId: string; code: string }
  | {
      kind: "model-table";
      modelTableId: string;
      schema: string;
      physicalTable: string;
      columns: import("@/lib/modeling/types").ModelColumn[];
      // 台账上的待执行改表计划(只有 alter-model-table 用得到;没有 ⇒ 模板拒绝生成)
      pendingAlter?: import("@/lib/modeling/alter").AlterPlan;
    };

/**
 * 模板产物的 **branded type**。
 *
 * 🔴 `ADMIN_DDL_BRAND` 用 `unique symbol` 且**不导出该 symbol** ⇒ 模块外无法**无意间**构造这个类型。
 * 执行器只接受 `GeneratedAdminStatement[]`。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 **v3.5 订正(外部审核 v3 P0-B):此前这里公开导出了 `brandStatement(sql: string)`** ——
 * 那等于给"类型层构造不出来"这句话开了一扇正门:**任何生产模块都能
 * `brandStatement("DROP DATABASE victim")` 铸出一条 branded 语句**(实测坐实)。
 * 未导出 `unique symbol` 完全抵消不了一个公开的 mint 函数。
 * ⇒ mint 函数已**移入 `admin-ddl-templates.ts` 并不再导出**(模板是唯一产出口)。
 *
 * 🔴 **同时如实说清这道边界的强度上限**:TypeScript 的 brand **永远挡不住显式 cast**
 * (`sql as unknown as GeneratedAdminStatement` 任何模块都写得出)。所以它是
 * **可 grep、可 lint 的约束**,不是不可绕过的安全边界 ——
 * `__tests__/admin-ddl-contract.test.ts` 有一条机械门禁扫全仓的越界 cast。
 * **真正的边界是 §3.9a 的闭合执行器**:凭证只在执行器内部取用、SQL 只由模板生成、
 * 调用方拿不到凭证也换不了 SQL。**在执行器落地前(P0-B 仍未关闭),不得声称这条边界已成立。**
 * ══════════════════════════════════════════════════════════════════════════════
 */
declare const ADMIN_DDL_BRAND: unique symbol;
export type GeneratedAdminStatement = string & { readonly [ADMIN_DDL_BRAND]: true };

/**
 * 执行器在校验后持有的上下文:**服务端解析并交叉验证过**的 target/project。
 * 刻意与 request 分开:提醒实现者"不能只信 request 里的 id"(50 SPEC §3.9a 第 2 步)。
 */
export interface VerifiedAdminDdlContext {
  targetId: string;
  /** 无项目维的 operation(create-shared-schema / dms-ingest-bootstrap)为 undefined */
  projectId?: string;
  /** 服务端解析出的 schema 名(不接受调用方指定) */
  projectSchemaName?: string;
  /** 该 target 的 credentialEpoch(§3.9b);进审计与缓存键 */
  credentialEpoch: number;
  /** 建模类 operation 的台账对象(服务端解析;其余 operation 为 undefined) */
  modelingObject?: ResolvedModelingObject;
}

export class AdminDdlRequestInvalid extends Error {
  constructor(
    readonly field: string,
    message: string
  ) {
    super(message);
    this.name = "AdminDdlRequestInvalid";
  }
}

const OPERATIONS: readonly AdminDdlOperation[] = [
  "create-project-schema",
  "create-shared-schema",
  "create-role",
  "grant",
  "grant-role-to-login",
  "drop-project-schema",
  "dms-ingest-bootstrap",
  "land-code-table",
  "grant-shared-writer",
  "land-model-table",
  "alter-model-table",
  "drop-landed-table",
  "create-canary-probes",
  "revoke-public-create",
] as const;

const OPERATION_SET: ReadonlySet<string> = new Set<string>(OPERATIONS);

/** 需要 projectId 的 operation(其余两个是 target 级)。 */
const NEEDS_PROJECT: ReadonlySet<string> = new Set<string>([
  "create-project-schema",
  "create-role",
  "grant",
  "grant-role-to-login",
  "drop-project-schema",
  "create-canary-probes",
]);

/** 码表 id 形态。与 projectId 一样必须校验:它会进模板的 WHERE/标识符旁。 */
const CODE_TABLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** 模型表 id 形态(平台生成 ULID;与码表 id 同一形态口径)。 */
const MODEL_TABLE_ID_RE = CODE_TABLE_ID_RE;
/** 审批单号形态(drop-project-schema 必须带)。 */
const APPROVAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * **运行时** schema 校验(不是 TypeScript 强转)。
 *
 * 🔴 为什么必须运行时校验:请求可能来自 HTTP body。外部审核 v2 P1-4 抓到我在 registry 里
 * 用 `as ExecutionTarget` 裸转 —— 同一个错误不能在这里重演。
 */
export function parseAdminDdlRequest(input: unknown): AdminDdlRequest {
  if (typeof input !== "object" || input === null) {
    throw new AdminDdlRequestInvalid("(root)", "admin-DDL 请求必须是对象");
  }
  const o = input as Record<string, unknown>;

  // 🔴 拒绝任何自由 SQL 字段 —— 出现即说明调用方还在按旧稿写,必须当场炸而不是忽略。
  for (const banned of ["sql", "statements", "statement", "ddl"]) {
    if (banned in o) {
      throw new AdminDdlRequestInvalid(
        banned,
        `admin-DDL 请求不接受自由 SQL 字段 \`${banned}\`(50 SPEC §3.9a v3.3):` +
          `SQL 由模块私有模板按 operation 生成,调用方只传结构化参数`
      );
    }
  }

  const operation = o.operation;
  if (typeof operation !== "string" || !OPERATION_SET.has(operation)) {
    throw new AdminDdlRequestInvalid(
      "operation",
      `未登记的 admin-DDL operation:${JSON.stringify(operation)};允许的是 ${OPERATIONS.join(" / ")}`
    );
  }

  let targetId: string;
  try {
    targetId = assertTargetId(o.targetId);
  } catch (e) {
    throw new AdminDdlRequestInvalid("targetId", (e as Error).message);
  }

  const needsProject = NEEDS_PROJECT.has(operation);
  let projectId: string | undefined;
  if (needsProject) {
    try {
      projectId = assertProjectId(o.projectId);
    } catch (e) {
      throw new AdminDdlRequestInvalid("projectId", (e as Error).message);
    }
  } else if (o.projectId !== undefined) {
    // 不是"忽略多余字段":target 级 operation 带 projectId 说明调用方对语义有误解,
    // 放过去会让审计里出现一个不参与判定的 projectId,后续排查被误导。
    throw new AdminDdlRequestInvalid("projectId", `operation=${operation} 是 target 级,不接受 projectId`);
  }

  if (operation === "drop-project-schema") {
    const approvalId = o.approvalId;
    if (typeof approvalId !== "string" || !APPROVAL_ID_RE.test(approvalId)) {
      throw new AdminDdlRequestInvalid(
        "approvalId",
        "drop-project-schema 必须带合法 approvalId(破坏性操作须有审批单号,50 ACCEPTANCE §8quinquies D-5)"
      );
    }
    return { operation, targetId, projectId: projectId as string, approvalId };
  }

  if (operation === "land-code-table" || operation === "grant-shared-writer") {
    const codeTableId = o.codeTableId;
    if (typeof codeTableId !== "string" || !CODE_TABLE_ID_RE.test(codeTableId)) {
      throw new AdminDdlRequestInvalid("codeTableId", `${operation} 必须带合法 codeTableId`);
    }
    return { operation, targetId, codeTableId };
  }

  // 与 land-model-table 同形:只收 modelTableId,计划在台账上
  if (operation === "alter-model-table") {
    const modelTableId = o.modelTableId;
    if (typeof modelTableId !== "string" || !MODEL_TABLE_ID_RE.test(modelTableId)) {
      throw new AdminDdlRequestInvalid("modelTableId", "alter-model-table 必须带合法 modelTableId");
    }
    for (const banned of ["schema", "table", "physicalTable", "columns", "plan", "pendingAlter", "sql", "statements", "statement", "ddl"]) {
      if (banned in o) {
        throw new AdminDdlRequestInvalid(banned, `alter-model-table 不接受 \`${banned}\`:落点、列与变更计划由执行器服务端读模型表台账`);
      }
    }
    return { operation, targetId, modelTableId };
  }
  if (operation === "land-model-table") {
    const modelTableId = o.modelTableId;
    if (typeof modelTableId !== "string" || !MODEL_TABLE_ID_RE.test(modelTableId)) {
      throw new AdminDdlRequestInvalid("modelTableId", "land-model-table 必须带合法 modelTableId");
    }
    // 🔴 调用方不许指定落点:出现即说明它在按「我告诉你建哪张表」的旧思路写(§3.9d.6 纪律 1)
    for (const banned of ["schema", "table", "physicalTable", "columns"]) {
      if (banned in o) {
        throw new AdminDdlRequestInvalid(banned, `land-model-table 不接受 \`${banned}\`:落点与列由执行器服务端读模型表台账`);
      }
    }
    return { operation, targetId, modelTableId };
  }

  if (operation === "drop-landed-table") {
    const kind = o.kind;
    if (typeof kind !== "string" || !(MODELING_OBJECT_KINDS as readonly string[]).includes(kind)) {
      throw new AdminDdlRequestInvalid("kind", `drop-landed-table 的 kind 只允许 ${MODELING_OBJECT_KINDS.join(" / ")}`);
    }
    const objectId = o.objectId;
    if (typeof objectId !== "string" || !CODE_TABLE_ID_RE.test(objectId)) {
      throw new AdminDdlRequestInvalid("objectId", "drop-landed-table 必须带合法 objectId");
    }
    for (const banned of ["schema", "table", "physicalTable"]) {
      if (banned in o) {
        throw new AdminDdlRequestInvalid(banned, `drop-landed-table 不接受 \`${banned}\`:要删的表只来自台账`);
      }
    }
    return { operation, targetId, kind: kind as ModelingObjectKind, objectId };
  }

  if (needsProject) {
    return { operation, targetId, projectId: projectId as string } as AdminDdlRequest;
  }
  return { operation, targetId } as AdminDdlRequest;
}

export { OPERATIONS as ADMIN_DDL_OPERATIONS };
