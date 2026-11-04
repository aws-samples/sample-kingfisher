// 模块 35 P1 — D3 维度/事实建模服务层。
//
// 维度表/事实表登记的 CRUD + 一键生成并应用 Redshift DDL + 血缘挂靠(归属分层/域)+ OM 推送。
// 沿用 P0「单逻辑分区 + ULID 排序键」。DDL 安全(类型白名单 + 标识符白名单 + 注释转义)在 ./redshift。
//
// 复用:docClient/TABLES、ulid、./redshift(DDL 生成/应用)、./service(setAssetBinding 血缘挂靠)、
// om-push(pushRedshiftSchemaToOpenMetadata,应用后把真实表推进治理目录,best-effort)。

import { PutCommand, QueryCommand, GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { buildCreateTableStatements, normalizeColumnType, safeIdent } from "./redshift";
// @kf-batch 50-WP11b-shared-writer —— 门②:建模产物必须落平台全局 schema(SPEC §3.9d.8)
import { assertPlatformGlobalSchema } from "./landing-fqn";
import { setAssetBinding } from "./service";
import { perTargetTruth } from "./landing-shared";
import type { ModelTable, ModelColumn } from "./types";

const MODELTABLE_PK = "modeltable";
const RS_SERVICE = "bgp-redshift"; // 与 sync/血缘/ingestion 一致的 OM Redshift 服务名
const RS_DATABASE = (process.env.REDSHIFT_DATABASE || "dev").toLowerCase();

const now = () => new Date().toISOString();
const str = (v: unknown) => (v == null ? "" : String(v)).trim();

// 维度/事实表的 OM/血缘 FQN:bgp-redshift.<db>.<schema>.<physicalTable>(小写,匹配采集约定)。
export function modelTableFqn(schema: string, physicalTable: string): string {
  return `${RS_SERVICE}.${RS_DATABASE}.${schema.toLowerCase()}.${physicalTable.toLowerCase()}`;
}

// ─── 校验 ──────────────────────────────────────────────────────────────────────
function normalizeColumns(raw: any): ModelColumn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c: any) => {
      const name = str(c?.name);
      if (!name) return null;
      safeIdent(name); // 列名白名单
      const dataType = str(c?.dataType) || "VARCHAR";
      // 提前校验类型(命不中白名单会抛),并保留用户原始类型串(应用时再规范化)。
      normalizeColumnType(dataType, { length: numOrU(c?.length), precision: numOrU(c?.precision), scale: numOrU(c?.scale) });
      const col: ModelColumn = {
        name,
        dataType,
        ...(numOrU(c?.length) != null ? { length: Number(c.length) } : {}),
        ...(numOrU(c?.precision) != null ? { precision: Number(c.precision) } : {}),
        ...(numOrU(c?.scale) != null ? { scale: Number(c.scale) } : {}),
        nullable: c?.nullable === false ? false : true,
        ...(c?.isPrimaryKey ? { isPrimaryKey: true } : {}),
        ...(str(c?.comment) ? { comment: str(c.comment) } : {}),
        ...(str(c?.standardId) ? { standardId: str(c.standardId) } : {}),
      };
      return col;
    })
    .filter(Boolean) as ModelColumn[];
}
const numOrU = (v: any) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

type ModelTableCore = Omit<ModelTable, "modelTableId" | "createdAt" | "updatedAt" | "createdBy" | "applied" | "appliedTable" | "appliedAt">;

