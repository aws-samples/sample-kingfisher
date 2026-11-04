export const dynamic = "force-dynamic";
// POST /api/admin/datasource-network-objects/cleanup { sgId, region, targetId }:把一个**孤儿**平台安全组交给该缺陷的持久清理作业。
//
// 服务端重新核三条件(是平台组 / 没有任何数据源行引用 / 网卡为 0),任一不满足 ⇒ 409 / 404 原话指路;过了才入队(幂等:同组已有作业回同一条)。
// 🔴 这里不 DeleteSecurityGroup:删除只由清理作业按网卡事实做。写审计(谁在什么时候对哪个组发起了清理)。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { recordAudit } from "@/lib/audit";
import { requestOrphanSgCleanup, NetworkObjectError } from "@/lib/datasource/network-objects";
// 落点只经点名作者 requestedTargetId(缺 / 非法 ⇒ 400,不默认主控区)
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";

export async function POST(req: NextRequest) {
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  const body = (await req.json().catch(() => ({}))) as { sgId?: unknown; region?: unknown; targetId?: unknown };
  const sgId = typeof body.sgId === "string" ? body.sgId.trim() : "";
  const region = typeof body.region === "string" ? body.region.trim() : "";
  let targetId: string;
  try { targetId = requestedTargetId(body.targetId, "清理数据源网络对象"); } catch (e) {
    const pr = placeErrorResponse(e);
    return pr ?? apiError(String((e as Error)?.message || e), 400, { code: "VALIDATION_FAILED" });
  }
  try {
    const r = await requestOrphanSgCleanup({ sgId, region, targetId, createdBy: identity.username });
    recordAudit(req, "datasource.network-object.cleanup-requested", {
      resourceType: "security-group", resourceId: sgId,
      detail: { region, targetId, jobId: r.jobId, created: r.created, phase: r.phase, datasourceId: r.datasourceId },
    }).catch(() => {});
    return apiOk(r, r.created ? 202 : 200);
  } catch (e) {
    if (e instanceof NetworkObjectError) {
      return apiError(e.message, e.status, { code: e.status === 404 ? "NOT_FOUND" : e.status === 409 ? "CONFLICT" : "VALIDATION_FAILED" });
    }
    return apiError((e as Error)?.message ?? String(e), 500);
  }
}
