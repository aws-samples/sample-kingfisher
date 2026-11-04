// P3 event-driven push: when a sync runs, register source / S3 Tables / Redshift table
// entities in OpenMetadata and create cross-system, column-level lineage between them.
//
// Why this exists (vs. the scheduled ingestion connectors):
//  - The platform KNOWS the cross-system flow (source → S3 Tables → Redshift) and the
//    column mappings; connectors cannot derive that.
//  - S3 Tables (Iceberg) column schema is gated by Lake Formation for the ingestion role,
//    so the authoritative schema is pushed here from the source field mappings (LF-free).
//
// FQNs MUST match the ingestion connectors to avoid duplicate entities:
//   Redshift : bgp-redshift.<db>.<schema>.<table>
//   S3 Tables: bgp-s3tables.<bucket>.<namespace>.<table>
//   Source   : bgp-sources.<sourceDb>.default.<table>   (CustomDatabase; P2 may supersede)

import { omRequest, getEntityByName, isOmConfigured } from "./om-client";
// 四个写入原语搬到轻量层 `om-write.ts`(编译边界
// 元数据镜像是周期任务、跑在 instrumentation 的 edge 面上,不能经本文件的 genbi/athena 链碰 node:crypto)。
// 🔴 这里**再导出**是为了不动既有消费者的 import 路径(单一作者仍在 om-write)。
import { ensureService, customDbService, putDatabase, putSchema, putTable, omColumnNames } from "./om-write";
export { ensureService, customDbService, putDatabase, putSchema, putTable, omColumnNames } from "./om-write";
import type { DataSource } from "@/types/datasource";
import { parseSqlLineage, tableFqn, type TableRef } from "@/lib/lineage/sql-lineage";
import { introspectSchema } from "@/lib/genbi/schema";
import { sanitizeS3TablesIdentifier } from "@/lib/sync/s3tables-identifier";
import { resolveTargetTableName } from "@/lib/sync/target-naming";
import { syncOmCoords, type SyncOmPlace } from "@/lib/openmetadata/om-sync-coords";
import { OM_SERVICE_PREFIX, omServiceFor } from "@/lib/openmetadata/om-service";
// 数仓落点唯一出口(收编兜底字面量)。
import { homeWorkgroup, resolveWorkgroup } from "@/lib/redshift/warehouse-location";

// 三个基名从 service 维度的单一事实源取(值不变)。
//   🔴 这三个常量只剩**主控区口径**的消费者(主控区列回填 / 计算血缘);同步推送一律走 `syncOmCoords`。
const SRC_SERVICE = OM_SERVICE_PREFIX.sources;
const S3T_SERVICE = OM_SERVICE_PREFIX.s3tables;
const RS_SERVICE = OM_SERVICE_PREFIX.redshift;

// Create a service only if it does not already exist (avoid clobbering connector-owned services).
// Same create-if-absent semantics, but for storage / messaging services (different OM endpoints).
// Physical-endpoint enrichment uses these — a CustomStorage service holds Container nodes (RDS
// instance / S3 bucket / RS cluster) and a CustomMessaging service holds Topic nodes (Kinesis
// stream). ensureService above is hard-wired to databaseServices, so these must be separate.
async function ensureStorageService(name: string, payload: any) {
  const existing = await getEntityByName("services/storageServices", name);
  if (existing?.id) return;
  await omRequest("PUT", "/api/v1/services/storageServices", payload);
}
async function ensureMessagingService(name: string, payload: any) {
  const existing = await getEntityByName("services/messagingServices", name);
  if (existing?.id) return;
  await omRequest("PUT", "/api/v1/services/messagingServices", payload);
}

// 建/更新表实体。⚠️ 破坏性覆盖根治(列级血缘全局消失的直接元凶):OM 的 PUT /tables 是
// createOrUpdate,若无脑用空列的 `_row` 占位覆盖,会把此前 schema-sync 回填的【真实列冲回
// _row】。而列级血缘靠 omColumnNames(真实列)派生 identity —— 真实列被冲掉 → 列级退化为空。
// 全表同步(无 fieldMappings)重放 pushSyncToOpenMetadata 时正是空列,会反复破坏真实列。
// 根治:cols 为空时【先查 OM 是否已有真实列】,有则原样保留(不 PUT 覆盖);仅表不存在时才用
// _row 占位建壳。有真实列则照常写入。幂等、无破坏。
async function addLineage(fromFqn: string, toFqn: string, colPairs: { from: string; to: string }[]) {
  const from = await getEntityByName("tables", fromFqn);
  const to = await getEntityByName("tables", toFqn);
  if (!from?.id || !to?.id) return;
  const edge: any = { fromEntity: { id: from.id, type: "table" }, toEntity: { id: to.id, type: "table" } };
  const cols = (colPairs || []).filter((p) => p.from && p.to);
  // Preserve an existing sqlQuery on this edge (e.g. from a compute/SQL push) while we (re)write
  // the column mappings — symmetric with addSqlLineageEdge so push ordering never loses detail.
  const existing = await getEdgeDetails(from.id, to.id);
  const details: any = {};
  if (cols.length) {
    details.columnsLineage = cols.map((p) => ({ fromColumns: [`${fromFqn}.${p.from}`], toColumn: `${toFqn}.${p.to}` }));
  } else if (existing?.columnsLineage?.length) {
    details.columnsLineage = existing.columnsLineage; // don't wipe columns when this push has none
  }
  if (existing?.sqlQuery) details.sqlQuery = existing.sqlQuery;
  if (Object.keys(details).length) edge.lineageDetails = details;
  await omRequest("PUT", "/api/v1/lineage", { edge });
}

