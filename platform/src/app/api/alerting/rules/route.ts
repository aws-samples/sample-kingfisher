export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { listRules, createRule } from "@/lib/alerting/rules";
// @kf-batch 50-WP4ter-coverage —— 执行范围(工单 SC-10)。规则的区绑定在 **`scope.targets`**(嵌一层),
// 所以这里不能直接用 `filterRowsByScope`(它读顶层属性)⇒ 用 `bindingTargets` 这个**同一个作者**
// 手工取那一层,回落语义(空 ⇒ 主控区)保持一致,不复制第二份判定。
import { requireScope } from "@/lib/exec-env/scope";
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
import { scopeTargets } from "@/lib/scope/scope";

// GET /api/alerting/rules — 列出当前项目的告警规则(viewer)。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  // @kf-batch 50-WP4ter-coverage
  const scope = await requireScope(req, ctx.projectId);
  if (scope instanceof NextResponse) return scope;
  try {
    const rules = await listRules(ctx.projectId);
    const want = scopeTargets(scope);
    if (want.length === 0) return apiOk(rules);
    // 🔴 `scope.targets` 为空的规则 = 盯**全部区** ⇒ 在任何单区视角下都应出现
    // (它确实管着这个区;按「不属于这个区」把它藏起来 = 用户以为这个区没有规则在看)。
    const filtered = rules.filter((r) => {
      const bound = r.scope?.targets;
      if (!bound || bound.length === 0) return true;
      return bindingTargets({ targets: bound }).some((t) => want.includes(t));
    });
    return apiOk(filtered);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

// POST /api/alerting/rules — 新建告警规则(editor)。
export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  try {
    const rule = await createRule(body, { projectId: ctx.projectId, createdBy: ctx.identity.username });
    recordAudit(req, "alerting.rule.create", { resourceType: "alert-rule", resourceId: rule.ruleId, detail: { name: rule.name, condition: rule.condition.type } }).catch(() => {});
    return apiOk(rule, 201);
  } catch (e: any) {
    return apiError(e.message, 400);
  }
}
