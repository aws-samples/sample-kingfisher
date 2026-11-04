export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { listSkills, createSkill, isValidSkillName, validateHttpConfig, GLOBAL_SCOPE } from "@/lib/genbi/skills";

// GET /api/genbi/skills — 当前项目 + global 的注册技能（任意成员可读）。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  try { return apiOk(await listSkills(ctx.projectId)); }
  catch (e: any) { return apiError(e.message, 500); }
}

// POST /api/genbi/skills — 注册一个技能（SQL 模板 editor；HTTP 外部 API / global 仅平台管理员）。
export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  if (!isValidSkillName(body?.name)) return apiError("技能标识需为字母开头的英文/下划线(2-49字符)");

  const kind: "sql" | "http" = body?.kind === "http" ? "http" : "sql";

  if (kind === "sql") {
    if (!body?.sqlTemplate || !String(body.sqlTemplate).trim()) return apiError("缺少 SQL 模板");
    if (!/^(select|with)\b/i.test(String(body.sqlTemplate).trim().replace(/^\s+/, ""))) return apiError("SQL 模板必须是只读 SELECT / WITH");
  } else {
    // HTTP/外部 API 技能更敏感（可发起出站请求）→ 仅平台管理员可注册；并做静态 SSRF 校验。
    if (!ctx.identity.isPlatformAdmin) return apiError("仅平台管理员可注册 HTTP/外部 API 技能", 403);
    const err = validateHttpConfig(body?.http);
    if (err) return apiError(err);
  }

  const wantGlobal = !!body.global;
  if (wantGlobal && !ctx.identity.isPlatformAdmin) return apiError("仅平台管理员可注册 global 技能", 403);

  try {
    const s = await createSkill({
      projectId: wantGlobal ? GLOBAL_SCOPE : ctx.projectId,
      name: body.name,
      description: body.description || "",
      kind,
      engine: body.engine === "athena" ? "athena" : "redshift",
      sqlTemplate: body.sqlTemplate,
      http: kind === "http" ? body.http : undefined,
      params: Array.isArray(body.params) ? body.params : [],
      createdBy: ctx.identity.username,
    });
    recordAudit(req, "genbi.skill.create", { resourceType: "genbi-skill", resourceId: s.skillId, detail: { name: s.name, kind: s.kind, projectId: s.projectId } }).catch(() => {});
    return apiOk(s, 201);
  } catch (e: any) { return apiError(e.message, 500); }
}
