import { PutCommand, QueryCommand, ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { parseSqlLineage, type TableRef } from "@/lib/lineage/sql-lineage";

const LINEAGE_TABLE = "bgp-lineage";

export interface LineageEdge {
  targetFqn: string;
  sourceFqn: string;
  lineageType: "sync" | "sql" | "manual";
  taskId?: string;
  columnMappings?: { source: string; target: string }[];
  createdAt: string;
}

// Generate lineage from sync task config
export async function generateSyncLineage(task: any, datasource: any) {
  const edges: LineageEdge[] = [];
  const now = new Date().toISOString();
  const sourcePrefix = `${datasource.type}.${datasource.database}`;

  for (const table of task.sourceTables || []) {
    // Source → S3
    if (task.targetType === "s3-tables" || task.targetType === "both") {
      const s3Fqn = `s3.${task.s3Config?.bucket || "datalake"}.${task.s3Config?.prefix || ""}${table}`;
      edges.push({
        targetFqn: s3Fqn, sourceFqn: `${sourcePrefix}.${table}`,
        lineageType: "sync", taskId: task.taskId,
        columnMappings: task.fieldMappings?.[table]?.filter((f: any) => f.include).map((f: any) => ({ source: f.source, target: f.target })),
        createdAt: now,
      });
    }

    // Source → Redshift (or S3 → Redshift)
    if (task.targetType === "redshift" || task.targetType === "both") {
      const schema = task.redshiftConfig?.schema || "public";
      const rsFqn = `redshift.${task.redshiftConfig?.database || "dev"}.${schema}.${table}`;
      const source = task.targetType === "both"
        ? `s3.${task.s3Config?.bucket || "datalake"}.${task.s3Config?.prefix || ""}${table}`
        : `${sourcePrefix}.${table}`;
      edges.push({
        targetFqn: rsFqn, sourceFqn: source,
        lineageType: "sync", taskId: task.taskId,
        columnMappings: task.fieldMappings?.[table]?.filter((f: any) => f.include).map((f: any) => ({ source: f.source, target: f.target })),
        createdAt: now,
      });

      // Also direct source → redshift if both
      if (task.targetType === "both") {
        edges.push({
          targetFqn: rsFqn, sourceFqn: `${sourcePrefix}.${table}`,
          lineageType: "sync", taskId: task.taskId, createdAt: now,
        });
      }
    }
  }

  // Save to DynamoDB
  for (const edge of edges) {
    try {
      await docClient.send(new PutCommand({ TableName: LINEAGE_TABLE, Item: edge }));
    } catch {}
  }

  return edges;
}

// ─────────────────────────────────────────────────────────────────────────────
// 模块 (2026-07-08) — 计算任务血缘采集 (compute lineage)
//
// Why: until now ONLY data-sync wrote platform lineage (generateSyncLineage). Compute jobs
// (EMR / Flink / ETL-Redshift-SQL / requirement-generated jobs) produced tables that were
// lineage ORPHANS in the governance graph — impact analysis and root-cause tracing were blind
// to them. This adds a SINGLE generic writer so every compute engine records its
// input→output table edges into the SAME `bgp-lineage` table the governance page already reads.
//
// Design (high-level, global-quality, purely additive):
//  - Does NOT touch generateSyncLineage / getLineage — the governance lineage page shows these
//    edges with ZERO frontend change.
//  - FQN convention MUST match the sync path + catalog fallback so compute nodes connect to
//    sync nodes: NON-prefixed  `redshift.<db>.<schema>.<table>` / `s3.<bucket>.<ns>.<table>` /
//    `<dsType>.<db>.<table>`. (This is intentionally different from the OM push path's
//    `bgp-redshift.*` convention in sql-lineage.tableFqn — that one is for OpenMetadata only.)
//  - SQL jobs: parse table-level edges via parseSqlLineage (Redshift dialect heuristic).
//  - Non-SQL jobs (PySpark etc.): caller passes explicit inputs[]→outputs[] full FQNs.
//  - Best-effort: never throws (metadata must not break a run/save path).
//
// lineageType is "sql" so the governance graph draws these as compute edges (green), distinct
// from sync (blue). Idempotent: (targetFqn, sourceFqn) is the table's composite key, so the
// same edge re-writes in place and never duplicates or clobbers a sync edge.
// ─────────────────────────────────────────────────────────────────────────────

/** Build a NON-prefixed Redshift FQN (matches sync + catalog fallback), from a parsed TableRef. */
function redshiftFqn(ref: TableRef): string {
  return `redshift.${ref.database}.${ref.schema}.${ref.table}`;
}

export interface RecordComputeLineageInput {
  /** SQL to parse for table-level edges (Redshift dialect). Optional if inputs/outputs given. */
  sql?: string;
  /** Explicit upstream table FQNs (for non-SQL engines, e.g. PySpark) — full FQNs, caller-built. */
  inputs?: string[];
  /** Explicit downstream/output table FQNs (for non-SQL engines) — full FQNs, caller-built. */
  outputs?: string[];
  /** Owning compute task/job id (stored on each edge for provenance). */
  taskId?: string;
  /** Engine label for logging only (emr / flink / etl-glue / etl-redshift / redshift-task …). */
  engine?: string;
  /** Defaults for unqualified SQL refs (Redshift db/schema). */
  database?: string;
  schema?: string;
}

/**
 * Record compute-task lineage into `bgp-lineage`. Two modes (may combine):
 *  1) SQL mode: parse `sql` → table-level from→to edges (Redshift FQN convention).
 *  2) Explicit mode: cross-join every `inputs[]` → every `outputs[]` (full FQNs as given).
 * Returns the edges written. Best-effort; never throws.
 */
export async function recordComputeLineage(input: RecordComputeLineageInput): Promise<LineageEdge[]> {
  const now = new Date().toISOString();
  const edges: LineageEdge[] = [];
  const seen = new Set<string>();
  const push = (sourceFqn: string, targetFqn: string) => {
    if (!sourceFqn || !targetFqn || sourceFqn === targetFqn) return;
    const key = `${sourceFqn}->${targetFqn}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ targetFqn, sourceFqn, lineageType: "sql", taskId: input.taskId, createdAt: now });
  };

  try {
    // 1) SQL-derived edges (table level). parseSqlLineage returns edges as { from, to } TableRefs.
    if (input.sql && input.sql.trim()) {
      const parsed = parseSqlLineage(input.sql, { database: input.database, schema: input.schema });
      for (const e of parsed.edges) push(redshiftFqn(e.from), redshiftFqn(e.to));
    }
    // 2) Explicit input→output edges (non-SQL engines). Full FQNs supplied by the caller.
    const ins = (input.inputs || []).filter(Boolean);
    const outs = (input.outputs || []).filter(Boolean);
    for (const o of outs) for (const i of ins) push(i, o);

    for (const edge of edges) {
      try {
        await docClient.send(new PutCommand({ TableName: LINEAGE_TABLE, Item: edge }));
      } catch { /* best-effort: one edge failing must not abort the rest */ }
    }
  } catch {
    // best-effort: lineage capture must never break the compute run/save path
  }
  return edges;
}

// 回填:把平台 bgp-lineage 里已有的**计算血缘**(lineageType="sql",EMR/Flink/SQL 计算产出)
// 重新推入 OpenMetadata。用于修复「治理页(主读 OM)看不到历史计算表上游」——那些边在双写
// 补齐前已写进平台表但没进 OM。按 targetFqn 分组(每个产出表的所有上游一起推),复用
// pushComputeLineageToOM(与实时双写同一函数)。幂等:OM 边重复 PUT 不会重复。返回统计。
export async function backfillComputeLineageToOM(): Promise<{ targets: number; edgesPushed: number }> {
  const { pushComputeLineageToOM } = await import("@/lib/openmetadata/om-push");
  const { Items = [] } = await docClient.send(new ScanCommand({ TableName: LINEAGE_TABLE }));
  // 只回填计算血缘(sql);同步血缘(sync)由 pushSyncToOpenMetadata 已负责,不重复。
  const compute = (Items as LineageEdge[]).filter((e) => e.lineageType === "sql");
  // 按 targetFqn 聚合上游。
  const byTarget = new Map<string, { inputs: Set<string>; taskId?: string }>();
  for (const e of compute) {
    if (!byTarget.has(e.targetFqn)) byTarget.set(e.targetFqn, { inputs: new Set(), taskId: e.taskId });
    byTarget.get(e.targetFqn)!.inputs.add(e.sourceFqn);
  }
  let edgesPushed = 0;
  for (const [targetFqn, { inputs, taskId }] of Array.from(byTarget.entries())) {
    const r = await pushComputeLineageToOM({
      inputs: Array.from(inputs),
      outputs: [targetFqn],
      engine: "backfill",
      taskId,
    });
    edgesPushed += (r && typeof r === "object" && "edges" in r) ? (r.edges || 0) : 0;
  }
  return { targets: byTarget.size, edgesPushed };
}

// 回填:重放所有同步任务的 pushSyncToOpenMetadata,让**同步血缘(source→S3→Redshift)的列级**
// 用 OM 当前【真实列】重新派生 identity 映射并补齐。根治「列级血缘全局消失」的时序缺陷:
// 首次同步推血缘时 OM 里表列还是 _row 占位 → identity 映射为空 → 列级退化;真实列 schema
// (pushRedshift/S3TablesSchemaToOpenMetadata)回填在其后,却不重推血缘 → 列级永久为空。
// 本函数在真实列就绪后重放一次同步血缘推送(pushSyncToOpenMetadata 内部第 197-214 行会用
// omColumnNames→deriveColumnPairs 重算列对),幂等(OM 边 merge-preserve,不丢 sqlQuery/既有列映射)。
// 与 backfillComputeLineageToOM 互补:那个补 compute 边(sql),这个补 sync 边。
export async function repushSyncLineageToOM(): Promise<{ tasks: number }> {
  const { pushSyncToOpenMetadata } = await import("@/lib/openmetadata/om-push");
  const { syncOmPlaceOf } = await import("@/lib/openmetadata/om-sync-coords");
  const USER_ID = "default-user"; // 与 sync/[id]/start 一致
  const { Items: tasks = [] } = await docClient.send(new ScanCommand({ TableName: TABLES.SYNC_TASKS }));
  let done = 0;
  const { bindingTargets } = await import("@/lib/exec-env/data-plane-target");
  const { isHome } = await import("@/lib/exec-env/target-id");
  for (const task of tasks as any[]) {
    try {
      // 🔴 与 sync/[id]/start 同一条不变量:**同步血缘只推 home**
      // (om-push 里的桶/workgroup 都是 home 口径,拿非 home 的任务重放会往 OM 写错区的 FQN)。
      // 兄弟路径必须一起守:运行期只 home 推、回填却全表重放 = 一样把错数据灌进去。
      if (!isHome(bindingTargets(task)[0])) continue;
      const { Item: ds } = await docClient.send(
        new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: task.datasourceId } })
      );
      if (!ds) continue;
      // 落点显式(本函数只重放主控区任务;坐标作者在 om-sync-coords)。
      //   源落点取数据源自己的章(存量无章 = 主控区,与 start 路由同一条理由)。
      const { datasourceOwnerTarget } = await import("@/lib/datasource/placement-shared");
      const owner = datasourceOwnerTarget(ds as Record<string, unknown>);
      const place = syncOmPlaceOf({ targetId: bindingTargets(task)[0], tableBucket: "" }, null, owner);
      await pushSyncToOpenMetadata(task, ds as any, place); // best-effort:内部已 try/catch,真实列就绪→补列级
      done++;
    } catch { /* best-effort:单个任务失败不阻断其余 */ }
  }
  return { tasks: done };
}

// Get lineage for a table (upstream + downstream)
export async function getLineage(fqn: string, depth = 2) {
  const nodes: Map<string, { fqn: string; type: string }> = new Map();
  const edges: { source: string; target: string; lineageType: string; columnMappings?: any[] }[] = [];

  const visited = new Set<string>();

  async function traceUpstream(targetFqn: string, d: number) {
    if (d <= 0 || visited.has(`up:${targetFqn}`)) return;
    visited.add(`up:${targetFqn}`);

    try {
      const { Items = [] } = await docClient.send(new QueryCommand({
        TableName: LINEAGE_TABLE,
        KeyConditionExpression: "targetFqn = :t",
        ExpressionAttributeValues: { ":t": targetFqn },
      }));

      for (const item of Items) {
        const srcFqn = item.sourceFqn as string;
        nodes.set(targetFqn, { fqn: targetFqn, type: targetFqn.split(".")[0] });
        nodes.set(srcFqn, { fqn: srcFqn, type: srcFqn.split(".")[0] });
        edges.push({ source: srcFqn, target: targetFqn, lineageType: item.lineageType, columnMappings: item.columnMappings });
        await traceUpstream(srcFqn, d - 1);
      }
    } catch {}
  }

  async function traceDownstream(sourceFqn: string, d: number) {
    if (d <= 0 || visited.has(`down:${sourceFqn}`)) return;
    visited.add(`down:${sourceFqn}`);

    try {
      // Scan for downstream (sourceFqn is not PK, need scan or GSI)
      const { Items = [] } = await docClient.send(new ScanCommand({
        TableName: LINEAGE_TABLE,
        FilterExpression: "sourceFqn = :s",
        ExpressionAttributeValues: { ":s": sourceFqn },
      }));

      for (const item of Items) {
        const tgtFqn = item.targetFqn as string;
        nodes.set(sourceFqn, { fqn: sourceFqn, type: sourceFqn.split(".")[0] });
        nodes.set(tgtFqn, { fqn: tgtFqn, type: tgtFqn.split(".")[0] });
        edges.push({ source: sourceFqn, target: tgtFqn, lineageType: item.lineageType, columnMappings: item.columnMappings });
        await traceDownstream(tgtFqn, d - 1);
      }
    } catch {}
  }

  await traceUpstream(fqn, depth);
  await traceDownstream(fqn, depth);
  nodes.set(fqn, { fqn, type: fqn.split(".")[0] });

  return {
    nodes: Array.from(nodes.values()),
    edges,
    centerNode: fqn,
  };
}
