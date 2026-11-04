// @kf-batch 50-WP28-platform-action-node
// 🔴🔴 **白名单动作 → 执行体** 的唯一登记处。每个执行体**只调产品自己的库函数**(与手动路由同一个作者),
//    本文件只做三件事:从命令取参数 → 调库函数 → 把「能力态 / 空结果」判成失败(不许静默成功)+ 留审计。
//
// 【projectId 从命令显式来】命令行上的 `projectId` = 调度对象的归属项目(建任务时由路由盖章);
//   不读任何「当前项目」(内部调用没有请求上下文,也不许猜)。
// 【落点从命令显式来】`targetId` = 调度载体所在的那个区(DAG 自己的章);执行体只在那个区干活。
// 【审计】一律 `actor=system:action-dispatcher`、`detail.via="schedule"`,与手动那条用同一个 action 名
//   (`quality.run` / `sensitive.scan` / `exec-env.mirror-metadata`),审计页按 action 一眼看全手动 + 定时。
import { writeAuditRecord } from "@/lib/audit";
import { INTERNAL_PRINCIPAL } from "@/lib/scheduler/internal-source";
import type { ActionHandler, ActionHandlers, ExecutableCommand } from "@/lib/scheduler/action-dispatch";
import type { MirrorSource } from "@/lib/exec-env/metadata-mirror-shared";

async function auditScheduled(cmd: ExecutableCommand, action: string, resourceType: string, resourceId: string, detail: Record<string, unknown>) {
  await writeAuditRecord(
    { actor: INTERNAL_PRINCIPAL.actor },
    action,
    {
      resourceType,
      resourceId,
      targetId: cmd.targetId,
      detail: { ...detail, via: INTERNAL_PRINCIPAL.via, commandId: cmd.commandId, taskId: cmd.taskId, runId: cmd.runId, projectId: cmd.projectId },
    },
    { method: "POST", path: "/api/internal/actions/run" }
  ).catch((e) => console.error("[action-handlers] 审计写失败(动作已执行):%s", String(e)));
}

/** 质量检查:逐张表跑该区的规则(`runChecks`,与 `/api/governance/quality-run` 同一个作者)。 */
export const qualityCheckHandler: ActionHandler = async (cmd) => {
  const { runChecks } = await import("@/lib/quality/service");
  const { scopedFqn } = await import("@/lib/governance/scoped-fqn");
  const fqns = (cmd.params.fqns as string[]).map((f) => f.trim()).filter(Boolean);
  const tables: Array<Record<string, unknown>> = [];
  const dead: string[] = [];
  for (const fqn of fqns) {
    const qKey = scopedFqn(fqn, cmd.targetId);
    const out = await runChecks(qKey, { targetId: cmd.targetId, projectId: cmd.projectId });
    if ("capability" in out) {
      // 🔴 「该区没装数仓」= 一条规则都没跑 ⇒ 这次定时**失败**(手动那条是整页降级;定时没有页面,只能如实失败)
      throw new Error(`执行范围 ${cmd.targetId} 没有可用的数仓(${(out as { reason?: string }).reason ?? "unavailable"}),质量检查一条规则都没跑`);
    }
    const s = out.summary;
    tables.push({ fqn, runId: s.runId, score: s.score, passed: s.passed, failed: s.failed, errors: s.errors, total: s.total, slaBreached: s.slaBreached });
    if (s.total > 0 && s.errors === s.total) dead.push(fqn);
    await auditScheduled(cmd, "quality.run", "quality-run", qKey, { score: s.score, slaBreached: s.slaBreached, targetId: cmd.targetId });
  }
  if (dead.length) {
    // 🔴 全部规则都执行出错 = 那张表根本没被检查到(SQL 打不通 / 表不存在)—— 不许报成功
    throw new Error(`这些表的规则全部执行失败、没有一条真跑出结果:${dead.join("、")}`);
  }
  return { tables };
};