function validateModelTable(input: any): ModelTableCore {
  const name = str(input.name);
  if (!name) throw new Error("缺少表名称");
  const tableType = input.tableType === "fact" ? "fact" : "dimension";
  const schema = str(input.schema);
  if (!schema) throw new Error("缺少目标 schema");
  safeIdent(schema);
  // @kf-batch 50-WP11b-shared-writer —— 🔴 这是建模里**唯一用户可填落点**的地方:不许填项目私有 schema。
  //   建模落地不受项目白名单约束(它没有项目维),换上的真门就是这里 + 落地路径上的同一个守卫;
  //   在定义时就拒,用户当场看到原因,而不是落地到某个区才失败。
  assertPlatformGlobalSchema(schema);
  const physicalTable = str(input.physicalTable);
  if (!physicalTable) throw new Error("缺少物理表名");
  safeIdent(physicalTable);
  const columns = normalizeColumns(input.columns);
  if (!columns.length) throw new Error("至少需要一个列");

  const core: ModelTableCore = {
    name,
    tableType,
    schema,
    physicalTable,
    columns,
    ...(str(input.layerId) ? { layerId: str(input.layerId) } : {}),
    ...(str(input.domainId) ? { domainId: str(input.domainId) } : {}),
    ...(str(input.description) ? { description: str(input.description) } : {}),
    // @kf-batch 50-SEQ47c-catalog-ddl —— 来源只认闭合清单;不传 = 建模页(读侧当 modeling)
    ...(input.origin === "catalog" || input.origin === "catalog-adopted" ? { origin: input.origin } : {}),
  };
  if (tableType === "dimension") {
    if (input.scdType === "SCD1" || input.scdType === "SCD2") core.scdType = input.scdType;
    if (str(input.businessKey)) core.businessKey = str(input.businessKey);
  } else {
    if (str(input.grain)) core.grain = str(input.grain);
    if (Array.isArray(input.dimensionRefs)) core.dimensionRefs = input.dimensionRefs.map((x: any) => str(x)).filter(Boolean);
    if (Array.isArray(input.measures)) core.measures = input.measures.map((x: any) => str(x)).filter(Boolean);
  }
  return core;
}

// ─── CRUD ──────────────────────────────────────────────────────────────────────
export async function listModelTables(): Promise<ModelTable[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({ TableName: TABLES.MODEL_TABLES, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": MODELTABLE_PK } })
  );
  return Items as ModelTable[];
}

// @kf-batch 50-SEQ47c-catalog-ddl —— 数据目录「修改表结构」按 (schema, 物理表名) 找台账行(小写比较;Redshift 标识符不区分大小写)。
export async function findModelTableByPhysical(schema: string, physicalTable: string): Promise<ModelTable | null> {
  const want = `${String(schema).toLowerCase()}.${String(physicalTable).toLowerCase()}`;
  const all = await listModelTables();
  return all.find((t) => `${String(t.schema).toLowerCase()}.${String(t.physicalTable).toLowerCase()}` === want) || null;
}

export async function getModelTable(modelTableId: string): Promise<ModelTable | null> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.MODEL_TABLES, Key: { pk: MODELTABLE_PK, modelTableId } }));
  return (Item as ModelTable) || null;
}

// 建表即写血缘归属(bgp-model-assets:fqn→layer/domain),best-effort 不阻断主存储。
async function bindAsset(t: ModelTable, actor?: string): Promise<void> {
  try {
    await setAssetBinding(
      { fqn: modelTableFqn(t.schema, t.physicalTable), kind: "table", layerId: t.layerId, domainId: t.domainId },
      actor
    );
  } catch {
    /* 归属写入失败不阻断 */
  }
}

export async function createModelTable(input: any, actor?: string): Promise<ModelTable> {
  const v = validateModelTable(input);
  const ts = now();
  const t: ModelTable & { pk: string } = { pk: MODELTABLE_PK, modelTableId: ulid(), ...v, applied: false, ...(actor ? { createdBy: actor } : {}), createdAt: ts, updatedAt: ts };
  await docClient.send(new PutCommand({ TableName: TABLES.MODEL_TABLES, Item: t }));
  await bindAsset(t, actor);
  return t;
}

export async function updateModelTable(modelTableId: string, patch: any, actor?: string): Promise<ModelTable | null> {
  const current = await getModelTable(modelTableId);
  if (!current) return null;
  const v = validateModelTable({ ...current, ...patch });
  // 若 schema/表名/列结构变更,已应用状态失效(需重新应用),但保留历史 appliedTable 供参考。
  const structChanged =
    v.schema !== current.schema || v.physicalTable !== current.physicalTable || JSON.stringify(v.columns) !== JSON.stringify(current.columns);
  const updated: ModelTable & { pk: string } = {
    pk: MODELTABLE_PK,
    modelTableId,
    ...v,
    applied: structChanged ? false : current.applied,
    ...(current.appliedTable ? { appliedTable: current.appliedTable } : {}),
    ...(current.appliedAt ? { appliedAt: current.appliedAt } : {}),
    // 🔴🔴 逐 target 真值原样带过 —— 与码表同一条(全量 Put 会抹掉另一个作者的属性)。
    // 详见 `service.ts` 同处注释:抹掉的后果是看板误报 + 残留被藏。
    ...perTargetTruth(current as unknown as Record<string, unknown>),
    createdBy: current.createdBy,
    createdAt: current.createdAt,
    updatedAt: now(),
  };
  await docClient.send(new PutCommand({ TableName: TABLES.MODEL_TABLES, Item: updated }));
  await bindAsset(updated, actor);
  return updated;
}

