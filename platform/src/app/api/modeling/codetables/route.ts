export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { listCodeTables, listCodeTablesEnriched, createCodeTable } from "@/lib/modeling/service";
import { recordAudit } from "@/lib/audit";
// @kf-batch 50-WP4bis-p1-scope —— 执行范围(50 SPEC §2.6;WP-4bis 阶段 1)
import { filterRowsByScope, requireScope } from "@/lib/exec-env/scope";
import { getActiveProjectId } from "@/lib/projects/guard";

// 模块 35: 码表。GET 列表(登录可读);POST 建(仅平台管理员)。
export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  try {
    // @kf-batch 50-P50.3-modeling —— 带上 defHash/物理落点,前端才能判「版本不齐」(判据与服务端同源)
    // @kf-batch 50-WP4bis-p1-scope —— 按执行范围过滤「落点」。
    // 🔴 建模定义是**平台级全局**的(本路由走 `resolveIdentity`,没有 `requireProject` 上下文),
    //    但 target 上可能挂项目白名单 ⇒ 校验用**当前活跃项目头**(与界面所在项目同一个),
    //    不是硬塞 null:塞 null 会让白名单 target 在建模页恒 403。
    // 🔴 B 类(绑定列表 `targets[]`,= 这份定义要落到哪些区)只许内存过滤,走 `bindingTargets` 三级回落。
    const scope = await requireScope(req, getActiveProjectId(req));
    if (scope instanceof NextResponse) return scope;
    const rows = await listCodeTablesEnriched();
    return apiOk(filterRowsByScope(rows as unknown as Array<Record<string, unknown>>, scope));
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可管理码表", 403);
  const body = await req.json().catch(() => ({}));
  try {
    const ct = await createCodeTable(body, identity.username);
    recordAudit(req, "modeling.codetable.create", { resourceType: "code-table", resourceId: ct.codeTableId, detail: { name: ct.name, code: ct.code, values: ct.values.length } }).catch(() => {});
    return apiOk(ct, 201);
  } catch (e: any) {
    return apiError(e.message);
  }
}
