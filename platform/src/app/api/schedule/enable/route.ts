export const dynamic = "force-dynamic";
// @kf-batch 52-P52.1-guards
// 🔴 **改动前零守卫**(52 SPEC §2 缺口B 第 5 面;台账 52 DESIGN §11.2 第 3 项)。危害有两层:
//   ① 任一登录用户可对**任意项目**的 workflow / sync task 启停调度、**覆写 DAG**、`dags unpause`
//      —— 这是"能让别人的作业按我的意愿开始跑"的写权;
//   ② 🔴 sync 分支是**无条件盲 `UpdateCommand`**:传一个**不存在的** taskId,DDB 会按 upsert 语义
//      **凭空造出一个幽灵同步任务**(只有 `scheduleEnabled`/`cronExpression` 几个字段),
//      之后出现在列表里、却没有任何同步配置。SPEC 点名的"对不存在 taskId 无条件盲 Update"就是它。
// 🔴 守卫**按资源自己的归属项目**判(`guardResourceAccess`),不是调用方 active project;
//    且**授权在"存不存在"之前**,否则 404 本身就是存在性预言机。
// @kf-batch 50-WP13-mwaa-region
import { NextRequest, NextResponse } from "next/server";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { guardResourceAccess } from "@/lib/projects/guard";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { publishWorkflowDag, ensureDagUnpaused } from "@/lib/workflow/publish-dag";
// 模块 55 §2.8 对象租约:重新生成 DAG 写的是与「发布 / 下线 / 删除」同一份产物 ⇒ 同族守卫(不许绕过)
import { resourceBusyResponse } from "@/lib/long-ops/guard";
import { resourceKey } from "@/lib/long-ops/kinds";
// @kf-batch 50-WP18b-fanout-seam —— 调度类拒因 → HTTP 的单一作者
import { schedulerRejectResponse } from "@/lib/scheduler/fanout-reject";
// @kf-batch 50-WP26-sync-schedule-carrier —— 同步任务的定时调度载体(单节点 sync 工作流,走 MWAA Serverless)
import {
  publishSyncScheduleCarrier,
  offlineSyncScheduleCarrier,
  carrierPrereqReason,
  type SyncTaskForCarrier,
} from "@/lib/sync/schedule-carrier";
import { apiOk, apiError } from "@/lib/api-response";
// @kf-batch 50-WP28-platform-action-node —— 平台动作的调度对象(治理定时任务 / 卡片定时刷新)启停的唯一作者
import { getActionSchedule, setActionScheduleEnabled } from "@/lib/scheduler/action-schedules";
import { ACTION_SCHEDULE_TASK_TYPES } from "@/lib/scheduler/carrier-ledger";
import { actionScheduleError } from "@/lib/scheduler/action-schedules-http";
import { recordAudit } from "@/lib/audit";

const USER_ID = "default-user";

