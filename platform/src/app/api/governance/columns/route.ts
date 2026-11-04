export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { omRequest, isOmConfigured } from "@/lib/openmetadata/om-client";
import { apiOk, apiError } from "@/lib/api-response";
import { requireAuth } from "@/lib/auth/verify-token";
import { NextResponse } from "next/server";

// return a table's columns (name + type) from OpenMetadata, for the 数据分级 editor.
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const fqn = req.nextUrl.searchParams.get("fqn");
  if (!fqn) return apiError("缺少 fqn");
  if (!isOmConfigured()) return apiOk([]);
  try {
    const t = await omRequest("GET", `/api/v1/tables/name/${encodeURIComponent(fqn)}?fields=columns`);
    const columns = Array.isArray(t?.columns)
      ? t.columns.map((c: any) => ({ name: c.name, dataType: c.dataTypeDisplay || c.dataType }))
      : [];
    return apiOk(columns);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
