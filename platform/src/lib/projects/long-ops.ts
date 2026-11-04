// 项目空间的长操作执行体:删除项目空间(根治的第二刀)。
//
// 原路由(app/api/projects/[id] DELETE)的「主体」原样搬入:默认空间不可删 / D4 授权 **留在路由**;
// 这里只做「盘点 → 阻断 400 → 凭证回收入队 → 删项目 → 审计 → 回 data」。
//
// 🔴该缺陷的「正在唤醒数仓」协议(202 warming + 页面自动重发)退役:盘点语句在执行体里经 awaitTerminal 等到终态,
//    数仓冷恢复超过 45 秒时整条删除由 submitLongOp 转后台(202 long-op/1),页面右下「正在后台执行:删除项目空间(已 n 秒)」,
//    终态原样交回 ⇒ 用户按一次最终达成,且不再有第二套 202 协议。
// 错误口径与接入前逐字一致(400 列明细 / 503 回收入队失败 / 500 兜底在路由)。

import { recordAudit } from "@/lib/audit";
import type { LongOpExecutor, LongOpExecutorRegistry } from "@/lib/long-ops/executor-types";
import { LongOpHttpError } from "@/lib/long-ops/store";
import { enqueueProjectCredReclaim } from "@/lib/exec-env/project-cred-reclaim";
import { inventoryProject } from "./project-resources";
import { deleteProject } from "./project-service";

const projectDelete: LongOpExecutor<"project-delete"> = async (params, ctx) => {
  const { projectId } = params;
  // 🔴 前置校验(与删执行环境同款:有绑定 = 0 才可删)。不做级联删除 —— 删项目顺手删掉别人的作业/表,是不可逆的数据损失。
  const inv = await inventoryProject(projectId);
  if (inv.blockers.length > 0) {
    throw new LongOpHttpError(
      400,
      `项目空间下仍有内容,已拒绝删除(平台不做级联删除):${inv.blockers.join("、")}。请先迁移或删除这些内容,再删项目空间。`,
      { code: "VALIDATION_FAILED", detail: inv },
    );
  }
  // 🔴 per-project 凭证 secret 是**系统代管**的(人没建过、页面看不见)⇒ 不阻断、由产品自动回收。
  //    🔴 顺序:**先入队、再删项目**。入队失败 ⇒ 拒绝删除(项目还在,可重试);反过来的话,
  //    入队失败时项目已经没了、那几个区的凭证就再也没人回收。handler 等项目真的不在了才动手。
  let reclaim: Awaited<ReturnType<typeof enqueueProjectCredReclaim>>;
  try {
    reclaim = await enqueueProjectCredReclaim(projectId, { createdBy: ctx.identity.username || ctx.identity.sub });
  } catch (e: unknown) {
    throw new LongOpHttpError(
      503,
      `读不到执行环境清单,无法安排凭证回收 —— 已拒绝删除(项目未删,请稍后重试):${(e as Error)?.message || e}`,
      { code: "UPSTREAM_ERROR", cause: e },
    );
  }
  if (reclaim.failures.length > 0) {
    await recordAudit(ctx.req, "project.delete.cred-reclaim-refused", {
      resourceType: "project",
      resourceId: projectId,
      detail: { failures: reclaim.failures },
    }).catch(() => {});
    throw new LongOpHttpError(
      503,
      `以下执行区的凭证回收作业没能入队,已拒绝删除(项目未删,请稍后重试):` +
        reclaim.failures.map((f) => `${f.targetId}(${f.error})`).join("、"),
      { code: "UPSTREAM_ERROR", detail: { credentialReclaim: reclaim } },
    );
  }
  await deleteProject(projectId);
  recordAudit(ctx.req, "project.delete", {
    resourceType: "project",
    resourceId: projectId,
    detail: {
      schemaChecked: inv.schemaCheck,
      schemaName: inv.schemaName,
      credentialReclaimJobs: reclaim.jobs.map((j) => ({ targetId: j.targetId, jobId: j.jobId })),
    },
  }).catch(() => {});
  return { data: { deleted: true, credentialReclaim: { jobs: reclaim.jobs } } };
};

export type ProjectLongOpKind = "project-delete";
export const PROJECT_LONG_OP_EXECUTORS: Pick<LongOpExecutorRegistry, ProjectLongOpKind> = {
  "project-delete": projectDelete,
};
