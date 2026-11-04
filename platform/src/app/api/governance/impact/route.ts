export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { omRequest, isOmConfigured } from "@/lib/openmetadata/om-client";
import { parseSqlLineage, tableFqn } from "@/lib/lineage/sql-lineage";
import { apiOk, apiError } from "@/lib/api-response";
import { omServiceBase } from "@/lib/openmetadata/om-service";
// @kf-batch 50-WP4quater-reads(工单 SC-8)
import { readScope, filterRowsByScope } from "@/lib/exec-env/scope";
import { requireAuth } from "@/lib/auth/verify-token";

// ─────────────────────────────────────────────────────────────────────────────
// 模块 17 (v1.8.0) 影响分析：给定一张表 FQN，沿 OpenMetadata 的 *下游* 血缘回答
//   ① 会影响哪些下游数据资产（含层级 depth）
//   ② 哪些 ETL/Redshift SQL 作业会受影响（reads = 直接消费被改表；writes = 产出受影响的下游表）
// 读 OM 为系统事实来源；作业富集 = 扫描 bgp-etl-jobs(redshift)+bgp-redshift-tasks 并现解析其 SQL。
// ─────────────────────────────────────────────────────────────────────────────

function svcType(fqn?: string): string {
  // @kf-batch 50-o4REG-sync-om-per-target —— per-target service 按基名出图标(单一作者 omServiceBase)
  const svc = omServiceBase((fqn || "").split(".")[0]);
  switch (svc) {
    case "bgp-redshift": return "redshift";
    case "bgp-s3tables":
    case "bgp-s3": return "s3";
    case "bgp-glue": return "glue";
    case "bgp-sources": return "mysql";
    default: return svc;
  }
}

function resolveFqn(ref: any, idToFqn: Map<string, string>): string | undefined {
  if (!ref) return undefined;
  if (typeof ref === "string") return idToFqn.get(ref);
  return ref.fullyQualifiedName || (ref.id ? idToFqn.get(ref.id) : undefined);
}

// Fetch DOWNSTREAM-only lineage from OM and shape it like the lineage API (nodes/edges).
async function downstreamFromOM(fqn: string, depth: number) {
  const res = await omRequest(
    "GET",
    `/api/v1/lineage/table/name/${encodeURIComponent(fqn)}?upstreamDepth=0&downstreamDepth=${depth}`
  );
  if (!res) return null;

  const idToFqn = new Map<string, string>();
  const register = (e: any) => { if (e?.id && e?.fullyQualifiedName) idToFqn.set(e.id, e.fullyQualifiedName); };
  register(res.entity);
  (res.nodes || []).forEach(register);

  const center: string = res.entity?.fullyQualifiedName || fqn;
  const nodes = new Map<string, { fqn: string; type: string }>();
  const addNode = (f?: string) => { if (f && !nodes.has(f)) nodes.set(f, { fqn: f, type: svcType(f) }); };
  addNode(center);
  (res.nodes || []).forEach((n: any) => addNode(n.fullyQualifiedName));

  const edges: { source: string; target: string; lineageType: string; columnMappings: any[] }[] = [];
  const seen = new Set<string>();
  for (const omEdge of res.downstreamEdges || []) {
    const s = resolveFqn(omEdge?.fromEntity, idToFqn);
    const t = resolveFqn(omEdge?.toEntity, idToFqn);
    if (!s || !t) continue;
    const k = `${s}->${t}`;
    if (seen.has(k)) continue;
    seen.add(k);
    addNode(s);
    addNode(t);
    edges.push({ source: s, target: t, lineageType: "downstream", columnMappings: [] });
  }
  return { center, nodes: Array.from(nodes.values()), edges };
}

// BFS downstream depth from center over the edge list.
function bfsDepth(center: string, edges: { source: string; target: string }[]): Record<string, number> {
  const adj: Record<string, string[]> = {};
  for (const e of edges) (adj[e.source] ||= []).push(e.target);
  const depthMap: Record<string, number> = { [center]: 0 };
  const queue = [center];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const nxt of adj[cur] || []) {
      if (!(nxt in depthMap)) { depthMap[nxt] = depthMap[cur] + 1; queue.push(nxt); }
    }
  }
  return depthMap;
}

