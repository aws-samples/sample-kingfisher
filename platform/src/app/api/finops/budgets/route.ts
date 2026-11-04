export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { ulid } from "ulid";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { DEFAULT_PROJECT_ID } from "@/lib/projects/constants";
import { listBudgets, putBudget, budgetPk } from "@/lib/finops/store";
import type { Budget, BudgetScope } from "@/lib/finops/types";
import { requireScope } from "@/lib/exec-env/scope";
// 视角 → 区集合的唯一入口(全部视角 = null;原写法在全部视角下把区预算全筛掉)
import { regionsInViewOf } from "@/lib/finops/cost-region";

// 预算横切账号级,统一落 default 分区(与告警中心口径一致);写权限=owner。

// GET /api/finops/budgets — 预算列表。RBAC: viewer。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const scope = await requireScope(req, ctx.projectId);
  if (scope instanceof NextResponse) return scope;
  try {
    const all = await listBudgets(DEFAULT_PROJECT_ID);
    // 按执行范围过滤。
    // 🔴 只过滤 `region` 作用域的预算;account / service / project 作用域**横切所有区**
    // (与治理约定「未声明适用区 = 全平台通用」同一条道理)—— 把它们也筛掉会让
    // 「账号总预算」在单区视角消失,而那条预算恰恰是最该一直看得见的。
    const regions = await regionsInViewOf(scope);
    const items = regions
      ? all.filter((b) => b.scope.kind !== "region" || regions.has(b.scope.region))
      : all;
    return apiOk({ items });
  } catch (e: unknown) {
    return apiError((e as Error).message || String(e), 500);
  }
}

function parseScope(v: unknown): BudgetScope | null {
  const s = v as { kind?: string; service?: string; projectId?: string };
  if (s?.kind === "account") return { kind: "account" };
  if (s?.kind === "service" && s.service) return { kind: "service", service: s.service };
  if (s?.kind === "project" && s.projectId) return { kind: "project", projectId: s.projectId };
  // 给某个区单独设预算
  if (s?.kind === "region" && (s as { region?: string }).region) return { kind: "region", region: String((s as { region: string }).region) };
  return null;
}

// POST /api/finops/budgets — 新建预算。RBAC: owner。
export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "owner");
  if (ctx instanceof NextResponse) return ctx;

  try {
    const body = await req.json();
    const name = String(body.name || "").trim();
    const scope = parseScope(body.scope);
    const monthlyLimitUsd = Number(body.monthlyLimitUsd);
    if (!name) return apiError("预算名称不能为空", 400);
    if (!scope) return apiError("作用域不合法", 400);
    if (!(monthlyLimitUsd > 0)) return apiError("月限额必须为正数", 400);

    const now = new Date().toISOString();
    const budgetId = ulid();
    const b: Budget = {
      pk: budgetPk(DEFAULT_PROJECT_ID),
      sk: budgetId,
      budgetId,
      name,
      scope,
      monthlyLimitUsd,
      channelIds: Array.isArray(body.channelIds) ? body.channelIds.map(String) : [],
      enabled: body.enabled !== false,
      notifiedMarks: [],
      version: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.identity.username,
    };
    await putBudget(b);
    return apiOk(b);
  } catch (e: unknown) {
    return apiError((e as Error).message || String(e), 500);
  }
}