// @kf-batch 50-W5-seg1-WP11a
// 🔴 删定义**受控**(与码表同一条,见 `service.ts deleteCodeTable` 的说明):仍有落地产物 ⇒ 409 由用户决定;
//    确认串 = 物理表名(维度 / 事实表没有 code,表名就是它的身份)。
export async function deleteModelTable(
  modelTableId: string,
  opts: { keepTables?: boolean; confirm?: string | null } = {}
): Promise<{ keptTables: import("./unbind-shared").LandedArtifact[] }> {
  const t = await getModelTable(modelTableId);
  if (!t) return { keptTables: [] };
  const { assertDeletable } = await import("./unbind-shared");
  const keptTables = assertDeletable(t, { keepTables: opts.keepTables, confirm: opts.confirm, expectedConfirm: t.physicalTable });
  await docClient.send(new DeleteCommand({ TableName: TABLES.MODEL_TABLES, Key: { pk: MODELTABLE_PK, modelTableId } }));
  return { keptTables };
}

/** 解绑某个 target(可选连清理);编排见 `./unbind.ts`,这里只管维度 / 事实表的落点与 home 投影。 */
export async function unbindModelTable(
  modelTableId: string,
  // @kf-batch 50-WP11b-shared-writer —— `actor` 必填:非主控区的 DROP 走 admin 受控通道,要具名操作者
  opts: { targetId: string; cleanup: boolean; confirm?: string | null; actor: import("@/lib/exec-env/admin-ddl-executor").AuthenticatedActor | null }
): Promise<{ modelTable: ModelTable; dropped: boolean; table: string }> {
  const t = await getModelTable(modelTableId);
  if (!t) throw new Error("模型表不存在");
  const { bindingTargets } = await import("@/lib/exec-env/data-plane-target");
  const { HOME_TARGET_ID } = await import("@/lib/exec-env/target-id");
  const { performUnbind } = await import("./unbind");
  const { landedStateOf } = await import("./landing-shared");
  const defHash = await modelTableDefHash(t);
  const out = await performUnbind<ModelTable>({
    boundTargets: bindingTargets(t as { targets?: unknown }),
    landedByTarget: t.landedByTarget,
    targetId: opts.targetId,
    cleanup: opts.cleanup,
    confirm: opts.confirm,
    schema: t.schema,
    table: t.physicalTable,
    kind: "model-table",
    objectId: t.modelTableId,
    actor: opts.actor,
    save: async ({ targets, landedByTarget }) => {
      // 🔴 home 投影三字段重算,不从旧行 spread(同码表)
      const { applied: _a, appliedTable: _at, appliedAt: _aa, ...rest } = t as ModelTable & { pk?: string };
      void _a; void _at; void _aa;
      const homeRec = landedByTarget[HOME_TARGET_ID];
      const updated: ModelTable & { pk: string } = {
        ...(rest as ModelTable),
        pk: MODELTABLE_PK,
        targets,
        landedByTarget,
        applied: homeRec ? landedStateOf(homeRec, defHash) === "ok" : false,
        ...(homeRec?.table ? { appliedTable: homeRec.table } : {}),
        ...(homeRec?.at ? { appliedAt: homeRec.at } : {}),
        updatedAt: now(),
      };
      await docClient.send(new PutCommand({ TableName: TABLES.MODEL_TABLES, Item: updated }));
      return updated;
    },
  });
  return { modelTable: out.row, dropped: out.dropped, table: out.table };
}

