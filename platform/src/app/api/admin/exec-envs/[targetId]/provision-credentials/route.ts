export const dynamic = "force-dynamic";
// @kf-batch 52-P52.5a-supply
// POST /api/admin/exec-envs/[targetId]/provision-credentials —— per-project 凭证供给的**生产调用方**。
//
// 🔴 **为什么必须有这个端点**:memory `unwired-code-is-unverified` 记着一条硬教训 ——
// 「没生产调用方 = 从未验证过的代码」,而且退化 fixture 的单测常把它骗过去
// (实证:`assertProjectId` 拒掉了**每一个**真实 projectId,1600 单测全绿,一接线就炸)。
//
// @kf-batch 50-WP9a-durable-jobs —— 🔴🔴 **改成 202 + 作业 id**(WORK-PACKAGES WP-9 施工序 2)。
//   原实现在一个请求里同步跑完 N 个项目 × ~10 条语句,跨区直接撞 ALB 504,断在中间也没有任何记录。
//   现在:每个 (target, project) 入队一条供给作业(确定性 jobId ⇒ 双击 / 重放不多一条),立刻回 202;
//   作业由推进泵逐步推进(断进程可续跑、已完成的步骤不重做),进度看 `GET .../jobs` 或 `GET .../jobs/[jobId]`。
//   回读核验(`verifyProjectCredentials`)成了作业的最后一步 —— 「写得进去 ≠ 是对的」仍然成立,只是不再卡在请求里。
//
// 🔴 **与 credential-state 的分工**:本端点**只造凭证**,不推进状态;
// 推进状态是 `credential-state`(§3.9b 的唯一写通道 + 服务端硬校验)。
// 刻意分开:"造好了" 与 "宣布进入稳态" 是两个决定,合成一个按钮就会有人顺手切了稳态。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { getTargetRaw } from "@/lib/exec-env/registry";
import { actorFromIdentity } from "@/lib/exec-env/admin-ddl-executor";
import { enqueueSupplyJob, listProjectsWithBindings } from "@/lib/exec-env/project-cred-supply";
import { assertProjectId } from "@/lib/exec-env/project-schema";
import { dataplaneJobsPaused } from "@/lib/dataplane-jobs/schema";

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
    // 空 body = 给该 target 下**全部在用项目**供给(运维最常用的那一下)。
  }

  let only: string | undefined;
  if (typeof body.projectId === "string" && body.projectId) {
    try {
      only = assertProjectId(body.projectId);
    } catch (e) {
      return apiError((e as Error).message, 400, { code: "VALIDATION_FAILED" });
    }
  }
  // 🔴 actor 取真实登录身份(不是系统主体):这是人点的运维操作,审计里必须是人;作业执行时也以这个人的名义。
  const actor = actorFromIdentity(identity);

  try {
    if (!(await getTargetRaw(params.targetId))) {
      return apiError(`执行目标不存在:${params.targetId}`, 404, { code: "NOT_FOUND" });
    }
    const projects = only ? [only] : await listProjectsWithBindings(params.targetId);
    if (projects.length === 0) {
      return apiError(
        `执行目标 ${params.targetId} 上没有识别到在用项目 ⇒ 无可供给对象。` +
          `(非 home 的"在用"口径 = 资源行显式盖了该 targetId;见 project-cred-supply.listProjectsWithBindings)`,
        409,
        { code: "CONFLICT" }
      );
    }

    // 🔴 入队前先写意图审计,写不进去就不入队(人点的权限边界动作必须可复盘)
    try {
      await recordAudit(req, "exec-env.provision-credentials.intent", {
        resourceType: "exec-env",
        resourceId: params.targetId,
        detail: { projectCount: projects.length, projects: projects.slice(0, 50), scope: only ? "single" : "all", mode: "job" },
      });
    } catch (e) {
      return apiError(`审计写入失败 ⇒ 拒绝入队供给作业:${(e as Error)?.message ?? String(e)}`, 503, { code: "UPSTREAM_ERROR" });
    }

    // 🔴 逐个入队、逐个记结果(一个项目入队失败不影响其它);失败项原样回报,不吞。
    const jobs: Array<{ projectId: string; jobId: string; created: boolean; phase: string }> = [];
    const failed: Array<{ projectId: string; error: string }> = [];
    for (const projectId of projects) {
      try {
        const r = await enqueueSupplyJob(params.targetId, projectId, { runAs: actor, force: true });
        jobs.push({ projectId, ...r });
      } catch (e) {
        failed.push({ projectId, error: (e as Error)?.message ?? String(e) });
      }
    }

    await recordAudit(req, "exec-env.provision-credentials.enqueued", {
      resourceType: "exec-env",
      resourceId: params.targetId,
      detail: { enqueued: jobs.filter((j) => j.created).length, existing: jobs.filter((j) => !j.created).length, failed: failed.length },
    }).catch(() => {});

    return apiOk(
      {
        targetId: params.targetId,
        requested: projects.length,
        jobs,
        failed,
        paused: dataplaneJobsPaused(),
      },
      202
    );
  } catch (e: unknown) {
    return apiError((e as Error)?.message ?? String(e), 500);
  }
}