interface JobSql { id: string; name: string; resourceType: "etl-job" | "redshift-task"; sql: string; database?: string   // @kf-batch 50-WP4quater-reads(工单 SC-8)—— 🔴 章必须带出来:不带的话下面按范围过滤
  // 会对每一行都返回 true(`bindingTargets` 读不到就回落主控区)⇒ 过滤恒等于不过滤,
  // 而判据看起来是绿的 —— 那正是「没有判别力的判据 = 空断言」。
  targets?: unknown;
}

async function scanSqlResources(): Promise<JobSql[]> {
  const out: JobSql[] = [];
  try {
    const { Items = [] } = await docClient.send(
      new ScanCommand({
        TableName: TABLES.ETL_JOBS,
        FilterExpression: "#t = :rt",
        ExpressionAttributeNames: { "#t": "type" },
        ExpressionAttributeValues: { ":rt": "redshift" },
      })
    );
    for (const it of Items) {
      if (it.script) out.push({ id: it.jobId, name: it.name || it.jobId, resourceType: "etl-job", sql: it.script, database: it.redshiftConfig?.database , targets: (it as { targets?: unknown }).targets });
    }
  } catch { /* table-less / no access: skip enrichment */ }
  try {
    const { Items = [] } = await docClient.send(new ScanCommand({ TableName: TABLES.REDSHIFT_TASKS }));
    for (const it of Items) {
      if (it.sql) out.push({ id: it.taskId, name: it.name || it.taskId, resourceType: "redshift-task", sql: it.sql, database: it.database , targets: (it as { targets?: unknown }).targets });
    }
  } catch { /* skip */ }
  return out;
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const fqn = req.nextUrl.searchParams.get("fqn");
  const depth = Math.min(parseInt(req.nextUrl.searchParams.get("depth") || "3"), 6);
  if (!fqn) return apiError("缺少 fqn 参数");

  try {
    const om = isOmConfigured() ? await downstreamFromOM(fqn, depth) : null;
    const center = om?.center || fqn;
    const nodes = om?.nodes || [{ fqn: center, type: svcType(center) }];
    const edges = om?.edges || [];

    const depthMap = bfsDepth(center, edges);
    const typeOf = new Map(nodes.map((n) => [n.fqn, n.type]));
    const impacted = Object.entries(depthMap)
      .filter(([f]) => f !== center)
      .map(([f, d]) => ({ fqn: f, depth: d, type: typeOf.get(f) || svcType(f) }))
      .sort((a, b) => a.depth - b.depth || a.fqn.localeCompare(b.fqn));

    // Affected jobs/tasks: parse each SQL resource's lineage and match against center / impacted set.
    const impactedSet = new Set(impacted.map((i) => i.fqn));
    // @kf-batch 50-WP4quater-reads(工单 SC-8)—— 🔴 「受影响的作业」按执行范围筛:
    // 改一张 us-west-2 的表,列出主控区的作业没有意义(它们读的是主控区那张同名表)。
    // 图本身(节点 / 边)的区维在 OM fqn 自带的 service 名里(用户 2026-09-10 拍板
    // 「一个 OpenMetadata,哪个区 = service 维度」)⇒ 这里只筛作业那一半。
    const allResources = await scanSqlResources();
    const scope = readScope(req);
    const resources = scope
      ? (filterRowsByScope(allResources as unknown as Array<Record<string, unknown>>, scope) as unknown as typeof allResources)
      : allResources;
    const jobs = resources
      .map((r) => {
        const parsed = parseSqlLineage(r.sql, { database: r.database });
        const srcFqns = new Set(parsed.sources.map(tableFqn));
        const tgtFqns = parsed.targets.map(tableFqn);
        const reads = srcFqns.has(center); // directly consumes the table being changed
        const writes = tgtFqns.some((f) => impactedSet.has(f)); // produces an impacted downstream table
        if (!reads && !writes) return null;
        return {
          id: r.id,
          name: r.name,
          resourceType: r.resourceType,
          role: reads && writes ? "reads+writes" : reads ? "reads" : "writes",
        };
      })
      .filter(Boolean);

    return apiOk({
      centerNode: center,
      nodes,
      edges,
      impacted,
      jobs,
      omAvailable: !!om,
    });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
