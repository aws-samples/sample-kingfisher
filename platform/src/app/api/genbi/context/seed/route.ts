export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { seedGlobalContext } from "@/lib/genbi/context";
import { recordAudit } from "@/lib/audit";

// POST /api/genbi/context/seed —— 一键预置 global 通用业务口径/术语/规则(GMV、活跃用户、留存、
// 金额单位、时区、测试数据排除、软删除…,所有项目开箱即用)。**upsert**(不存在则建、已存在按
// kind+title 原地更新);仅平台管理员。改了种子定义重跑即同步线上。与 skills/seed 对称。
export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可预置公共业务口径", 403);
  try {
    const r = await seedGlobalContext(identity.username);
    recordAudit(req, "genbi.context.seed", { resourceType: "genbi-context", detail: { created: r.created.length, updated: r.updated.length } }).catch(() => {});
    return apiOk({ ...r, createdCount: r.created.length, updatedCount: r.updated.length });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
