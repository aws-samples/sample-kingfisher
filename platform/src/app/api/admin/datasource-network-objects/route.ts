export const dynamic = "force-dynamic";
// GET /api/admin/datasource-network-objects:平台为数据源自建的安全组清单(全平台所有执行环境)。
//
// 回什么:每个区组名 bgp-ds-* ∪ 带 bgp:managed 标签的组 × 归属源(源行引用,事实)× 状态(在用 / 孤儿 / 待清理 / 需人工)× 网卡数(只对非在用的查)。
// 🔴 清单的用途本身就是跨执行范围(人要看全平台哪些组是平台的、哪些是真孤儿),不接 ?scope=(读取级台账 `cross-scope-by-design`)。
// 🔴 只读:零写;清理走 POST …/cleanup(服务端重核三条件后入该缺陷的持久清理作业)。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { listDatasourceNetworkObjects } from "@/lib/datasource/network-objects";

export async function GET(req: NextRequest) {
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  try {
    return apiOk(await listDatasourceNetworkObjects());
  } catch (e) {
    return apiError((e as Error)?.message ?? String(e), 500);
  }
}
