export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { adoptFindings, type AdoptItem } from "@/lib/governance/sensitive/scan";
import { recordAudit } from "@/lib/audit";

// 模块 36 (E5): 采纳敏感识别建议 → 写入数据分级（仅平台管理员，与分级设置同权）。
//   POST {scanId, items:[{fqn, column, level?, category?, maskStrategy?}]}

export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可采纳敏感建议(写入分级)", 403);
  const body = await req.json().catch(() => ({}));
  if (!body?.scanId) return apiError("缺少 scanId");
  if (!Array.isArray(body?.items) || body.items.length === 0) return apiError("缺少待采纳的 items");
  const items: AdoptItem[] = body.items
    .filter((i: any) => i && i.fqn && i.column)
    .map((i: any) => ({
      fqn: String(i.fqn),
      column: String(i.column),
      level: i.level,
      category: i.category,
      maskStrategy: i.maskStrategy,
    }));
  if (!items.length) return apiError("items 需含 fqn 与 column");
  try {
    const result = await adoptFindings(body.scanId, items, identity.username);
    recordAudit(req, "sensitive.adopt", {
      resourceType: "sensitive-scan",
      resourceId: body.scanId,
      detail: { adopted: result.adopted, skipped: result.skipped.length },
    }).catch(() => {});
    return apiOk(result);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
