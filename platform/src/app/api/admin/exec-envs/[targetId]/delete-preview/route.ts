export const dynamic = "force-dynamic";
// @kf-batch 50-WP30-decommission
// GET /api/admin/exec-envs/[targetId]/delete-preview —— 删除前的影响预览(INTERACTION §1.4 机制 B;只读)。
// 绑定资源 / 启用调度 / 运行中 run 三个数(计数唯一作者 lib/exec-env/delete-impact.ts)+ 明细(给「去解绑」直达)
// + 将保留(不删)的数据资源清单 + `previewHash`(申请删除时带回,服务端重算比对)+ 当前在删除流程的哪一步。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { previewDelete } from "@/lib/exec-env/decommission";
import { decommissionErrorResponse } from "@/lib/exec-env/decommission-http";

export async function GET(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  if (!isValidTargetId(params.targetId)) return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  try {
    const res = apiOk(await previewDelete(params.targetId));
    // 预览就是「此刻」的真值:不许任何一层缓存(缓存的 0 会把一个刚绑上的作业放过去)
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (e) {
    return decommissionErrorResponse(e, "影响预览");
  }
}