/** 敏感扫描:扫该区的表(`runSensitiveScan`,与 `/api/governance/sensitive-scan` 同一个作者)。 */
export const sensitiveScanHandler: ActionHandler = async (cmd) => {
  const { runSensitiveScan } = await import("@/lib/governance/sensitive/scan");
  const p = cmd.params as { schema?: string; tables?: string[] };
  const r = await runSensitiveScan({
    ...(p.schema ? { schema: p.schema } : {}),
    ...(Array.isArray(p.tables) && p.tables.length ? { tables: p.tables } : {}),
    scannedBy: INTERNAL_PRINCIPAL.actor,
    scope: { targetId: cmd.targetId, projectId: cmd.projectId },
  });
  if ("capability" in r) {
    throw new Error(`执行范围 ${cmd.targetId} 没有可用的数仓(${(r as { reason?: string }).reason ?? "unavailable"}),敏感扫描一张表都没扫`);
  }
  const s = r.summary;
  if (s.tablesScanned === 0) {
    // 🔴 空输入 ⇒ 零工作 ⇒ **不许报成功**(schema / 表名写错就是这个形态)
    throw new Error(`敏感扫描没有扫到任何表(schema=${p.schema ?? "全部"};tables=${(p.tables || []).join(",") || "全部"})—— 检查过滤条件`);
  }
  if (s.tablesErrored === s.tablesScanned) {
    throw new Error(`敏感扫描的 ${s.tablesScanned} 张表全部抽样失败:${r.errors.slice(0, 3).map((e) => `${e.fqn}:${e.error}`).join(" | ")}`);
  }
  await auditScheduled(cmd, "sensitive.scan", "sensitive-scan", s.scanId, {
    database: s.database, tablesScanned: s.tablesScanned, findingsHigh: s.findingsHigh, findingsMed: s.findingsMed,
  });
  return { scanId: s.scanId, tablesScanned: s.tablesScanned, tablesErrored: s.tablesErrored, findingsHigh: s.findingsHigh, findingsMed: s.findingsMed, ts: s.ts };
};

/**
 * 目录同步:采该区元数据并推进 OM(`mirrorMetadata`,与 `/api/admin/metadata-mirror` 同一个作者)。
 * 🔴 数仓目录(`redshift` 来源)会**唤醒该区的 Serverless 数仓并计费** —— 只有任务自己点名了才采
 *    (建任务的页面上明示这件事,见治理页「定时治理任务」);30 分钟的镜像定时器仍只刷 Glue。
 */
export const catalogSyncHandler: ActionHandler = async (cmd) => {
  const { mirrorMetadata } = await import("@/lib/exec-env/metadata-mirror");
  const { warehousePuller } = await import("@/lib/exec-env/metadata-mirror-warehouse");
  const sources = (cmd.params.sources as MirrorSource[]).slice();
  const r = await mirrorMetadata(cmd.targetId, {
    sources,
    pullers: { redshift: warehousePuller(cmd.projectId) },
  });
  const wanted = new Set<string>(sources);
  const reports = (r.facet.sources || []).filter((x) => wanted.has(x.source));
  const bad = reports.filter((x) => !x.ok);
  const missing = sources.filter((s) => !reports.some((x) => x.source === s));
  await auditScheduled(cmd, "exec-env.mirror-metadata", "exec-env", cmd.targetId, {
    sources: r.sources, state: r.facet.state, tables: r.facet.tables,
  });
  if (bad.length || missing.length) {
    throw new Error(
      `目录同步有来源失败:${bad.map((x) => `${x.source}: ${x.error ?? "失败"}`).concat(missing.map((m) => `${m}: 本轮没有结果`)).join(" | ")}`
    );
  }
  if (r.om && r.om.errors === -1) {
    // 🔴 镜像写好了但整体没推进 OM ⇒ 目录页(只读 OM)那个区停在上一次的样子 —— 不许报成功
    throw new Error(`元数据已采到,但推进 OpenMetadata 整体失败:${r.om.error ?? "未知"}`);
  }
  return {
    sources: reports.map((x) => ({ source: x.source, tables: x.tables, columns: x.columns, at: x.at })),
    om: r.om ? { tables: r.om.tables, errors: r.om.errors, truncated: r.om.truncated } : null,
  };
};

