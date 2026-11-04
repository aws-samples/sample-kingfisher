export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { listGrants } from "@/lib/governance/classification";
// @kf-batch 50-WP4quater-reads(工单 SC-8)—— 🔴 「我的授权」按区筛:授权的对象是**某个区的某张表**。
// 授权行的 sk 就是被授权的 fqn,而 fqn 现在带区前缀(`<targetId>::<fqn>`,home 裸 fqn)⇒
// 直接按键上的区筛,不需要另存字段(另存就有两个真值源)。
// 🔴 显示时把区前缀剥掉(`displayFqn`),区本身用标签显示 —— 表名里混着 `tgt_xxx::` 没人看得懂。
import { parseScopedFqn, displayFqn } from "@/lib/governance/scoped-fqn";
import { readScope } from "@/lib/exec-env/scope";
import { scopeTargets } from "@/lib/scope/scope";

// 模块 18: list the caller's own data-access grants ("我的授权").
export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  try {
    const rows = await listGrants(identity.username);
    const scope = readScope(req);
    const want = scope ? scopeTargets(scope) : [];
    const out = rows
      .filter((g) => want.length === 0 || want.includes(parseScopedFqn(g.fqn).targetId))
      .map((g) => ({ ...g, fqn: displayFqn(g.fqn), targetId: parseScopedFqn(g.fqn).targetId }));
    return apiOk(out);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
