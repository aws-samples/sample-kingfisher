export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { seedGlobalBiSkills } from "@/lib/genbi/skills";
import { recordAudit } from "@/lib/audit";

// POST /api/genbi/skills/seed —— 一键预置 global 公共 BI 技能（排名/占比/趋势/环比/过滤，
// 数据仓库 Redshift + 数据湖 Athena 各一版）。**upsert**（不存在则建、已存在按 name 原地更新
// 描述/模板/参数）；仅平台管理员。改了 seed 定义(如技能描述)重跑即同步线上。
export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可预置公共技能", 403);
  try {
    const r = await seedGlobalBiSkills(identity.username);
    recordAudit(req, "genbi.skill.seed", { resourceType: "genbi-skill", detail: { created: r.created.length, updated: r.updated.length } }).catch(() => {});
    return apiOk({ ...r, createdCount: r.created.length, updatedCount: r.updated.length });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
