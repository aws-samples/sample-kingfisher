// 数据目录「新建表」/「修改表结构」的服务端编排作者。
//
// 复用,不另起炉灶:
//   · Redshift 建表 = 在建模台账登记一条 `origin: "catalog"` 的模型表 + 走 `applyModelTableById`(与建模页同一条落地通道:
//     home 直建 / 非主控区 admin 执行器 `land-model-table`;区域审计 modeling-land;落地后再观测;best-effort 推治理目录)。
//   · Redshift 改表 = `lib/modeling/alter-service.ts`(台账里没有这张表 ⇒ 先按真实列**认领**成 `origin: "catalog-adopted"`)。
//   · S3 Tables 建表 = s3tables 控制面 `CreateTable`(Iceberg schema 由平台 DDL 白名单类型映射;**改表不提供**:
//     Iceberg 模式演进需要 Spark / Athena 引擎,Athena 对 s3tablescatalog 不支持 DDL ⇒ 如实在界面说明,不做假入口)。
//   · prod 环境(`x-bgp-env`)⇒ 路由层转审批单 type "ddl",批准时由 `executeApprovedDdl` 执行同一份编排。
import { CreateTableCommand, ListNamespacesCommand, CreateNamespaceCommand, ListTableBucketsCommand, type SchemaField } from "@aws-sdk/client-s3tables";
import { safeIdent, normalizeColumnType } from "@/lib/modeling/redshift";
import { assertPlatformGlobalSchema } from "@/lib/modeling/landing-fqn";
import { createModelTable, applyModelTableById, findModelTableByPhysical } from "@/lib/modeling/dimensions";
import { queryOnTarget } from "@/lib/modeling/landing";
import { alterModelTable, type AlterOutcome } from "@/lib/modeling/alter-service";
import { planAlter, buildAlterTableStatements, modelColumnFromCatalog, type AlterAddColumn, type CatalogLiveColumn } from "@/lib/modeling/alter";
import type { ModelColumn } from "@/lib/modeling/types";
import type { LandedRecord } from "@/lib/modeling/landing-shared";
import type { AuthenticatedActor } from "@/lib/exec-env/admin-ddl-executor";
import type { ResidencyActor } from "@/lib/exec-env/residency-audit";
import { sanitizeS3TablesIdentifier } from "@/lib/sync/s3tables-identifier";

export const CATALOG_TABLE_KINDS = ["redshift", "s3tables"] as const;
export type CatalogTableKind = (typeof CATALOG_TABLE_KINDS)[number];

/** 审批单类型(prod 环境的建表 / 改表);批准 ⇒ `executeApprovedDdl`。 */
export const DDL_APPROVAL_TYPE = "ddl" as const;

export interface CatalogCreateSpec {
  kind: CatalogTableKind;
  targetId: string;
  /** Redshift:schema;S3 Tables:namespace */
  schema: string;
  table: string;
  columns: AlterAddColumn[];
  comment?: string;
}

export class CatalogDdlInvalid extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "CatalogDdlInvalid";
  }
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function normalizeColumns(raw: unknown): AlterAddColumn[] {
  if (!Array.isArray(raw) || !raw.length) throw new CatalogDdlInvalid("至少需要一个列");
  const out: AlterAddColumn[] = [];
  for (const c of raw as Array<Record<string, unknown>>) {
    const name = str(c?.name);
    if (!name) throw new CatalogDdlInvalid("列名不能为空");
    const dataType = str(c?.dataType);
    if (!dataType) throw new CatalogDdlInvalid(`列 ${name} 缺少类型`);
    const num = (v: unknown) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
    const col: AlterAddColumn = { name, dataType, nullable: c?.nullable !== false };
    const length = num(c?.length);
    const precision = num(c?.precision);
    const scale = num(c?.scale);
    if (length !== undefined) col.length = length;
    if (precision !== undefined) col.precision = precision;
    if (scale !== undefined) col.scale = scale;
    if (c?.isPrimaryKey === true) col.isPrimaryKey = true;
    if (str(c?.comment)) col.comment = str(c?.comment);
    if (str(c?.defaultValue)) col.defaultValue = str(c?.defaultValue);
    out.push(col);
  }
  return out;
}

