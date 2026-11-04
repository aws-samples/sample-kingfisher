export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { mapAllColumns } from "@/lib/sync/sync-service";
import { apiOk } from "@/lib/api-response";

export async function POST(req: NextRequest) {
  const { sourceDb, columns } = await req.json();
  return apiOk(mapAllColumns(sourceDb || "mysql", columns || []));
}