// Read an OM table's real column names, dropping the "_row" placeholder that column-less stubs
// carry. Fast (single GET); used to derive identity mappings for full-table syncs without
// explicit fieldMappings. Returns [] if the entity is missing or only has the placeholder.
// Build column pairs for a table: prefer the task's explicit fieldMappings; otherwise fall back
// to identity mappings (source col -> same-named target col) derived from a real column list.
// Full-table syncs (no per-column UI step) thus still get column-level lineage.
function deriveColumnPairs(maps: any[], fallbackNames: string[]): { from: string; to: string }[] {
  const explicit = (maps || []).map((m) => ({ from: m.source, to: m.target })).filter((p) => p.from && p.to);
  if (explicit.length) return explicit;
  return (fallbackNames || []).map((n) => ({ from: n, to: n }));
}

/**
 * Push entities + cross-system column lineage for a sync task. Best-effort; never throws.
 *
 * 🔴 `place` 必填:坐标(service / 库 / schema / FQN)全部由 `syncOmCoords` 一处算出 ——
 *    主控区逐字节等于改动前;其它区落该区的 per-target service(登记 o4-REG 的交付)。
 */
export async function pushSyncToOpenMetadata(task: any, ds: DataSource, place: SyncOmPlace): Promise<void> {
  try {
    if (!isOmConfigured()) return;
    const tables: string[] = task.sourceTables || [];
    if (!tables.length) return;

    const c = syncOmCoords(task, ds, place);
    const { writeS3, writeRs } = c;

    // Services (create-if-absent so we never clobber connector-owned services)
    await ensureService(c.services.src, customDbService(c.services.src));
    if (writeS3) await ensureService(c.services.s3t, customDbService(c.services.s3t));
    if (writeRs) {
      // 主控区:沿用原来的 Redshift 型 service;其它区:与目录同步(om-mirror-push)同一个构造(CustomDatabase)——
      //   同一个 service 两个作者各建一种类型,谁先到谁赢 = 不确定性。
      await ensureService(
        c.services.rs,
        c.home
          ? {
              name: c.services.rs,
              serviceType: "Redshift",
              connection: { config: { type: "Redshift", scheme: "redshift+psycopg2", hostPort: `${c.workgroup}.redshift-serverless:5439`, username: "admin", database: c.rsDb } },
            }
          : customDbService(c.services.rs)
      );
    }

    // Databases + schemas
    await putDatabase(c.srcDb, c.services.src);
    await putSchema("default", `${c.services.src}.${c.srcDb}`);
    if (writeS3) { await putDatabase(c.bucket, c.services.s3t); await putSchema(c.namespace, `${c.services.s3t}.${c.bucket}`); }
    if (writeRs) { await putDatabase(c.rsDb, c.services.rs); await putSchema(c.rsSchema, `${c.services.rs}.${c.rsDb}`); }

    // For full-table syncs WITHOUT explicit fieldMappings, we still want column-level lineage.
    for (const t of c.tables) {
      const table = t.source;
      const maps: any[] = task.fieldMappings?.[table] || [];
      const srcCols = maps.map((m) => ({ name: m.source, type: m.sourceType }));
      const tgtCols = maps.map((m) => ({ name: m.target, type: m.targetType || m.sourceType }));

      // Bug#2:目标表实体名 = 真实物理表名(sanitize 后,坐标作者已算好);源实体保留【原始源表名】。
      const { srcFqn, s3Fqn, rsFqn, target: targetTable } = t;
      await putTable(table, c.srcSchemaFqn, srcCols);
      if (writeS3) await putTable(targetTable, c.s3SchemaFqn, tgtCols); // S3 Tables real schema from source (LF-free)
      if (writeRs) await putTable(targetTable, c.rsSchemaFqn, tgtCols);

      // Identity column names for full-table syncs with no explicit fieldMappings: derive from
      // whichever endpoint already has a REAL registered schema in OM (target Redshift first — it
      // gets real columns from the schema-sync backfill; else source). A fast OM GET, no Redshift
      // round-trip (inline introspection times out on Serverless cold-start).
      let fallbackNames: string[] = [];
      if (!maps.length) {
        fallbackNames = await omColumnNames(rsFqn);
        if (!fallbackNames.length) fallbackNames = await omColumnNames(srcFqn);
        if (!fallbackNames.length) fallbackNames = await omColumnNames(s3Fqn);
      }

      const pairs = deriveColumnPairs(maps, fallbackNames);
      if (writeS3 && writeRs) {
        await addLineage(srcFqn, s3Fqn, pairs);
        await addLineage(s3Fqn, rsFqn, pairs);
      } else if (writeS3) {
        await addLineage(srcFqn, s3Fqn, pairs);
      } else if (writeRs) {
        await addLineage(srcFqn, rsFqn, pairs);
      }
    }
    // Physical endpoints (RDS instance / S3 bucket / Redshift cluster) as upstream nodes of the
    // logical tables — best-effort, must not affect the column-lineage push above.
    await pushPhysicalEndpointsToOM(task, ds, place).catch(() => {});
  } catch (e) {
    // best-effort: metadata push must never break the sync run —— 但不许静默(落点不全 / OM 拒都要留痕)
    console.error("[om-push] 同步推送 OM 失败(target=%s):%s", place?.targetId, String((e as Error)?.message ?? e));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 物理端点富化 → OpenMetadata (2026-07-12)
//
// Why: 治理页血缘此前只有逻辑表节点(源表 / S3Table / Redshift 表)。用户要看到**物理存储/流
// 载体**——数据实际躺在哪台 RDS 实例、哪个 S3 桶、哪个 Redshift 集群、经哪条 Kinesis 流——挂在
// 对应逻辑表旁,一眼看清"逻辑表 ← 物理系统"。**只做物理存储/流节点,不做管道实体**
// (Glue/DMS/Flink pipeline)——用户明确拍板。
//
// 建模:物理节点用 OM 的 Container(存储)/ Topic(消息流)实体,而非 table:
//   · CustomStorage 服务 `bgp-physical` 下的 Container 表征 RDS 实例 / S3 桶 / Redshift 集群;
//   · CustomMessaging 服务 `bgp-streams` 下的 Topic 表征 Kinesis 流(Flink CDC 路径)。
// 服务名刻意与逻辑侧(bgp-sources / bgp-s3tables / bgp-redshift)不同前缀,避免撞实体。
// 血缘边方向:物理节点为逻辑表的**上游**([RDS]→源表 / [S3桶]→S3Table / [RS集群]→RS表)。
// 读侧 lineage/route.ts 的 fromOpenMetadata 天然把 container/topic 节点纳入 res.nodes(按
// fullyQualifiedName / id 通用解析),svcType 认服务前缀即出图标——已探针验证读回可行。
// best-effort、幂等(create-if-absent + PUT lineage 幂等),绝不抛断同步。
// ─────────────────────────────────────────────────────────────────────────────

const PHYS_STORAGE_SERVICE = OM_SERVICE_PREFIX.physical; // CustomStorage:RDS 实例 / S3 桶 / RS 集群
const PHYS_STREAM_SERVICE = "bgp-streams"; // CustomMessaging:Kinesis 流

const customStorageService = (name: string) => ({
  name,
  serviceType: "CustomStorage",
  connection: { config: { type: "CustomStorage", sourcePythonClass: "metadata.ingestion.source.storage.customstorage.CustomStorageSource" } },
});
const customMessagingService = (name: string) => ({
  name,
  serviceType: "CustomMessaging",
  connection: { config: { type: "CustomMessaging", sourcePythonClass: "metadata.ingestion.source.messaging.custommessaging.CustomMessagingSource" } },
});

// Sanitize an arbitrary identifier (host, bucket, workgroup, stream) into an OM entity name
// segment: OM names disallow "." (FQN separator) and a few specials; keep it readable.
function physName(raw: string): string {
  return (raw || "").trim().replace(/[.\s]+/g, "-").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128) || "unknown";
}

// Ensure a storageService exists, then create-if-absent a Container under it. Returns the
// container's id (needed to build the lineage edge) or null on any failure.
async function ensureContainer(service: string, name: string, displayName?: string): Promise<string | null> {
  const fqn = `${service}.${name}`;
  const existing = await getEntityByName("containers", fqn);
  if (existing?.id) return existing.id;
  const res = await omRequest("PUT", "/api/v1/containers", { name, service, displayName: displayName || name });
  if (res?.id) return res.id;
  // PUT may return empty body on some OM versions; re-read to get the id.
  const after = await getEntityByName("containers", fqn);
  return after?.id || null;
}

// Ensure a messagingService exists, then create-if-absent a Topic under it. Returns the topic id.
async function ensureTopic(service: string, name: string, displayName?: string): Promise<string | null> {
  const fqn = `${service}.${name}`;
  const existing = await getEntityByName("topics", fqn);
  if (existing?.id) return existing.id;
  const res = await omRequest("PUT", "/api/v1/topics", { name, service, displayName: displayName || name, partitions: 1 });
  if (res?.id) return res.id;
  const after = await getEntityByName("topics", fqn);
  return after?.id || null;
}

// PUT a lineage edge from a physical node (container/topic) to a logical table. The physical
// node is the UPSTREAM of the table. Idempotent (PUT createOrUpdate); no column mappings (a
// storage/stream carries the whole table, not per-column flow). Returns true if the edge was
// attempted (both endpoints resolved).
async function addPhysicalEdge(fromType: "container" | "topic", fromId: string, tableFqn: string): Promise<boolean> {
  const to = await getEntityByName("tables", tableFqn);
  if (!to?.id || !fromId) return false;
  await omRequest("PUT", "/api/v1/lineage", {
    edge: { fromEntity: { id: fromId, type: fromType }, toEntity: { id: to.id, type: "table" } },
  });
  return true;
}

/**
 * Enrich a sync task's lineage with PHYSICAL endpoint nodes in OpenMetadata:
 *   · source RDS instance  (Container)  → source logical table
 *   · S3 Tables bucket      (Container)  → S3Table logical table   (when target writes S3)
 *   · Redshift cluster      (Container)  → Redshift logical table  (when target writes Redshift)
 * Best-effort; never throws. FQN conventions match pushSyncToOpenMetadata so the physical nodes
 * attach to the very tables that push created (no duplicate logical entities).
 */
export async function pushPhysicalEndpointsToOM(task: any, ds: DataSource, place: SyncOmPlace): Promise<void> {
  try {
    if (!isOmConfigured()) return;
    const tables: string[] = task.sourceTables || [];
    if (!tables.length) return;

    // 坐标同一作者(主控区逐字节不变;其它区落 per-target 的 bgp-physical-<slug>)
    const c = syncOmCoords(task, ds, place);
    const { writeS3, writeRs } = c;

    await ensureStorageService(c.services.physSrc, customStorageService(c.services.physSrc));
    if (c.services.physTgt !== c.services.physSrc) {
      await ensureStorageService(c.services.physTgt, customStorageService(c.services.physTgt));
    }

    // One Container per physical system (shared across all this task's tables): the source RDS
    // instance (host), the S3 Tables bucket, the Redshift cluster (workgroup).
    const srcHostName = physName((ds.host || "").split(".")[0] || `rds-${c.srcDb}`);
    const rdsContainer = `rds-${srcHostName}`;
    const rdsId = await ensureContainer(c.services.physSrc, rdsContainer, `RDS: ${ds.host || c.srcDb}`);

    let s3Id: string | null = null, rsId: string | null = null;
    if (writeS3) s3Id = await ensureContainer(c.services.physTgt, `s3-${physName(c.bucket)}`, `S3 Tables 桶: ${c.bucket}`);
    if (writeRs) {
      rsId = await ensureContainer(c.services.physTgt, `rs-${physName(c.workgroup)}`, `Redshift 集群: ${c.workgroup}`);
    }

    for (const t of c.tables) {
      if (rdsId) await addPhysicalEdge("container", rdsId, t.srcFqn);
      if (writeS3 && s3Id) await addPhysicalEdge("container", s3Id, t.s3Fqn);
      if (writeRs && rsId) await addPhysicalEdge("container", rsId, t.rsFqn);
    }
  } catch {
    // best-effort: physical-endpoint enrichment must never break the sync run
  }
}


/**
 * P2: register a data source's schema (database / tables / columns) in OpenMetadata at
 * creation time, under the SAME `bgp-sources` CustomDatabase service and FQN convention
 * (`bgp-sources.<db>.default.<table>`) used by the sync-time push above. Keeping one
 * service/FQN means the source is visible in the governance catalog immediately AND no
 * duplicate entities are created (and the P3 cross-system lineage keeps resolving).
 * Best-effort; never throws (must not break data-source creation).
 */
export async function pushDataSourceToOpenMetadata(
  ds: { database?: string },
  tables: { name: string; columns?: { name: string; type?: string }[] }[],
  // 🔴 必填:数据源的落点(`ownerTargetId`)。
  //   源表实体的 service 与同步推送同一个作者(`omServiceFor("sources", 源落点)`)⇒ 建源时推的表
  //   与之后同步推的源表是**同一个** OM 实体(否则非主控区的源在 OM 里一份在主控区 service 下、一份在该区下)。
  ownerTargetId: string
): Promise<void> {
  try {
    if (!isOmConfigured()) return;
    const srcDb = ds.database || "source";
    const service = omServiceFor("sources", ownerTargetId);

    // Service + database + default schema (create-if-absent, never clobber).
    await ensureService(service, customDbService(service));
    await putDatabase(srcDb, service);
    await putSchema("default", `${service}.${srcDb}`);

    const schemaFqn = `${service}.${srcDb}.default`;
    for (const t of tables || []) {
      if (!t?.name) continue;
      await putTable(t.name, schemaFqn, t.columns || []);
    }
  } catch {
    // best-effort: metadata registration must never break data-source creation
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// 修复 (v1.17.0): Redshift 真实列回填 OpenMetadata
//
// 背景：OM 采集连接器栈未部署，Redshift 表此前仅由事件推送/SQL 血缘解析建出"占位列"
// （单列 _row），导致治理目录「字段数」恒为 1。这里直接 introspect Redshift 真实 schema
// （information_schema.columns，统一 admin 身份）并 createOrUpdate 覆盖为真实列。
// 幂等、最佳努力；FQN 沿用 bgp-redshift.<db>.<schema>.<table> 不产生重复实体。
// ─────────────────────────────────────────────────────────────────────────────
export async function pushRedshiftSchemaToOpenMetadata(
  workgroup: string = homeWorkgroup(),
  database: string = process.env.REDSHIFT_DATABASE || "dev"
): Promise<{ tables: number; columns: number }> {
  if (!isOmConfigured()) return { tables: 0, columns: 0 };
  // 落点显式:OM 是唯一中心件、只 ingest 主控区(central.ts)⇒ 回填的是主控区数仓的列
  const { HOME_TARGET_ID } = await import("@/lib/exec-env/target-id");
  const tables = await introspectSchema(workgroup, database, { targetId: HOME_TARGET_ID, project: null }); // 平台级、只读主控区:显式无项目 // 失败会抛，由调用方处理

  await ensureService(RS_SERVICE, {
    name: RS_SERVICE,
    serviceType: "Redshift",
    connection: { config: { type: "Redshift", scheme: "redshift+psycopg2", hostPort: `${workgroup}.redshift-serverless:5439`, username: "admin", database: database.toLowerCase() } },
  });
  await putDatabase(database, RS_SERVICE);

  const ensuredSchema = new Set<string>();
  let colCount = 0;
  for (const t of tables) {
    const schemaFqn = `${RS_SERVICE}.${database}.${t.schema}`;
    if (!ensuredSchema.has(schemaFqn)) {
      ensuredSchema.add(schemaFqn);
      await putSchema(t.schema, `${RS_SERVICE}.${database}`);
    }
    // createOrUpdate：用真实列覆盖此前的占位列。
    await putTable(t.table, schemaFqn, t.columns.map((c) => ({ name: c.name, type: c.type })));
    colCount += t.columns.length;
  }
  return { tables: tables.length, columns: colCount };
}

// Register REAL S3 Tables (Iceberg) columns into OpenMetadata by introspecting the table bucket
// via Athena's information_schema (LF-free, authoritative). Parallels the Redshift backfill above.
// Replaces the "_row" placeholder so column-level lineage (sync + compute shared-column heuristic)
// has real column names to work with. Iterates ALL namespaces in the bucket (not just one) so it
// works regardless of namespace naming. Idempotent, FQN = bgp-s3tables.<bucket>.<namespace>.<table>.
// 不止平台表桶 —— 主控区**登记过的外部表桶**(客户自有)也进目录,每个桶一个 database(FQN 仍是 bgp-s3tables.<bucket>.<ns>.<table>)。
//   原来 `bucket` 形参只会是主控区平台表桶;现在落点由 resolveS3TablesPlaces(HOME) 给全,形参保留只为兼容旧调用方(传了也不再决定扫哪些桶)。
export async function pushS3TablesSchemaToOpenMetadata(
  _bucket: string = process.env.S3TABLES_BUCKET || "bgp-table-bucket"
): Promise<{ tables: number; columns: number }> {
  if (!isOmConfigured()) return { tables: 0, columns: 0 };
  const { introspectS3Tables } = await import("@/lib/genbi/athena");
  const { listNamespaceTree, resolveS3TablesPlaces } = await import("@/lib/athena/s3tables");
  const { HOME_TARGET_ID } = await import("@/lib/exec-env/target-id");

  // 🔴 落点显式写成主控区(原来靠「不传 = 主控区」)。:平台表桶 + 已登记外部表桶,逐桶扫。
  const places = await resolveS3TablesPlaces(HOME_TARGET_ID); // throws on failure; caller handles
  await ensureService(S3T_SERVICE, customDbService(S3T_SERVICE));

  let tableCount = 0, colCount = 0;
  for (const place of places) {
    const bucket = place.bucket;
    let tree: Awaited<ReturnType<typeof listNamespaceTree>>;
    try {
      tree = await listNamespaceTree(place);
    } catch (e) {
      // 外部桶列不出来(权限 / 被删)不该拖垮平台表桶那一份;平台表桶自己列不出来仍如实抛
      if (place.external) { console.warn(`[om-push] 外部表桶 ${bucket} 列命名空间失败,跳过:${String((e as Error)?.message || e)}`); continue; }
      throw e;
    }
    await putDatabase(bucket, S3T_SERVICE);
    for (const ns of tree) {
      if (!ns.tables?.length) continue;
      await putSchema(ns.namespace, `${S3T_SERVICE}.${bucket}`);
      const schemaFqn = `${S3T_SERVICE}.${bucket}.${ns.namespace}`;
      let cols: { table: string; columns: { name: string; type: string }[] }[] = [];
      try {
        // 🔴 目录引用按**这个桶**显式给(同名命名空间可能同时在平台桶与外部桶里,不许靠「按命名空间找桶」猜)
        cols = await introspectS3Tables(ns.namespace, { targetId: HOME_TARGET_ID, catalogRef: place.catalogRef });
      } catch {
        continue; // a namespace that fails introspection shouldn't block the others
      }
      for (const t of cols) {
        await putTable(t.table, schemaFqn, t.columns.map((c) => ({ name: c.name, type: c.type })));
        tableCount++;
        colCount += t.columns.length;
      }
    }
  }
  return { tables: tableCount, columns: colCount };
}


// ─────────────────────────────────────────────────────────────────────────────
// SQL 血缘自动解析 → OpenMetadata
//
// Parse Redshift SQL (ETL Redshift SQL jobs / saved Redshift tasks) into TABLE-level
// lineage and push it to OM (system-of-record), reusing the same Redshift service + FQN
// convention as sync/ingestion so the edges show up in the SAME governance lineage graph.
// Best-effort; never throws (metadata must not break the save path).
// ─────────────────────────────────────────────────────────────────────────────

export interface SqlLineagePipeline {
  resourceType: "etl-job" | "redshift-task";
  id: string;
  name?: string;
}

// Create a Redshift table entity ONLY if it doesn't already exist. Critical: we must never
// PUT (createOrUpdate) over an existing table, or we'd clobber the real columns pushed by the
// sync path / ingestion connectors with our column-less stub.
async function ensureTableIfAbsent(name: string, databaseSchema: string, fqn: string): Promise<void> {
  const existing = await getEntityByName("tables", fqn);
  if (existing?.id) return;
  await omRequest("PUT", "/api/v1/tables", {
    name,
    databaseSchema,
    tableType: "Regular",
    description: "自 SQL 血缘自动解析创建（占位表，列待采集/同步补全）",
    columns: [{ name: "_row", dataType: "STRING" }],
  });
}

// Read an existing edge's lineageDetails (columnsLineage / sqlQuery), or null if no edge yet.
// OM's PUT /lineage REPLACES an edge's details, so any caller adding only sqlQuery would wipe
// the column-level mappings a previous push wrote. We read-then-merge to preserve them.
async function getEdgeDetails(fromId: string, toId: string): Promise<any | null> {
  const res = await omRequest("GET", `/api/v1/lineage/getLineageEdge/${fromId}/${toId}`);
  return res?.edge || null;
}

// Add a table-level lineage edge carrying the originating SQL (OM LineageDetails.sqlQuery), plus
// optional column pairs (e.g. shared-column mappings for compute edges). Merges with any existing
// edge details so pushes never clobber column-level lineage a previous push wrote.
async function addSqlLineageEdge(
  fromFqn: string,
  toFqn: string,
  sqlQuery?: string,
  colPairs?: { from: string; to: string }[]
): Promise<void> {
  const from = await getEntityByName("tables", fromFqn);
  const to = await getEntityByName("tables", toFqn);
  if (!from?.id || !to?.id) return;
  const edge: any = { fromEntity: { id: from.id, type: "table" }, toEntity: { id: to.id, type: "table" } };
  const existing = await getEdgeDetails(from.id, to.id);
  const details: any = {};
  // columnsLineage: prefer freshly-supplied pairs, else preserve whatever was already on the edge.
  const newCols = (colPairs || []).filter((p) => p.from && p.to)
    .map((p) => ({ fromColumns: [`${fromFqn}.${p.from}`], toColumn: `${toFqn}.${p.to}` }));
  if (newCols.length) details.columnsLineage = newCols;
  else if (existing?.columnsLineage?.length) details.columnsLineage = existing.columnsLineage;
  if (sqlQuery) details.sqlQuery = sqlQuery.slice(0, 4000);
  else if (existing?.sqlQuery) details.sqlQuery = existing.sqlQuery;
  if (Object.keys(details).length) edge.lineageDetails = details;
  await omRequest("PUT", "/api/v1/lineage", { edge });
}

/**
 * Parse the given Redshift SQL and push the resulting table-level lineage to OpenMetadata.
 * Returns the number of edges pushed. Best-effort; never throws.
 */
export async function pushSqlLineageToOpenMetadata(opts: {
  sql: string;
  database?: string;
  schema?: string;
  pipeline?: SqlLineagePipeline;
}): Promise<{ edges: number } | void> {
  try {
    if (!isOmConfigured()) return;
    const parsed = parseSqlLineage(opts.sql, { database: opts.database, schema: opts.schema });
    if (!parsed.edges.length) return { edges: 0 };

    // Ensure the Redshift service exists (create-if-absent; never clobber connector-owned).
    await ensureService(RS_SERVICE, {
      name: RS_SERVICE,
      serviceType: "Redshift",
      connection: {
        config: {
          type: "Redshift",
          scheme: "redshift+psycopg2",
          hostPort: `${homeWorkgroup()}.redshift-serverless:5439`,
          username: "admin",
          database: (opts.database || "dev").toLowerCase(),
        },
      },
    });

    // Ensure every endpoint table's db/schema/table exist (create-if-absent).
    const endpoints = new Map<string, TableRef>();
    for (const e of parsed.edges) {
      endpoints.set(tableFqn(e.from), e.from);
      endpoints.set(tableFqn(e.to), e.to);
    }
    const ensuredDb = new Set<string>();
    const ensuredSchema = new Set<string>();
    for (const [fqn, ref] of Array.from(endpoints.entries())) {
      const dbFqn = `${RS_SERVICE}.${ref.database}`;
      if (!ensuredDb.has(dbFqn)) {
        ensuredDb.add(dbFqn);
        await putDatabase(ref.database, RS_SERVICE);
      }
      const schemaFqn = `${dbFqn}.${ref.schema}`;
      if (!ensuredSchema.has(schemaFqn)) {
        ensuredSchema.add(schemaFqn);
        await putSchema(ref.schema, dbFqn);
      }
      await ensureTableIfAbsent(ref.table, schemaFqn, fqn);
    }

    // Provenance comment so the OM lineage edge records which job/task produced it.
    const origin = opts.pipeline?.name
      ? `-- 来源: ${opts.pipeline.resourceType} 「${opts.pipeline.name}」(${opts.pipeline.id})`
      : "-- 来源: SQL 血缘自动解析";
    const sqlQuery = `${origin}\n${(opts.sql || "").trim()}`;

    for (const e of parsed.edges) {
      await addSqlLineageEdge(tableFqn(e.from), tableFqn(e.to), sqlQuery);
    }
    return { edges: parsed.edges.length };
  } catch {
    // best-effort: metadata push must never break the save path
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 计算血缘 → OpenMetadata (2026-07-08)
//
// Why: 治理页血缘图**主读 OM**(bgp-lineage 平台表仅作 OM 不可达时的回退)。此前计算血缘
// 只有 SQL 类任务(ETL/Redshift-SQL)经 pushSqlLineageToOpenMetadata 双写了 OM;**EMR / Flink
// 这两个非 SQL 引擎只写了平台表,没写 OM** → 所有 EMR/Flink 产出表(如 ads 层计算表)在治理页
// 血缘图里没有任何上游(已无头复现)。
//
// 本函数补齐:接收与 recordComputeLineage 同款的**非前缀** FQN inputs/outputs
// (redshift.<db>.<schema>.<table> / s3.<ns>.<table> / <src>.<db>.<table>),映射成 OM 的
// **带服务前缀** FQN,ensure 服务/库/schema/占位表存在,再逐条建血缘边。FQN 映射刻意对齐
// pushSyncToOpenMetadata 的约定(bgp-redshift / bgp-s3tables / bgp-sources),使计算节点能
// 连到同步已建的表实体,不产生重复实体。best-effort,绝不抛断计算作业。
// ─────────────────────────────────────────────────────────────────────────────

interface OmFqnResolved { fqn: string; service: string; database: string; schema: string; table: string; }

// 把非前缀计算 FQN 解析为 OM 带前缀 FQN + 各层级名(用于 ensure 库/schema/表)。无法识别返回 null。
function computeFqnToOm(raw: string): OmFqnResolved | null {
  const parts = (raw || "").split(".").filter(Boolean);
  if (parts.length < 2) return null;
  const head = parts[0].toLowerCase();
  if (head === "redshift") {
    // redshift.<db>.<schema>.<table>(缺 schema 时补 public)
    if (parts.length >= 4) {
      const [, database, schema, ...rest] = parts;
      const table = rest.join("_");
      return { fqn: `${RS_SERVICE}.${database}.${schema}.${table}`, service: RS_SERVICE, database, schema, table };
    }
    if (parts.length === 3) {
      const [, schema, table] = parts;
      const database = (process.env.REDSHIFT_DATABASE || "dev").toLowerCase();
      return { fqn: `${RS_SERVICE}.${database}.${schema}.${table}`, service: RS_SERVICE, database, schema, table };
    }
    return null;
  }
  if (head === "s3" || head === "s3tables") {
    // s3.<namespace>.<table> — bucket 用与 sync 侧一致的默认(env 可覆盖),让节点对齐同步已建实体。
    const bucket = process.env.S3TABLES_BUCKET || "bgp-table-bucket";
    if (parts.length >= 3) {
      const namespace = parts[1];
      const table = parts.slice(2).join("_");
      return { fqn: `${S3T_SERVICE}.${bucket}.${namespace}.${table}`, service: S3T_SERVICE, database: bucket, schema: namespace, table };
    }
    return null;
  }
  // 其它一律当作源库(mysql/postgresql/…): <src>.<db>.<table> → bgp-sources.<db>.default.<table>
  if (parts.length >= 3) {
    const database = parts[1];
    const table = parts.slice(2).join("_");
    return { fqn: `${SRC_SERVICE}.${database}.default.${table}`, service: SRC_SERVICE, database, schema: "default", table };
  }
  return null;
}

async function ensureOmTable(r: OmFqnResolved): Promise<void> {
  // 服务(create-if-absent,不 clobber 连接器建的服务)
  if (r.service === RS_SERVICE) {
    await ensureService(RS_SERVICE, {
      name: RS_SERVICE, serviceType: "Redshift",
      connection: { config: { type: "Redshift", scheme: "redshift+psycopg2", hostPort: `${homeWorkgroup()}.redshift-serverless:5439`, username: "admin", database: r.database } },
    });
  } else {
    await ensureService(r.service, customDbService(r.service));
  }
  await putDatabase(r.database, r.service);
  await putSchema(r.schema, `${r.service}.${r.database}`);
  await ensureTableIfAbsent(r.table, `${r.service}.${r.database}.${r.schema}`, r.fqn);
}

// 计算血缘的物理存储容器:按 endpoint 的 service 归到对应物理系统。命名与同步侧
// (pushPhysicalEndpointsToOM)对齐——RS 集群 / S3 桶 用默认 workgroup/bucket 名,使计算产出表
// 与同步表共享同一物理节点(不重复建)。SRC 计算源少见,用 database 名。
async function ensurePhysicalContainerForEndpoint(r: OmFqnResolved): Promise<string | null> {
  if (r.service === RS_SERVICE) {
    const wg = homeWorkgroup();
    return ensureContainer(PHYS_STORAGE_SERVICE, `rs-${physName(wg)}`, `Redshift 集群: ${wg}`);
  }
  if (r.service === S3T_SERVICE) {
    return ensureContainer(PHYS_STORAGE_SERVICE, `s3-${physName(r.database)}`, `S3 Tables 桶: ${r.database}`);
  }
  if (r.service === SRC_SERVICE) {
    return ensureContainer(PHYS_STORAGE_SERVICE, `rds-${physName(r.database)}`, `RDS: ${r.database}`);
  }
  return null;
}

/**
 * 把一批计算任务的 输入→输出 表级血缘推入 OpenMetadata。inputs/outputs 为非前缀 FQN
 * (与 recordComputeLineage 同款)。cross-join 每个 input→每个 output 建边。best-effort。
 * physicalStreams:Flink Kinesis 源作业的流名,挂成输出表上游的 Kinesis 流 Topic 物理节点。
 */
export async function pushComputeLineageToOM(opts: {
  inputs: string[];
  outputs: string[];
  engine?: string;
  taskName?: string;
  taskId?: string;
  physicalStreams?: string[];
}): Promise<{ edges: number } | void> {
  try {
    if (!isOmConfigured()) return;
    const ins = (opts.inputs || []).map(computeFqnToOm).filter(Boolean) as OmFqnResolved[];
    const outs = (opts.outputs || []).map(computeFqnToOm).filter(Boolean) as OmFqnResolved[];
    if (!ins.length || !outs.length) return { edges: 0 };

    // ensure 所有端点表(去重),再建边。
    const uniq = new Map<string, OmFqnResolved>();
    for (const r of [...ins, ...outs]) uniq.set(r.fqn, r);
    for (const r of Array.from(uniq.values())) await ensureOmTable(r);

    const origin = opts.taskName
      ? `-- 来源: ${opts.engine || "compute"} 「${opts.taskName}」${opts.taskId ? `(${opts.taskId})` : ""}`
      : `-- 来源: ${opts.engine || "compute"} 计算血缘自动采集`;

    // Column names per endpoint (from OM's registered schema), for shared-column mapping below.
    const colCache = new Map<string, string[]>();
    const colsOf = async (fqn: string): Promise<string[]> => {
      if (!colCache.has(fqn)) colCache.set(fqn, await omColumnNames(fqn));
      return colCache.get(fqn)!;
    };

    let edges = 0;
    for (const o of outs) {
      const outCols = new Set(await colsOf(o.fqn));
      for (const i of ins) {
        if (i.fqn === o.fqn) continue;
        // Shared-column heuristic: a same-named column on both endpoints is a real column-level
        // flow (dimension attributes / carried-through measures). Derived columns (ctr, roas…)
        // that don't share a name are simply omitted — we never fabricate a mapping.
        const inCols = await colsOf(i.fqn);
        const shared = inCols.filter((c) => outCols.has(c)).map((c) => ({ from: c, to: c }));
        await addSqlLineageEdge(i.fqn, o.fqn, origin, shared);
        edges++;
      }
    }

    // 物理端点富化(纯追加,best-effort):给每个 input/output 逻辑表挂对应物理存储容器
    // (RS 集群 / S3 桶 / RDS),让计算产出表(如 EMR ads 表、Flink 实时表)在治理页也能看到
    // 数据实际落在哪个物理系统。Flink Kinesis 源作业额外挂 Kinesis 流 Topic 为输出表上游。
    try {
      await ensureStorageService(PHYS_STORAGE_SERVICE, customStorageService(PHYS_STORAGE_SERVICE));
      const physCache = new Map<string, string | null>();
      const physFor = async (r: OmFqnResolved): Promise<string | null> => {
        if (!physCache.has(r.service)) physCache.set(r.service, await ensurePhysicalContainerForEndpoint(r));
        return physCache.get(r.service)!;
      };
      for (const r of [...ins, ...outs]) {
        const cid = await physFor(r);
        if (cid) await addPhysicalEdge("container", cid, r.fqn);
      }
      const streams = (opts.physicalStreams || []).filter(Boolean);
      if (streams.length && outs.length) {
        await ensureMessagingService(PHYS_STREAM_SERVICE, customMessagingService(PHYS_STREAM_SERVICE));
        for (const s of streams) {
          const tid = await ensureTopic(PHYS_STREAM_SERVICE, physName(s), `Kinesis 流: ${s}`);
          if (tid) for (const o of outs) await addPhysicalEdge("topic", tid, o.fqn);
        }
      }
    } catch { /* best-effort:物理端点富化不影响表级血缘 */ }

    return { edges };
  } catch {
    // best-effort: 血缘推送绝不影响计算作业提交/运行
  }
}
