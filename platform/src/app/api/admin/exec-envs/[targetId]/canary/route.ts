export const dynamic = "force-dynamic";
// /api/admin/exec-envs/[targetId]/canary —— permission canary(④-3)。
//
//   GET                                   各在用项目**最新**判定完成的 canary(七条明细 + 绑定 epoch + 时间)
//   POST {}                               给全部在用项目入队 canary(202 + 作业 id)
//   POST {projectId}                      只给一个项目入队
//   POST {action:"revoke-public-create", confirm:<targetId>}
//                                         撤 PUBLIC 在 public schema 上的 CREATE(进 isolated 的前置,⑨-7)
//
// 🔴 canary 用**该项目自己的 secret** 真跑(不是 admin),结果才证明得了隔离;建探针那一步才用 admin(经闭合执行器)。
// 🔴 revoke-public-create 是**收紧**,但会让依赖「往 public 建表」的非 admin 身份当场报错 ⇒ 只在这里由人显式触发,
//    并要求手输 targetId 确认;绝不随供给 / canary 自动执行。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { getTargetRaw } from "@/lib/exec-env/registry";
import { requireCredentialIsolationState } from "@/lib/exec-env/privileged-cred";
import { actorFromIdentity, executeAdminDdl, AdminDdlDenied } from "@/lib/exec-env/admin-ddl-executor";
import { listProjectsWithBindings } from "@/lib/exec-env/project-cred-supply";
import { assertProjectId } from "@/lib/exec-env/project-schema";
import { CANARY_CHECKS, CANARY_MAX_AGE_MS, canaryPrerequisite, enqueueCanaryJob, latestCanaryByProject } from "@/lib/exec-env/permission-canary";
import { readbackPublicCreateRevokedAsProject } from "@/lib/exec-env/public-create-readback";
import { dataplaneJobsPaused } from "@/lib/dataplane-jobs/schema";

