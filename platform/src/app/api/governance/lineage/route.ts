export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { omRequest, isOmConfigured } from "@/lib/openmetadata/om-client";
import { omServiceBase } from "@/lib/openmetadata/om-service";
import { getLineage } from "@/lib/governance/lineage-service";
import { apiOk, apiError } from "@/lib/api-response";
// @kf-batch 50-WP4quater-reads(工单 SC-8)
import { scopedFqn, governanceTargetFrom } from "@/lib/governance/scoped-fqn";
import { requireAuth } from "@/lib/auth/verify-token";

// ─────────────────────────────────────────────────────────────────────────────
// P4: OpenMetadata is the system-of-record for lineage. We read OM's table lineage
// (cross-system source -> S3 Tables -> Redshift, with column-level mappings pushed
// by the platform on each sync run) and convert it to the {nodes, edges, centerNode}
// shape the governance page already renders with ReactFlow. The legacy DynamoDB
// `bgp-lineage` read is kept ONLY as a fallback when OM is unconfigured/unreachable.
// ─────────────────────────────────────────────────────────────────────────────

// FQN prefix (= OM service name) -> frontend icon/color key.
// Physical endpoints (bgp-physical CustomStorage containers / bgp-streams messaging topics,
// pushed by pushPhysicalEndpointsToOM) are sub-typed by the container name prefix so the UI can
// tell an RDS instance apart from an S3 bucket / Redshift cluster / Kinesis stream.
function svcType(fqn?: string): string {
  const parts = (fqn || "").split(".");
  // @kf-batch 50-o4REG-sync-om-per-target —— per-target service(`bgp-redshift-tgt-…` 等)按基名出图标(单一作者 omServiceBase)
  const svc = omServiceBase(parts[0]);
  switch (svc) {
    case "bgp-redshift": return "redshift";
    case "bgp-s3tables":
    case "bgp-s3": return "s3";
    case "bgp-glue": return "glue";
    case "bgp-sources": return "mysql";
    case "bgp-streams": return "kinesis"; // messaging topic = Kinesis stream
    case "bgp-physical": {
      // container FQN = "bgp-physical.<rds-*|s3-*|rs-*>"; sub-type by name prefix.
      const name = parts[1] || "";
      if (name.startsWith("rds-")) return "rds";
      if (name.startsWith("s3-")) return "s3bucket";
      if (name.startsWith("rs-")) return "rscluster";
      return "storage";
    }
    default: return svc;
  }
}

// A column FQN is "<tableFqn>.<column>"; the column name is the last segment.
const colName = (columnFqn?: string): string => (columnFqn || "").split(".").pop() || "";

// Resolve an OM edge endpoint to an FQN. Edges from /lineage/<type>/name/<fqn> carry
// entity ids (resolved via the entity+nodes map); be defensive if an embedded object
// is returned instead.
function resolveFqn(ref: any, idToFqn: Map<string, string>): string | undefined {
  if (!ref) return undefined;
  if (typeof ref === "string") return idToFqn.get(ref);
  return ref.fullyQualifiedName || (ref.id ? idToFqn.get(ref.id) : undefined);
}

async function fromOpenMetadata(fqn: string, depth: number) {
  const res = await omRequest(
    "GET",
    `/api/v1/lineage/table/name/${encodeURIComponent(fqn)}?upstreamDepth=${depth}&downstreamDepth=${depth}`
  );
  if (!res) return null; // OM error -> caller falls back

  // id -> fqn from the root entity + connected nodes
  const idToFqn = new Map<string, string>();
  const register = (e: any) => {
    if (e?.id && e?.fullyQualifiedName) idToFqn.set(e.id, e.fullyQualifiedName);
  };
  register(res.entity);
  (res.nodes || []).forEach(register);

  const nodesMap = new Map<string, { fqn: string; type: string }>();
  const addNode = (f?: string) => {
    if (f && !nodesMap.has(f)) nodesMap.set(f, { fqn: f, type: svcType(f) });
  };
  const centerFqn: string = res.entity?.fullyQualifiedName || fqn;
  addNode(centerFqn);
  (res.nodes || []).forEach((n: any) => addNode(n.fullyQualifiedName));

  const edges: { source: string; target: string; lineageType: string; columnMappings: { source: string; target: string }[] }[] = [];
  const seen = new Set<string>();
  const convert = (omEdge: any) => {
    const sFqn = resolveFqn(omEdge?.fromEntity, idToFqn);
    const tFqn = resolveFqn(omEdge?.toEntity, idToFqn);
    if (!sFqn || !tFqn) return;
    const key = `${sFqn}->${tFqn}`;
    if (seen.has(key)) return;
    seen.add(key);
    addNode(sFqn);
    addNode(tFqn);
    const cols: any[] = omEdge?.lineageDetails?.columnsLineage || [];
    const columnMappings = cols
      .flatMap((c) => (c.fromColumns || []).map((fc: string) => ({ source: colName(fc), target: colName(c.toColumn) })))
      .filter((m) => m.source && m.target);
    edges.push({ source: sFqn, target: tFqn, lineageType: "sync", columnMappings });
  };
  (res.upstreamEdges || []).forEach(convert);
  (res.downstreamEdges || []).forEach(convert);

  return { nodes: Array.from(nodesMap.values()), edges, centerNode: centerFqn };
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const fqn = req.nextUrl.searchParams.get("fqn");
  const depth = parseInt(req.nextUrl.searchParams.get("depth") || "2");
  if (!fqn) return apiError("缺少 fqn 参数");

  try {
    // Primary: OpenMetadata (system-of-record).
    if (isOmConfigured()) {
      const om = await fromOpenMetadata(fqn, depth);
      if (om) return apiOk(om);
    }
    // Fallback: legacy DynamoDB lineage (OM unconfigured or unreachable).
    // @kf-batch 50-WP4quater-reads(工单 SC-8)—— 🔴 DDB 血缘表的键是 (targetFqn, sourceFqn),
    // 两者都不含区 ⇒ 两个区的同名表被画成**同一个节点**。这里按区取键;
    // OM 那条主路径不需要(OM 的区维在 fqn 自带的 service 名里 —— 用户 2026-09-10 拍板
    // 「一个 OpenMetadata,哪个区 = service 维度」)。
    const lineage = await getLineage(scopedFqn(fqn, governanceTargetFrom(req.nextUrl.searchParams)), depth);
    return apiOk(lineage);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
