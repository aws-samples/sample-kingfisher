export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { omRequest, isOmConfigured } from "@/lib/openmetadata/om-client";
import { requireAuth } from "@/lib/auth/verify-token";
import { apiOk } from "@/lib/api-response";

// Surface OpenMetadata's data-quality + profiler results for the governance "数据质量" tab.
// Read-only; requires a valid Cognito token (same as the other governance read endpoints).
// Test cases are produced by the platform's demo data-quality suite and executed by the
// scheduled Redshift profiler task; table profiles are written by that same profiler.

// entityLink is "<#E::table::FQN>" or "<#E::table::FQN::columns::col>".
function parseEntityLink(link?: string): { table?: string; column?: string } {
  if (!link) return {};
  const parts = link.replace(/^<#E::/, "").replace(/>$/, "").split("::");
  const out: { table?: string; column?: string } = {};
  if (parts[0] === "table") out.table = parts[1];
  const ci = parts.indexOf("columns");
  if (ci >= 0) out.column = parts[ci + 1];
  return out;
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (!isOmConfigured()) return apiOk({ testCases: [], profiles: [] });

  // Data-quality test cases with their latest result.
  const tcRes = await omRequest(
    "GET",
    "/api/v1/dataQuality/testCases?fields=testDefinition,testCaseResult&limit=200&include=non-deleted"
  );
  const testCases = ((tcRes?.data as any[]) || []).map((t) => {
    const { table, column } = parseEntityLink(t.entityLink);
    return {
      name: t.name,
      table,
      column: column || null,
      testType: t.testDefinition?.name,
      status: t.testCaseResult?.testCaseStatus || "Queued",
      result: t.testCaseResult?.result || null,
      timestamp: t.testCaseResult?.timestamp ? new Date(t.testCaseResult.timestamp).toISOString() : null,
    };
  });

  // Table profiles (only tables that have been profiled).
  const tbRes = await omRequest("GET", "/api/v1/tables?fields=profile&limit=300&include=non-deleted");
  const profiles = ((tbRes?.data as any[]) || [])
    .filter((t) => t.profile)
    .map((t) => ({
      fqn: t.fullyQualifiedName,
      name: t.name,
      service: t.service?.name,
      rowCount: t.profile?.rowCount ?? null,
      columnCount: t.profile?.columnCount ?? null,
      profiledAt: t.profile?.timestamp ? new Date(t.profile.timestamp).toISOString() : null,
    }));

  return apiOk({ testCases, profiles });
}