export async function GET(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  if (!isValidTargetId(params.targetId)) {
    return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  }
  try {
    const t = await getTargetRaw(params.targetId);
    if (!t) return apiError(`执行目标不存在:${params.targetId}`, 404, { code: "NOT_FOUND" });
    const iso = requireCredentialIsolationState(t);
    const projects = await listProjectsWithBindings(params.targetId);
    const latest = await latestCanaryByProject(params.targetId);
    const pre = canaryPrerequisite(projects, latest, iso.epoch, Date.now());
    return apiOk({
      targetId: params.targetId,
      credentialEpoch: iso.epoch,
      maxAgeHours: CANARY_MAX_AGE_MS / 3_600_000,
      checks: CANARY_CHECKS.map((c) => ({ id: c.id, role: c.role, what: c.what })),
      projects: projects.map((projectId) => {
        const c = latest.get(projectId);
        return {
          projectId,
          latest: c ? { jobId: c.jobId, verdict: c.verdict, credentialEpoch: c.credentialEpoch, at: c.at, checks: c.checks ?? [], reason: c.reason } : null,
        };
      }),
      prerequisite: pre,
    });
  } catch (e) {
    return apiError((e as Error)?.message ?? String(e), 500);
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  if (!isValidTargetId(params.targetId)) {
    return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  }
  let body: Record<string, unknown> = {};
  try {
    body = ((await req.json()) as Record<string, unknown>) ?? {};
  } catch {
    /* 空 body = 全部在用项目 */
  }
  const actor = actorFromIdentity(identity);

  try {
    const t = await getTargetRaw(params.targetId);
    if (!t) return apiError(`执行目标不存在:${params.targetId}`, 404, { code: "NOT_FOUND" });
    const iso = requireCredentialIsolationState(t);

    if (body.action === "revoke-public-create") {
      if (body.confirm !== params.targetId) {
        return apiError(`撤 public 的 CREATE 需手输 targetId 确认(confirm 必须等于 ${params.targetId})`, 400, { code: "VALIDATION_FAILED" });
      }
      // 闭合执行器自己写意图 / 结果审计(fail-closed-on-audit);单条语句,同步执行即可
      const r = await executeAdminDdl(actor, { operation: "revoke-public-create", targetId: params.targetId });
      // 🔴 语句到终态 ≠ 别的身份已经看见(第三十七轮 MIG-CN-5:回 200 后立刻复跑 canary,C-6 仍建成)。
      //   用项目自己的身份回读 nspacl + has_schema_privilege 直到 public 对它已无 CREATE 才回 200;预算内读不到 ⇒ 如实 502,不算完成。
      //   没有带凭证的在用项目 ⇒ 回读做不了,200 里如实写 verified:false(canary 同样跑不了,不冒充已验证)。
      const readback = await readbackPublicCreateRevokedAsProject(t, { statementName: `revoke-public-create readback ${r.auditId}` });
      if (!readback.verified && readback.unsettled) {
        const o = readback.outcome;
        return apiError(
          `撤权语句已执行(审计 ${r.auditId}),但 ${Math.round(o.waitedMs / 1000)}s 内用项目 ${readback.projectId} 的身份回读 ${o.attempts} 次仍未收口` +
            `(目录 PUBLIC 含 CREATE=${o.last ? o.last.publicHasCreate : "读不到"} · has_schema_privilege=${o.last ? o.last.effectiveHasCreate : "读不到"}` +
            `${o.error ? ` · 最后一次错误:${o.error.slice(0, 160)}` : ""})⇒ 不算完成,请稍后再点一次「撤权」`,
          502,
          { code: "UPSTREAM_ERROR" }
        );
      }
      return apiOk({ targetId: params.targetId, action: "revoke-public-create", auditId: r.auditId, readback });
    }
    if (body.action !== undefined) {
      return apiError(`未知 action:${JSON.stringify(body.action)}`, 400, { code: "VALIDATION_FAILED" });
    }

    let projects: string[];
    if (typeof body.projectId === "string" && body.projectId) {
      try {
        projects = [assertProjectId(body.projectId)];
      } catch (e) {
        return apiError((e as Error).message, 400, { code: "VALIDATION_FAILED" });
      }
    } else {
      projects = await listProjectsWithBindings(params.targetId);
    }
    if (projects.length === 0) {
      return apiError(`执行目标 ${params.targetId} 上没有识别到在用项目 ⇒ 无可跑 canary 的对象`, 409, { code: "CONFLICT" });
    }
    try {
      await recordAudit(req, "exec-env.canary.intent", {
        resourceType: "exec-env",
        resourceId: params.targetId,
        detail: { projectCount: projects.length, projects: projects.slice(0, 50), credentialEpoch: iso.epoch },
      });
    } catch (e) {
      return apiError(`审计写入失败 ⇒ 拒绝入队 canary:${(e as Error)?.message ?? String(e)}`, 503, { code: "UPSTREAM_ERROR" });
    }
    const jobs: Array<{ projectId: string; jobId: string; created: boolean; phase: string }> = [];
    const failed: Array<{ projectId: string; error: string }> = [];
    for (const projectId of projects) {
      try {
        jobs.push({ projectId, ...(await enqueueCanaryJob(params.targetId, projectId, { runAs: actor, credentialEpoch: iso.epoch })) });
      } catch (e) {
        failed.push({ projectId, error: (e as Error)?.message ?? String(e) });
      }
    }
    return apiOk({ targetId: params.targetId, credentialEpoch: iso.epoch, jobs, failed, paused: dataplaneJobsPaused() }, 202);
  } catch (e) {
    if (e instanceof AdminDdlDenied) {
      return apiError(`${e.message}(拒于第 ${e.step} 步)`, 403, { code: "RBAC_DENIED" });
    }
    return apiError((e as Error)?.message ?? String(e), 500);
  }
}