/** 解绑弹窗的影响预览(与码表同形)。 */
export async function previewUnbindModelTable(
  modelTableId: string,
  targetId: string
): Promise<{ table: string; status: string | null; lastLandedAt: string | null; rowCountEstimate: number | null; bound: boolean }> {
  const t = await getModelTable(modelTableId);
  if (!t) throw new Error("模型表不存在");
  const { bindingTargets } = await import("@/lib/exec-env/data-plane-target");
  const rec = t.landedByTarget?.[targetId];
  let rowCountEstimate: number | null = null;
  if (rec && rec.status !== "credential-gap") {
    const { estimateRows } = await import("./landing");
    rowCountEstimate = await estimateRows(targetId, { schema: t.schema, table: t.physicalTable }).catch(() => null);
  }
  return {
    table: `${t.schema}.${t.physicalTable}`,
    status: rec?.status ?? null,
    lastLandedAt: rec?.at ?? null,
    rowCountEstimate,
    bound: bindingTargets(t as { targets?: unknown }).includes(targetId),
  };
}

// @kf-batch 50-P50.3-modeling
/** 当前定义哈希 + 物理落点(读侧判「版本不齐」用;算出来不落库,避免第二个真值源)。 */
export async function modelTableDefHash(t: Pick<ModelTable, "schema" | "physicalTable" | "columns">): Promise<string> {
  const { defHashOf, columnSignature, normalizeTypeName } = await import("./landing");
  const cols = columnSignature(
    (t.columns || []).map((c: any) => ({
      name: c.name,
      type: normalizeTypeName(normalizeColumnType(c.dataType, { length: c.length, precision: c.precision, scale: c.scale })),
    }))
  );
  return defHashOf({ schema: t.schema, table: t.physicalTable, cols });
}

export async function listModelTablesEnriched(): Promise<Array<ModelTable & { defHash: string; physicalTable2: string }>> {
  const rows = await listModelTables();
  return Promise.all(
    rows.map(async (t) => ({ ...t, defHash: await modelTableDefHash(t), physicalTable2: `${t.schema}.${t.physicalTable}` }))
  );
}

// ─── DDL 预览 / 应用 ─────────────────────────────────────────────────────────────
// 预览:返回 DDL 文本(分号+换行连接),不触达 Redshift。
export async function previewModelTableDDL(modelTableId: string): Promise<{ ddl: string; statements: string[] }> {
  const t = await getModelTable(modelTableId);
  if (!t) throw new Error("模型表不存在");
  const statements = buildCreateTableStatements({ schema: t.schema, physicalTable: t.physicalTable, columns: t.columns });
  return { ddl: statements.map((s) => `${s};`).join("\n\n"), statements };
}

