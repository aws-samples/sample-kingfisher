export const dynamic = "force-dynamic";
// @kf-batch 50-SEQ47c-catalog-ddl —— 数据目录「新建表」向导的 DDL 预览(纯生成:不落库、不打云;任一登录用户可看)。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireAuth } from "@/lib/auth/verify-token";
import { validateCreateSpec, previewCreate } from "@/lib/governance/catalog-ddl";
import { catalogDdlErrorResponse } from "@/lib/governance/catalog-ddl-http";

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  try {
    const body = await req.json().catch(() => ({}));
    const spec = validateCreateSpec(body);
    return apiOk({ spec, ...(await previewCreate(spec)) });
  } catch (e) {
    const r = catalogDdlErrorResponse(e);
    if (r) return r;
    return apiError(String((e as Error)?.message ?? e), 500);
  }
}