/** 入参闭合校验(两类都在这里拒,路由只负责 400 的形状)。 */
export function validateCreateSpec(raw: unknown): CatalogCreateSpec {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind = str(o.kind);
  if (!(CATALOG_TABLE_KINDS as readonly string[]).includes(kind)) throw new CatalogDdlInvalid(`kind 必须是 ${CATALOG_TABLE_KINDS.join(" / ")}`);
  const targetId = str(o.targetId);
  if (!targetId) throw new CatalogDdlInvalid("缺少执行区(targetId)");
  const schema = str(o.schema);
  const table = str(o.table);
  if (!schema) throw new CatalogDdlInvalid(kind === "redshift" ? "缺少目标 schema" : "缺少命名空间");
  if (!table) throw new CatalogDdlInvalid("缺少表名");
  const columns = normalizeColumns(o.columns);
  if (kind === "redshift") {
    safeIdent(schema);
    safeIdent(table);
    assertPlatformGlobalSchema(schema);
    for (const c of columns) {
      safeIdent(c.name);
      normalizeColumnType(c.dataType, { length: c.length, precision: c.precision, scale: c.scale });
    }
  } else {
    if (sanitizeS3TablesIdentifier(schema) !== schema) throw new CatalogDdlInvalid(`命名空间 ${schema} 不合法:只允许小写字母 / 数字 / 下划线,不以数字开头`);
    if (sanitizeS3TablesIdentifier(table) !== table) throw new CatalogDdlInvalid(`表名 ${table} 不合法:只允许小写字母 / 数字 / 下划线,不以数字开头`);
    icebergFieldsOf(columns); // 类型不在映射表里 ⇒ 抛
  }
  const seen = new Set<string>();
  for (const c of columns) {
    const k = c.name.toLowerCase();
    if (seen.has(k)) throw new CatalogDdlInvalid(`列名重复:${c.name}`);
    seen.add(k);
  }
  const comment = str(o.comment);
  return { kind: kind as CatalogTableKind, targetId, schema, table, columns, ...(comment ? { comment } : {}) };
}

/** 平台 DDL 白名单类型 ⇒ Iceberg 类型(S3 Tables CreateTable 的 schema)。SUPER 没有对应物 ⇒ 拒。 */
export function icebergTypeOf(c: Pick<ModelColumn, "dataType" | "length" | "precision" | "scale">): string {
  const normalized = normalizeColumnType(c.dataType, { length: c.length, precision: c.precision, scale: c.scale }); // 白名单 + 参数裁剪
  const base = normalized.replace(/\(.*\)$/, "").trim();
  const m = normalized.match(/\((\d+)(?:,(\d+))?\)/);
  switch (base) {
    case "VARCHAR":
    case "CHAR":
      return "string";
    case "INTEGER":
    case "SMALLINT":
      return "int";
    case "BIGINT":
      return "long";
    case "DECIMAL":
      return `decimal(${m ? m[1] : 18},${m && m[2] != null ? m[2] : 0})`;
    case "REAL":
      return "float";
    case "DOUBLE PRECISION":
      return "double";
    case "BOOLEAN":
      return "boolean";
    case "DATE":
      return "date";
    case "TIMESTAMP":
      return "timestamp";
    case "TIMESTAMPTZ":
      return "timestamptz";
    default:
      throw new CatalogDdlInvalid(`类型 ${normalized} 在 S3 Tables(Iceberg)上没有对应物,不能用于建表`);
  }
}

export function icebergFieldsOf(columns: readonly AlterAddColumn[]): SchemaField[] {
  return columns.map((c) => ({ name: c.name, type: icebergTypeOf(c), required: c.nullable === false }));
}

