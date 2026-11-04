export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { parseSqlLineage } from "@/lib/lineage/sql-lineage";
import { apiOk, apiError } from "@/lib/api-response";
import { requireAuth } from "@/lib/auth/verify-token";

// parse-only preview. Parses Redshift SQL into table-level lineage WITHOUT touching
// OpenMetadata or any store — used by the 作业开发 page's「解析血缘」button.
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  try {
    const body = await req.json().catch(() => ({}));
    const sql: string = body?.sql || "";
    if (!sql.trim()) return apiError("缺少 sql");
    const result = parseSqlLineage(sql, { database: body?.database, schema: body?.schema });
    return apiOk(result);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
