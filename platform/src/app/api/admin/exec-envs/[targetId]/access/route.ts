export const dynamic = "force-dynamic";
// POST /api/admin/exec-envs/[targetId]/access —— 设置执行目标的**项目白名单**(50 SPEC v3.22 §1.1 `access?` / §2.1;§3.12 RBAC×target)。
//
// 【通用,不对跨法域特殊化】任何 target(含 home)都可设;缺省 all-projects。判据单作者 `accessAllows`(lib/exec-env/residency.ts),
// 写入校验(assertBindableTarget)与列表过滤(listRedshiftCapableTargets / GET /api/exec-targets)同一个函数 ⇒ 呈现 = 授权。
// 【全集语义】body 就是最终想要的 access 对象,不是增量;`allowlist` 空数组 = 谁都不能绑(允许,但审计留痕)。
// 【唯一写通道】`setTargetAccess`(registry):version 乐观锁;reconcile / 窄通道 / PUT 可写集**都不收** access(变异 M-d)。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { getTargetRaw, setTargetAccess, LifecyclePreconditionError } from "@/lib/exec-env/registry";
import { LifecycleConflictError } from "@/lib/exec-env/lifecycle";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { parseTargetAccess } from "@/lib/exec-env/residency";

/** 客户端字段白名单(多一个就拒 —— 与 register / intent 同哲学)。 */
const CLIENT_FIELDS = ["mode", "projects"];

export async function POST(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  if (!isValidTargetId(params.targetId)) {
    return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  }
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return apiError("请求体不是合法 JSON", 400, { code: "VALIDATION_FAILED" });
  }
  const extra = Object.keys(body ?? {}).filter((k) => !CLIENT_FIELDS.includes(k));
  if (extra.length > 0) {
    return apiError(`入参含不允许的字段:${extra.join(", ")}(只接 ${CLIENT_FIELDS.join(", ")})`, 400, { code: "VALIDATION_FAILED" });
  }
  let access;
  try {
    access = parseTargetAccess(body);
  } catch (e) {
    return apiError((e as Error).message, 400, { code: "VALIDATION_FAILED" });
  }
  // allowlist 里的项目必须真实存在(拒而不是静默丢:写错一个 id 会让本该能用的项目被静默拦住)
  if (access.mode === "allowlist" && access.projects.length > 0) {
    const { getProject } = await import("@/lib/projects/project-service");
    const missing: string[] = [];
    for (const pid of access.projects) {
      const p = await getProject(pid).catch(() => null);
      if (!p) missing.push(pid);
    }
    if (missing.length) {
      return apiError(`projects 含不存在的项目:${missing.join(", ")}`, 400, { code: "VALIDATION_FAILED" });
    }
  }
  try {
    const target = await getTargetRaw(params.targetId);
    if (!target) return apiError(`执行目标不存在:${params.targetId}`, 404, { code: "NOT_FOUND" });
    if (!Number.isInteger(target.version)) {
      return apiError("描述符缺 version,无法做乐观锁写入(数据坏了,不是调用方的错)", 500, { code: "INTERNAL" });
    }
    const r = await setTargetAccess(params.targetId, access, { expectedVersion: target.version as number });
    recordAudit(req, "exec-env.access.set", {
      resourceType: "exec-env",
      resourceId: params.targetId,
      detail: { before: r.before ?? { mode: "all-projects" }, after: r.after },
    }).catch(() => {});
    return apiOk({ targetId: params.targetId, access: r.after });
  } catch (e: unknown) {
    if (e instanceof LifecycleConflictError) return apiError(e.message, 409, { code: "CONFLICT" });
    if (e instanceof LifecyclePreconditionError) return apiError(e.message, 409, { code: "CONFLICT" });
    return apiError(`设置授权项目失败:${String((e as Error)?.message ?? e)}`, 500, { code: "INTERNAL" });
  }
}
