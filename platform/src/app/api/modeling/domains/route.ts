export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { listDomains, createDomain } from "@/lib/modeling/service";
import { recordAudit } from "@/lib/audit";
// @kf-batch 50-WP4quater-reads(工单 SC-37)—— 🔴 用户 2026-09-10 驳回了「平台级定义,本身不分区
// (设计如此)」这个说法:「**这里为什么不能做成区域维度?我认为都可以切出来的。**」
// ⇒ 定义行可声明**适用区** `targets[]`;读侧按当前范围过滤。
// 🔴 未声明 ⇒ **全平台通用**(用 `filterRowsByApplicableScope`,不是 `filterRowsByScope`):
//   治理约定不是执行体,套「无章 ⇒ 主控区」会让存量定义在非主控区视角整体消失。
import { readScope, filterRowsByApplicableScope } from "@/lib/exec-env/scope";

// 模块 35: 数据域/主题域。GET 列表(登录可读);POST 建(仅平台管理员)。
export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  try {
    const rows = await listDomains();
    const scope = readScope(req);
    return apiOk(scope ? filterRowsByApplicableScope(rows as unknown as Array<Record<string, unknown>>, scope) : rows);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可管理数据域", 403);
  const body = await req.json().catch(() => ({}));
  try {
    const domain = await createDomain(body, identity.username);
    recordAudit(req, "modeling.domain.create", { resourceType: "data-domain", resourceId: domain.domainId, detail: { name: domain.name, level: domain.level } }).catch(() => {});
    return apiOk(domain, 201);
  } catch (e: any) {
    return apiError(e.message);
  }
}