/** 预览(纯生成,不落库不打云)。 */
export async function previewCreate(spec: CatalogCreateSpec): Promise<{ statements?: string[]; icebergSchema?: { fields: SchemaField[] } }> {
  if (spec.kind === "redshift") {
    const { buildCreateTableStatements } = await import("@/lib/modeling/redshift");
    const statements = buildCreateTableStatements({ schema: spec.schema, physicalTable: spec.table, columns: spec.columns });
    if (spec.comment) statements.push(`COMMENT ON TABLE ${safeIdent(spec.schema)}.${safeIdent(spec.table)} IS ${quote(spec.comment)}`);
    return { statements };
  }
  return { icebergSchema: { fields: icebergFieldsOf(spec.columns) } };
}

function quote(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}

export interface CreateActorContext {
  username: string;
  actor: AuthenticatedActor | null;
  residencyActor?: ResidencyActor;
}

export interface RedshiftCreateResult {
  kind: "redshift";
  modelTableId: string;
  schema: string;
  table: string;
  database: string;
  landed: LandedRecord | undefined;
  statements: string[];
}

/** Redshift 建表:登记台账(origin catalog)→ 同建模页的落地通道 → 返回该 target 的观测态。 */
export async function createRedshiftCatalogTable(spec: CatalogCreateSpec, ctx: CreateActorContext): Promise<RedshiftCreateResult> {
  if (spec.kind !== "redshift") throw new CatalogDdlInvalid("kind 不是 redshift");
  const existing = await findModelTableByPhysical(spec.schema, spec.table);
  if (existing) throw new CatalogDdlInvalid(`建模台账里已有 ${spec.schema}.${spec.table}(${existing.name})—— 请在建模页对它「落地」,或换一个表名`);
  const { resolveRedshiftBinding } = await import("@/lib/exec-env/data-plane-target");
  const binding = await resolveRedshiftBinding({ targetId: spec.targetId });
  const t = await createModelTable(
    {
      name: spec.table,
      tableType: "dimension",
      schema: spec.schema,
      physicalTable: spec.table,
      columns: spec.columns.map(({ defaultValue: _d, ...c }) => c),
      ...(spec.comment ? { description: spec.comment } : {}),
      origin: "catalog",
      targets: [spec.targetId],
    },
    ctx.username
  );
  const applied = await applyModelTableById(t.modelTableId, ctx.username, {
    targets: [spec.targetId],
    actor: ctx.actor,
    ...(ctx.residencyActor ? { residencyActor: ctx.residencyActor } : {}),
  });
  const { buildCreateTableStatements } = await import("@/lib/modeling/redshift");
  const landed = applied.landedByTarget?.[spec.targetId];
  if (!landed || landed.status !== "ok") {
    throw new Error(`建表没有落成(${landed?.status ?? "无观测记录"}):${landed?.error ?? "该执行区上观测不到预期的列结构"};定义已登记在建模台账,可到建模页重试落地`);
  }
  if (spec.comment) {
    const { execOnBinding } = await import("@/lib/modeling/landing");
    // 表注释不在建模 DDL 作者的产物里(它只管列);home 顺手补一条(绑定自己说它是不是 home),非主控区的表注释随后续版本补(admin 模板闭合清单里没有它)
    if (binding.home) {
      await execOnBinding(binding, [`COMMENT ON TABLE ${safeIdent(spec.schema)}.${safeIdent(spec.table)} IS ${quote(spec.comment)}`]).catch(() => {});
    }
  }
  return {
    kind: "redshift",
    modelTableId: t.modelTableId,
    schema: spec.schema,
    table: spec.table,
    database: binding.database,
    landed,
    statements: buildCreateTableStatements({ schema: spec.schema, physicalTable: spec.table, columns: spec.columns }),
  };
}

export interface S3TablesCreateResult {
  kind: "s3tables";
  bucket: string;
  namespace: string;
  table: string;
  tableArn: string;
  fields: SchemaField[];
}