export async function POST(req: NextRequest) {
  const { taskId, taskType, cronExpression, enabled } = await req.json();
  if (!taskId) return apiError("缺少 taskId");

  try {
    if (taskType === "workflow") {
      // Update workflow cron and regenerate DAG with schedule_interval
      const { Item: wf } = await docClient.send(new GetCommand({
        TableName: TABLES.WORKFLOWS, Key: { userId: USER_ID, workflowId: taskId },
      }));
      // 🔴 先授权(按工作流归属项目)再回答"存不存在"。
      const wctx = await guardResourceAccess(req, wf as { projectId?: string } | undefined, "editor");
      if (wctx instanceof NextResponse) return wctx;
      if (!wf) return apiError("工作流不存在", 404);
      // 对象租约:这条编排的发布 / 下线 / 触发 / 删除还在进行 ⇒ 409,不改 cron 也不重发 DAG(否则会把正在撤的产物又写回去)
      const busy = await resourceBusyResponse([resourceKey("workflow", taskId)]);
      if (busy) return busy;

      const cron = enabled ? cronExpression : undefined;
      const dagIdInit = wf.airflowDagId || `bgp_${taskId}`;

      // Update DynamoDB(cron/scheduleEnabled 是本路由特有职责,先落库)。
      await docClient.send(new UpdateCommand({
        TableName: TABLES.WORKFLOWS,
        Key: { userId: USER_ID, workflowId: taskId },
        UpdateExpression: "SET scheduleEnabled = :e, cronExpression = :c, updatedAt = :now",
        ExpressionAttributeValues: { ":e": !!enabled, ":c": cron || null, ":now": new Date().toISOString() },
      }));

      // 🔴 Task#19 根治:重新生成 DAG 走【与 publish 同一份共享实现】publishWorkflowDag——
      // 含引擎 flag 分派 + 能力门 + runtime-lib 固定库下发。此前这里硬编码 legacy 生成器,
      // 含新节点(branch/join/foreach 等)的 workflow 从监控页切调度会被 legacy 生成的坏 DAG
      // 覆盖掉 publish 的好 v2 DAG(写同一 S3 key)。现在两路径生成逻辑统一,不再覆盖坏。
      // @kf-batch 50-B09-secret-single-author —— 🔴 原来在这里按 `wf.projectId` 取一遍 admin secret 再传下去,
      //   而发布函数内部的 `resolveRedshiftBinding({ projectId: workflow.projectId })` 在 home 分支
      //   **算的就是同一个值** ⇒ 两个作者。已收成一个:本处不再取、不再传。
      let dagId: string;
      let scheduler: "mwaa" | "serverless";
      try {
        ({ dagId, scheduler } = await publishWorkflowDag(
          { ...wf, cronExpression: cron, airflowDagId: dagIdInit } as any
        ));
      } catch (e: any) {
        // 能力门/spec 校验失败 → 400(不下发任何东西,不覆盖现有好 DAG)。
        if (e?.code === "engine-capability" || String(e?.message || "").includes("dag-spec-invalid")) {
          return apiError(e.message, 400, { code: "VALIDATION_FAILED" });
        }
        // @kf-batch 50-WP18b-fanout-seam —— 🔴 这条路径与 publish 共用同一份扇出实现,
        //   所以也共用同一族拒因:那个区没装调度器 ⇒ 409 + 补装直达;图里有 external 节点 ⇒ 400 改图。
        //   原来这里两类都掉到外层 catch 变 500(「平台故障」),用户既看不到出路也会去重试。
        const rejected = schedulerRejectResponse(e);
        if (rejected) return rejected;
        throw e;
      }

      // Unpause DAG if enabling
      // @kf-batch 50-WP17-serverless-workflow —— 🔴 原来是 `unpauseWhenLoaded(homeMwaaEndpoint(), …)`
      //   **恒打主控区**:工作流绑别的区时,DAG 与 cron 都进了那个区,而解挂打在 home ⇒ 页面显示
      //   「调度已开启」而那个区的 DAG 一直 paused、**永远不触发**。改走单一作者(它自己按落点解析,
      //   serverless 无 pause 概念 ⇒ 如实 no-op)。
      if (enabled) {
        ensureDagUnpaused(wf as never, dagId).catch(() => {});
      }

      return apiOk({ dagId, enabled: !!enabled, cronExpression: cron, engine: scheduler === "serverless" ? "MWAA Serverless" : "MWAA" });
    }

    // @kf-batch 50-WP28-platform-action-node(WP-29)
    // 🔴 平台动作的调度对象:载体 = 单节点 platform-action 工作流,发到**该区**的 MWAA Serverless。
    //    先办载体再改记录 / 撤不下来不动记录 —— 两条都在 `setActionScheduleEnabled` 一处(这里不重写)。
    //    权限:治理定时任务 = 平台管理员(与手动入口同档);卡片定时刷新 = **卡片作者本人**(别人 404,不泄露存在)。
    if ((ACTION_SCHEDULE_TASK_TYPES as readonly string[]).includes(String(taskType))) {
      const row = await getActionSchedule(String(taskId));
      // @kf-batch 50-CAPSEED-seed-dispatch —— 造数(`seed`)与治理同档:平台管理员;卡片 = 作者本人
      const actx = await guardResourceAccess(req, row ?? undefined, taskType === "genbi-card" ? "viewer" : "editor");
      if (actx instanceof NextResponse) return actx;
      if (!row || row.kind !== taskType) return apiError("调度对象不存在", 404, { code: "NOT_FOUND" });
      if (row.kind === "governance" && !actx.identity.isPlatformAdmin) {
        return apiError("仅平台管理员可启停定时治理任务", 403, { code: "RBAC_DENIED" });
      }
      if (row.kind === "seed" && !actx.identity.isPlatformAdmin) {
        return apiError("仅平台管理员可启停定时造数任务", 403, { code: "RBAC_DENIED" });
      }
      if (row.kind === "genbi-card" && actx.identity.sub !== row.ownerSub) {
        return apiError("调度对象不存在", 404, { code: "NOT_FOUND" });
      }
      try {
        const r = await setActionScheduleEnabled(row, { enabled: !!enabled, cron: cronExpression ?? row.cronExpression });
        await recordAudit(req, enabled ? "schedule.action.enable" : "schedule.action.disable", {
          resourceType: "action-schedule",
          resourceId: row.taskId,
          targetId: row.targets[0],
          detail: { kind: row.kind, action: row.action, cronExpression: r.cronExpression },
        });
        return apiOk({
          ...r,
          carrier: enabled ? "mwaa-serverless" : "none",
          notice: enabled
            ? "定时已启用:单节点平台动作工作流已发布到**该区**的 MWAA Serverless,到点由它触发;运行记录与日志在「任务监控」里查。"
            : "已停用:该区的调度产物已真撤下来(撤不下来不会改记录)。",
        });
      } catch (e) {
        return actionScheduleError(e);
      }
    }

    // For sync tasks: update cron in DynamoDB (sync tasks don't have DAGs by default)
    // 🔴 本批新增强读:既是守卫需要的(要拿归属项目),也是修盲 Update 需要的(要知道它到底存不存在)。
    const { Item: task } = await docClient.send(new GetCommand({
      TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId },
    }));
    const tctx = await guardResourceAccess(req, task as { projectId?: string } | undefined, "editor");
    if (tctx instanceof NextResponse) return tctx;
    if (!task) return apiError("同步任务不存在", 404, { code: "NOT_FOUND" });

    // @kf-batch 50-WP26-sync-schedule-carrier
    // 🔴🔴 **先把载体办妥,再改记录** —— 顺序反了就又回到「库里写了 enabled 而没有东西在跑」。
    //   启用:按任务的 targets 逐区发一份**单节点 sync 工作流**(复用编排那一整套 MWAA Serverless);
    //   停用:把每个有产物的区真撤掉,**撤不下来就不许动记录**(WP-18d 那条铁律:
    //        否则孤儿 workflow 继续按 cron 跑,而平台已认为它下线了)。
    const taskRow = task as unknown as SyncTaskForCarrier;
    let carrier: { kind: "serverless"; dagId: string; perTarget: unknown } | { kind: "none" } = { kind: "none" };
    if (enabled) {
      if (!cronExpression) return apiError("启用定时调度必须给 cronExpression", 400, { code: "VALIDATION_FAILED" });
      const why = carrierPrereqReason(taskRow);
      if (why) return apiError(why, 409, { code: "CONFLICT" });
      try {
        const pub = await publishSyncScheduleCarrier(taskRow, String(cronExpression));
        carrier = { kind: "serverless", dagId: pub.dagId, perTarget: pub.perTarget };
      } catch (e: unknown) {
        // 🔴 发布失败**不许**把 enabled 写进库(那就是又造一个空壳)。拒因按调度类单一作者转 HTTP。
        return schedulerRejectResponse(e) ?? apiError(
          `发布定时调度载体失败:${String((e as Error)?.message ?? e)}`, 500, { code: "INTERNAL" }
        );
      }
    } else {
      const off = await offlineSyncScheduleCarrier(taskRow);
      if (!off.allRemoved) {
        return apiError(
          `有执行范围的调度产物没撤下来,记录不动(撤不下来就不许说已停用):` +
            off.failures.map((f) => `${f.targetId}: ${f.error}`).join(" | "),
          502,
          { code: "CONFLICT" }
        );
      }
    }
    await docClient.send(new UpdateCommand({
      TableName: TABLES.SYNC_TASKS,
      Key: { userId: USER_ID, taskId },
      UpdateExpression: "SET scheduleEnabled = :e, cronExpression = :c, updatedAt = :now",
      // 🔴 **修盲 Update**:DDB 的 UpdateItem 默认是 upsert —— 不存在就**建**一个只有几个字段的
      //    幽灵任务。上面的 404 是主防线,这条 ConditionExpression 是并发窗口的兜底
      //    (强读之后、写之前那一瞬被别人删掉)。两道都要:少了条件写就有 TOCTOU 缝。
      ConditionExpression: "attribute_exists(taskId)",
      ExpressionAttributeValues: { ":e": !!enabled, ":c": enabled ? cronExpression : null, ":now": new Date().toISOString() },
    }));

    // 🔴🔴 如实回「这条路**没有调度载体**」(2026-09-19 无头验收抓到):
    //   本分支只往 DynamoDB 写 cron/scheduleEnabled,**不建任何调度产物** —— 没有 DAG、没有
    //   EventBridge Scheduler(两个 region 实测各 0 条)。也就是说这个「启用调度」**永远不会触发**。
    //   实测:配 `*/10 * * * *` + 启用,等了 25 分钟一次都没跑。
    //   而页面此前的 toast 写的是「调度已启用 (EventBridge Scheduler)」、调度配置页给它打「自动调度」
    //   绿标 —— 产品在宣称一件它做不到的事,这比没有这个功能更糟。
    //   ⇒ 载体交付之前,**接口必须把真相带出去**(`carrier: "none"` + 人话 notice),由页面照实说。
    //   已交付的替代路径:用编排(工作流)里的「数据同步节点」——那条路有 DAG、有定时、真会跑。
    //   缺口已登记:同步任务自己的定时调度(需 ① 发布单节点 DAG ② `_exec_sync` 补写 run 台账,
    //   否则调度跑出来的同步在运行实例页上查不到)。
    // @kf-batch 50-WP26-sync-schedule-carrier —— 载体已交付,接口不再自报 `carrier: "none"`。
    //   🔴 这里刻意把**逐区结果**一起回出去:用户在页面上要看得见「哪个区发成了」,
    //     而不是一个笼统的「已启用」(上一版那句「已启用 (EventBridge Scheduler)」就是这么骗人的)。
    return apiOk({
      enabled: !!enabled,
      cronExpression,
      carrier: enabled ? "mwaa-serverless" : "none",
      ...(carrier.kind === "serverless" ? { dagId: carrier.dagId, perTarget: carrier.perTarget } : {}),
      notice: enabled
        ? "定时调度已启用:按任务绑定的每个执行范围各发布了一份单节点 sync 工作流到**该区**的 MWAA Serverless,到点由它触发;运行记录与日志在「任务监控」里按这个同步任务查。"
        : "已停用:每个执行范围的调度产物都已真撤下来(撤不下来不会改记录)。",
    });
  } catch (e: any) {
    return apiError(`调度配置失败: ${e.message}`, 500);
  }
}
