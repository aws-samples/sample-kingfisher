export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { previewModelTableDDL } from "@/lib/modeling/dimensions";

// 模块 35 P1 D3: DDL 预览(登录可读;纯生成,不触达 Redshift)。
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  try {
    return apiOk(await previewModelTableDDL(params.id));
  } catch (e: any) {
    return apiError(e.message);
  }
}