/** S3 Tables 建表:该 target 的表桶(资源袋实名)→ 命名空间幂等 → CreateTable(ICEBERG)。 */
export async function createS3Table(spec: CatalogCreateSpec): Promise<S3TablesCreateResult> {
  if (spec.kind !== "s3tables") throw new CatalogDdlInvalid("kind 不是 s3tables");
  const { resolveS3TablesPlace } = await import("@/lib/athena/s3tables");
  const { s3tablesClientFor } = await import("@/lib/exec-env/target-clients");
  const place = await resolveS3TablesPlace(spec.targetId);
  const client = await s3tablesClientFor(place.region);
  const { tableBuckets = [] } = await client.send(new ListTableBucketsCommand({}));
  const bucket = tableBuckets.find((b) => b.name === place.bucket);
  if (!bucket?.arn) throw new Error(`执行区 ${spec.targetId} 的表桶 ${place.bucket} 在 ${place.region} 找不到`);
  const { namespaces = [] } = await client.send(new ListNamespacesCommand({ tableBucketARN: bucket.arn, prefix: spec.schema }));
  if (!namespaces.some((n) => (n.namespace || []).includes(spec.schema))) {
    await client.send(new CreateNamespaceCommand({ tableBucketARN: bucket.arn, namespace: [spec.schema] }));
  }
  const fields = icebergFieldsOf(spec.columns);
  const res = await client.send(
    new CreateTableCommand({
      tableBucketARN: bucket.arn,
      namespace: spec.schema,
      name: spec.table,
      format: "ICEBERG",
      metadata: { iceberg: { schema: { fields } } },
    })
  );
  // 治理目录:主控区表桶走已有的 S3 Tables 推送(best-effort;非主控区由元数据镜像同步)
  if (place.home) {
    import("@/lib/openmetadata/om-push").then((m) => m.pushS3TablesSchemaToOpenMetadata()).catch(() => {});
  }
  return { kind: "s3tables", bucket: place.bucket, namespace: spec.schema, table: spec.table, tableArn: String(res.tableARN || ""), fields };
}

/** 读某 target 上一张 Redshift 表的真实列(svv_columns,含注释)。表不存在 ⇒ `exists: false`。 */
export async function readLiveColumns(targetId: string, schema: string, table: string): Promise<{ exists: boolean; columns: CatalogLiveColumn[]; database: string }> {
  safeIdent(schema);
  safeIdent(table);
  const { resolveRedshiftBinding } = await import("@/lib/exec-env/data-plane-target");
  const b = await resolveRedshiftBinding({ targetId });
  const s = schema.toLowerCase();
  const t = table.toLowerCase();
  const rows = await queryOnTarget(
    b,
    `SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, is_nullable, remarks ` +
      `FROM svv_columns WHERE table_schema = '${s}' AND table_name = '${t}' ORDER BY ordinal_position`
  );
  const num = (v: string) => (v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    exists: rows.length > 0,
    database: b.database,
    columns: rows.map((r) => ({
      name: r[0],
      dataType: r[1],
      length: num(r[2]),
      precision: num(r[3]),
      scale: num(r[4]),
      nullable: String(r[5]).toUpperCase() !== "NO",
      comment: r[6] || null,
    })),
  };
}

export interface AlterPlanningResult {
  modelTableId: string | null;
  adoptable: boolean;
  /** 不能图形化改表的原因(adoptable=false 时) */
  reason?: string;
  current: ModelColumn[];
  plan: ReturnType<typeof planAlter>["plan"];
  rejected: ReturnType<typeof planAlter>["rejected"];
  statements: string[];
}

