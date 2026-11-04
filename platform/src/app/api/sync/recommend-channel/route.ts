export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { recommendChannel } from "@/lib/sync/sync-service";
import { apiOk } from "@/lib/api-response";

export async function POST(req: NextRequest) {
  const { sourceType, targetType, syncMode } = await req.json();
  return apiOk(recommendChannel(sourceType || "mysql", targetType || "redshift", syncMode || "full"));
}
