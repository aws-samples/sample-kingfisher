export const dynamic = "force-dynamic";
// GET /api/admin/exec-envs/[targetId] —— 单 target 详情(管理面 raw 口径,SPEC:241)。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { getTargetRaw, describeServiceability } from "@/lib/exec-env/registry";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { isControlPlaneRegionEnabled } from "@/lib/exec-env/control-plane-regions";

export async function GET(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  // targetId 来自 URL(外部输入):非法格式直接 400,不带着它去查库(§2.2 的入口校验惯例)。
  if (!isValidTargetId(params.targetId)) {
    return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  }
  try {
    const target = await getTargetRaw(params.targetId);
    if (!target) return apiError(`执行目标不存在:${params.targetId}`, 404, { code: "NOT_FOUND" });
    // 🔴 raw 口径**不变**(运维必须看到坏 item),额外附一段**只读**可服务性呈现:
    //    `status` 徽标是 生命周期×健康 的投影,**不含新鲜度与残留锁** ⇒ 会出现"徽标运行中、
    //    数据面其实一律拒收"。把数据面的拒因逐字摆到页面上,才不会再出现用户说的
    //    「最坏的不是不能用,是看不出为什么不能用」。判定与数据面**同一内核**,不是这里另算一遍。
    return apiOk({
      ...target,
      serviceability: describeServiceability(target, params.targetId),
      // 抽屉据此明示「控制面尚未放行该 region」+ 运维命令(init 段 I-4)
      controlPlaneRegionEnabled: isControlPlaneRegionEnabled(target.region),
    });
  } catch (e: unknown) {
    return apiError(`读取执行目标失败:${String((e as Error)?.message ?? e)}`, 500, { code: "INTERNAL" });
  }
}