/** 这张表现在能不能改、改什么(不落库不打云,除了读一次真实列)。 */
export async function planCatalogAlter(args: { targetId: string; schema: string; table: string; desired: AlterAddColumn[] }): Promise<AlterPlanningResult> {
  const existing = await findModelTableByPhysical(args.schema, args.table);
  let current: ModelColumn[];
  let adoptable = true;
  let reason: string | undefined;
  if (existing) {
    current = existing.columns || [];
  } else {
    try {
      assertPlatformGlobalSchema(args.schema);
    } catch (e) {
      adoptable = false;
      reason = String((e as Error)?.message ?? e);
    }
    const live = await readLiveColumns(args.targetId, args.schema, args.table);
    if (!live.exists) throw new CatalogDdlInvalid(`执行区 ${args.targetId} 上没有 ${args.schema}.${args.table}`);
    try {
      current = live.columns.map(modelColumnFromCatalog);
    } catch (e) {
      adoptable = false;
      reason = String((e as Error)?.message ?? e);
      current = [];
    }
  }
  const { plan, rejected } = planAlter(current, args.desired);
  const statements = adoptable ? buildAlterTableStatements({ schema: args.schema, physicalTable: args.table, plan }) : [];
  return { modelTableId: existing?.modelTableId ?? null, adoptable, ...(reason ? { reason } : {}), current, plan, rejected, statements };
}

/** 执行改表:台账里没有 ⇒ 先按真实列认领(origin catalog-adopted);然后走 alter-service。 */
export async function alterCatalogTable(
  args: { targetId: string; schema: string; table: string; desired: AlterAddColumn[]; confirmName?: string },
  ctx: CreateActorContext
): Promise<AlterOutcome> {
  let existing = await findModelTableByPhysical(args.schema, args.table);
  if (!existing) {
    assertPlatformGlobalSchema(args.schema);
    const live = await readLiveColumns(args.targetId, args.schema, args.table);
    if (!live.exists) throw new CatalogDdlInvalid(`执行区 ${args.targetId} 上没有 ${args.schema}.${args.table}`);
    const columns = live.columns.map(modelColumnFromCatalog);
    existing = await createModelTable(
      { name: args.table, tableType: "dimension", schema: args.schema, physicalTable: args.table, columns, origin: "catalog-adopted", targets: [args.targetId] },
      ctx.username
    );
  }
  return alterModelTable(existing.modelTableId, args.desired, {
    targetId: args.targetId,
    confirmName: args.confirmName,
    actor: ctx.actor,
    ...(ctx.residencyActor ? { residencyActor: ctx.residencyActor } : {}),
    username: ctx.username,
  });
}

/** 审批单 payload(prod 环境的建表 / 改表)。 */
export type DdlApprovalPayload =
  | { action: "create"; env: string; spec: CatalogCreateSpec }
  | { action: "alter"; env: string; targetId: string; schema: string; table: string; desired: AlterAddColumn[]; confirmName?: string };

export function isDdlApprovalPayload(v: unknown): v is DdlApprovalPayload {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return false;
  if (o.action === "create") return !!o.spec && typeof o.spec === "object";
  if (o.action === "alter") return typeof o.targetId === "string" && typeof o.schema === "string" && typeof o.table === "string" && Array.isArray(o.desired);
  return false;
}

/** 审批通过 ⇒ 由批准人的身份执行同一份编排(批准即确认:删列的 confirmName 已在申请时填好并随 payload 带来)。 */
export async function executeApprovedDdl(payload: DdlApprovalPayload, ctx: CreateActorContext): Promise<RedshiftCreateResult | S3TablesCreateResult | AlterOutcome> {
  if (payload.action === "create") {
    const spec = validateCreateSpec(payload.spec);
    return spec.kind === "redshift" ? createRedshiftCatalogTable(spec, ctx) : createS3Table(spec);
  }
  return alterCatalogTable({ targetId: payload.targetId, schema: payload.schema, table: payload.table, desired: normalizeColumns(payload.desired), confirmName: payload.confirmName }, ctx);
}

/** 路由层把 desired 列规范化(与建表共用同一套闭合校验)。 */
export function normalizeDesiredColumns(raw: unknown): AlterAddColumn[] {
  return normalizeColumns(raw);
}
