// @kf-batch 50-WP16-zero-egress
// 🔴 **已下线**:GET /api/admin/exec-envs/preflight(EIP 配额预检)。
// 执行环境自 WP-16 起零出网(SPEC §3.16):不建 NAT、不占 EIP ⇒ 预检没有对象。
// 与 WP-1「数据服务下线」同一处置口径:**保留路由并回 410**,而不是删掉路由 —— 让还在调它的旧前端
// 拿到一句能读懂的话,而不是一个 404(404 会被当成部署坏了)。
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-response";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";

export async function GET(req: NextRequest) {
  // 🔴 守卫照旧走一遍:本路由已下线回 410,但「/api/admin/exec-envs 下每个 route 都过守卫」是
  //   纵深防御的普适约定(门禁 exec-env-routes-guard 逐文件钉)。给退役路由开豁免 = 在门禁上开口子,
  //   将来新加的路由也能借这个口子溜过去 —— 不值得为省两行去弱化一道普适门。
  const denied = await requireExecEnvAdmin(req);
  if (denied instanceof NextResponse) return denied;
  return apiError(
    "EIP 配额预检已下线:执行环境不再使用 NAT 网关与弹性 IP(零出网,全部走 VPC 端点)。向导里也已移除「网络规模」选项。",
    410,
    { code: "GONE" }
  );
}