// 应用:在 Redshift 建表 → 回写 applied 状态 → 重新挂血缘归属 → best-effort 推 OM(真实列)。
// @kf-batch 50-P50.3-modeling
// 🔴 **逐 target 物化 + 观测态回写**(轴A;与码表同一个作者 `lib/modeling/landing.ts`)。
// `applied`/`appliedTable`/`appliedAt` 降为 **home 那一格的投影**,只为读兼容。
export async function applyModelTableById(
  modelTableId: string,
  actor: string | undefined, // 血缘归属的 boundBy(与下面 opts.actor 那个 admin 主体是两件事)
  // @kf-batch 50-W5-seg2-WP10a —— `residencyActor`:落地前逐 target 写区域审计的行为主体(路由传用户;缺省平台服务主体)
  // @kf-batch 50-WP11b-shared-writer —— `actor`(**必填**,无默认):非主控区建表走 admin 受控通道(`land-model-table`)
  opts: {
    targets?: string[];
    force?: boolean;
    probeOnly?: boolean;
    residencyActor?: import("@/lib/exec-env/residency-audit").ResidencyActor;
    actor: import("@/lib/exec-env/admin-ddl-executor").AuthenticatedActor | null;
  }
): Promise<ModelTable> {
  const t = await getModelTable(modelTableId);
  if (!t) throw new Error("模型表不存在");
  const { landToTargets, defHashOf, landedStateOf, columnSignature, normalizeTypeName } = await import("./landing");
  const { bindingTargets } = await import("@/lib/exec-env/data-plane-target");
  const { HOME_TARGET_ID } = await import("@/lib/exec-env/target-id");

  // 🔴 期望列签名必须与**真正下发的 DDL** 同源:先过 `normalizeColumnType`(DDL 用的那个),
  //    再过 `normalizeTypeName`(观测侧用的那个)⇒ 两侧口径一致,不会每次观测都误报 drift。
  const expectedColumns = columnSignature(
    (t.columns || []).map((c: any) => ({
      name: c.name,
      type: normalizeTypeName(normalizeColumnType(c.dataType, { length: c.length, precision: c.precision, scale: c.scale })),
    }))
  );
  const defHash = defHashOf({ schema: t.schema, table: t.physicalTable, cols: expectedColumns });
  // 🔴🔴 同码表:本次落地的目标 ≠ 绑定。绑定**只增不减** —— 落地一个子集不许把别的区静默解绑
  //    (详见 `service.ts` 同处注释;任务侧 W3-b 早已明令「下发不许有改绑定的副作用」)。
  const bound = bindingTargets(t as { targets?: unknown });
  const landing = opts.targets?.length ? opts.targets : bound;
  const targets = Array.from(new Set([...bound, ...landing]));

  const statements = buildCreateTableStatements({ schema: t.schema, physicalTable: t.physicalTable, columns: t.columns });
  // @kf-batch 50-W5-seg2-WP10a —— 同码表:落地之前逐 target 写区域审计(entry=modeling-land);probeOnly 不审。
  if (!opts.probeOnly) {
    const { residencyAudit, auditActorOrService } = await import("@/lib/exec-env/residency-audit");
    for (const tid of landing) {
      await residencyAudit({ ...auditActorOrService(opts.residencyActor), targetId: tid, entry: "modeling-land", sqlText: statements.join(";\n") });
    }
  }

  const recs = await landToTargets({
    targets: landing,
    kind: "model-table",
    objectId: t.modelTableId,
    actor: opts.actor,
    schema: t.schema,
    table: t.physicalTable,
    expectedColumns,
    statements,
    // 维度/事实表是纯 DDL(一条 DML 都没有)⇒ 没有数据层;非主控区整张表由 admin 模板 `land-model-table` 建
    writeStatements: [],
    defHash,
    // 🔴 把**已有记录**传进去:只观测(probeOnly)时指纹要沿用上一条 ——
    //    否则点一下〔重新检测〕就能把「值改了但列结构没变」的表判成已落(假绿)。
    previous: (t as ModelTable).landedByTarget || null,
    ...(opts.force ? { force: true } : {}),
    ...(opts.probeOnly ? { probeOnly: true } : {}),
  });

  const ts = now();
  const merged = { ...((t as ModelTable).landedByTarget || {}), ...recs };
  const homeRec = merged[HOME_TARGET_ID];
  const updated: ModelTable & { pk: string } = {
    ...(t as ModelTable),
    pk: MODELTABLE_PK,
    targets,
    landedByTarget: merged,
    // 🔴 只有 home 真是 ok 才写 applied=true(drift/failed 绝不显示为已建)
    applied: homeRec ? landedStateOf(homeRec, defHash) === "ok" : (t as ModelTable).applied,
    ...(homeRec?.table ? { appliedTable: homeRec.table } : {}),
    ...(homeRec?.at ? { appliedAt: homeRec.at } : {}),
    updatedAt: ts,
  };
  await docClient.send(new PutCommand({ TableName: TABLES.MODEL_TABLES, Item: updated }));
  await bindAsset(updated, actor);
  // 应用后把新表(真实列)推进治理目录;best-effort,失败不影响应用结果。
  pushModelTableToOM().catch(() => {});
  return updated;
}

// best-effort 把 Redshift 真实 schema(含新建维度/事实表)推进 OpenMetadata 治理目录。
// 复用模块24 的 introspect+createOrUpdate(幂等,FQN 一致,不产生重复实体)。动态 import 避免循环依赖。
async function pushModelTableToOM(): Promise<void> {
  try {
    const { pushRedshiftSchemaToOpenMetadata } = await import("@/lib/openmetadata/om-push");
    await pushRedshiftSchemaToOpenMetadata();
  } catch {
    /* 治理目录推送失败不影响建表 */
  }
}
