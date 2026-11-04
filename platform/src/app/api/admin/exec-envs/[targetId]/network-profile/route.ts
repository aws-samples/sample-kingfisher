// 🔴 **已下线**:POST /api/admin/exec-envs/[targetId]/network-profile(改网络规模 = 改 NAT 数)。
// 执行环境零出网(SPEC §3.16):NAT 恒为 0 ⇒ 没有可调的档。
// 处置口径同:回 **410** 而不是删路由。存量描述符里的 `networkProfile` 字段保留但不再有行为。
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-response";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { recordAudit } from "@/lib/audit";

export async function POST(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  // 🔴 守卫照旧走一遍:本路由已下线回 410,但「/api/admin/exec-envs 下每个 route 都过守卫」是
  //   纵深防御的普适约定(门禁 exec-env-routes-guard 逐文件钉)。给退役路由开豁免 = 在门禁上开口子,
  //   将来新加的路由也能借这个口子溜过去 —— 不值得为省两行去弱化一道普适门。
  const denied = await requireExecEnvAdmin(req);
  if (denied instanceof NextResponse) return denied;
  if (!isValidTargetId(params.targetId)) {
    return apiError("targetId 形态非法", 400, { code: "VALIDATION_FAILED" });
  }
  // 留审计:能看出还有谁在调这个退役端点(写类 route 必留审计,门禁钉)
  recordAudit(req, "exec-env.network-profile.retired", { resourceType: "exec-env", resourceId: params.targetId, detail: { retiredBy: "零出网" } }).catch(() => {});
  return apiError(
    "网络规模(standard / economy)已下线:执行环境零出网,不建 NAT 网关、不占弹性 IP,没有可调的档。",
    410,
    { code: "GONE" }
  );
}