/**
 * 问数卡片定时刷新:替**卡片作者**重跑卡片里那条 SQL(`refreshCardOnce`,与「立即刷新」同一个作者)。
 * 🔴 执行前三道重验(fail-closed):命令确实是这张卡的调度对象发的;作者账号仍启用且仍有项目权限;
 *    卡片仍在、仍在这个区。任一不成立 ⇒ 失败并说清,不许拿一个已被移出项目的人的身份继续取数。
 */
export const cardRefreshHandler: ActionHandler = async (cmd) => {
  const { refreshCardOnce, cardScheduleTaskId } = await import("@/lib/genbi/cards-refresh");
  const { assertCardAuthorStillAuthorized, assertCardStillSchedulable } = await import("@/lib/genbi/cards-schedule");
  const p = cmd.params as { cardId: string; ownerSub: string; ownerUsername: string; turnIndex?: number };
  if (cmd.taskId !== cardScheduleTaskId(p.cardId)) {
    throw new Error(`命令的来源调度对象 ${cmd.taskId ?? "(空)"} 不是这张卡片的定时(${cardScheduleTaskId(p.cardId)})—— 拒绝执行`);
  }
  await assertCardAuthorStillAuthorized(p.ownerUsername, p.ownerSub, cmd.projectId);
  await assertCardStillSchedulable(p.ownerSub, p.cardId, cmd.targetId, cmd.projectId);
  const r = await refreshCardOnce(p.ownerSub, p.cardId, {
    triggeredBy: "schedule",
    actor: { kind: "schedule", authorSub: p.ownerSub },
    ...(p.turnIndex !== undefined ? { turnIndex: p.turnIndex } : {}),
  });
  await auditScheduled(cmd, "genbi.card.refresh", "genbi-card", p.cardId, {
    snapshotId: r.snapshotId, rowCount: r.rowCount, turnIndex: r.turnIndex,
  });
  return { cardId: r.cardId, snapshotId: r.snapshotId, rowCount: r.rowCount, turnIndex: r.turnIndex, refreshedAt: r.refreshedAt };
};

/**
 * @kf-batch 50-CAPSEED-seed-dispatch
 * 造数:在该区跑一次部署期的造数作业(`runSeedOnce`,与 `/api/seed/run` 同一个作者),**等到终态**。
 * 🔴 失败 / 作业不存在 / 已有一轮在跑 ⇒ 抛 ⇒ 命令 failed ⇒ DAG 的 task 失败(不许静默成功)。
 *    run 台账由 DAG 的 `__start` / `__finish` 收口(taskType=seed),这里不另写一行。
 */
export const seedRunHandler: ActionHandler = async (cmd) => {
  const { runSeedOnce } = await import("@/lib/seed/run-once");
  const r = await runSeedOnce({
    targetId: cmd.targetId,
    dataset: String(cmd.params.dataset),
    projectId: cmd.projectId,
    trigger: "schedule",
  });
  await auditScheduled(cmd, "seed.run", "seed", r.jobName, {
    jobRunId: r.jobRunId, region: r.region, state: r.state, dataset: cmd.params.dataset,
  });
  return { jobName: r.jobName, jobRunId: r.jobRunId, region: r.region, state: r.state, executionTimeSec: r.executionTimeSec ?? 0 };
};

/**
 * 🔴 **白名单动作 → 执行体**(判据钉:白名单里每一条都有执行体,执行体不多出白名单之外的 id)。
 */
export const ACTION_HANDLERS: ActionHandlers = {
  "governance.quality-check": qualityCheckHandler,
  "governance.sensitive-scan": sensitiveScanHandler,
  "governance.catalog-sync": catalogSyncHandler,
  "genbi.card-refresh": cardRefreshHandler,
  "seed.run-once": seedRunHandler,
};
