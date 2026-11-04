// 模块 43-C — 补数实例执行器。把一个(日期,节点)实例分派到正确的执行路径,
// **一律以 triggeredBy="backfill" 写 bgp-task-runs**(在线隔离硬约束)。
//
// 复用策略(遵守设计"只调用引擎已导出方法,不改 provider/路由"):
//  · task/etl-job   → runEtlJob(job, {runDate, 'backfill'})           (Glue/Redshift SQL 作业,自轮询)
//  · task/engine-job→ getProvider(taskType).submit(job, {runDate,...}) (EMR Serverless,自轮询)
//  · task/sync-task → startGlueSyncRun({triggeredBy:"backfill", runDate, ...})(同步任务 glue 通道,与手动运行同一启动核心,自轮询)
//  · workflow/sql   → 直接跑该节点 SQL(Redshift Data API + 自建 run 记录 + 自轮询)
//  · workflow/sync  → 节点关联的同步任务走 task/sync-task 同一入口(@kf-batch 37-wf-sync-backfill)
//  · workflow/其它  → 明确失败(honest,不静默跳过):python 等节点补数本期不支持
//
// 返回 { runTaskId, runId, statementId?, glueJobName?, glueJobRunId? } —— runner 据此在
// reconcile 时读 bgp-task-runs 终态回收实例状态。执行为「即发即轮询」:submit 后台自己跑到终态
// 回写 run 记录,runner 只需读 run 记录判定,与模块33/16 现有补数完全同构。

import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { BatchExecuteStatementCommand, DescribeStatementCommand } from "@aws-sdk/client-redshift-data";
// B-66:SQL 语句切分的唯一作者(与工作流发布 buildDagSpec / 离线 Redshift 作业同源)
import { splitSql } from "@/lib/etl/dag-generator";
import { redshiftClientForHomeOnly } from "@/lib/exec-env/target-clients";
// @kf-batch 52-P52.2-W2a-run-stamp — task-runs 唯一写通道(50 SPEC §6 S10)。
import { putRunRecord, updateRunRecord, resolveRunStamp, type RunOwner } from "@/lib/monitor/run-records";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { runEtlJob } from "@/lib/etl/job-service";
// @kf-batch 50-P50.3-mrquery
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
import { getRedshiftSecretArn } from "@/lib/redshift/admin-secret";
import { renderTemplate, paramSet, todayDs } from "@/lib/etl/run-params";
import { isEngineType, getProvider } from "@/lib/engines/registry";
import { nodeSupportsBackfill } from "@/lib/workflow/node-registry";
// @kf-batch 50-P50.3-multibind —— `lockAttrFor` 是锁属性名的**唯一作者**(SPEC §3.6)。
import { acquireRunLock, releaseRunLock, renewRunLockIfDue, keepRunLockForReconcile, lockAttrFor, RunLockBusy } from "@/lib/etl/run-lock";
import type { EtlJob } from "@/types/etl-job";
import type { BackfillInstanceRow, BackfillPlanRow } from "./types";
import { runSyncTaskBackfillInstance } from "./sync-task";
// 序 73 模块 57(R6)—— 离线作业节点:作业行的读取与三道判定(存在 / 本项目 / 绑定含该区)与发布期同一作者;补数标记字段的唯一作者
import { loadJobNodeRow } from "@/lib/workflow/job-node-spec";
import { backfillRunExtra } from "./run-extra";
// @kf-batch 50-P50.1-workgroup-ssot — 数仓落点唯一出口(收编兜底字面量)。
import { homeWorkgroup } from "@/lib/redshift/warehouse-location";
// @kf-batch 50-SEQ47b-backfill-observability —— 序 47b(B-101):工作流 SQL 节点补数把受影响行数写进 run 行 `metrics.rowsAffected`(唯一作者)
import { affectedRowsMetrics } from "@/lib/redshift/affected-rows";

const USER_ID = "default-user";
// @kf-batch 50-WP2-directquery —— 合同 home-only:**编排表没有区域维**(实测 bgp-workflows 无 target 字段)
// ⇒ workflow SQL 节点的补数只能在主控区跑;给它加维 = WP-14。锁属性那边已经按 `wf.targetId` 算,
// 那是**为 WP-14 预留的参数位**,不代表这条执行路径已经能跨区。
const rsData = redshiftClientForHomeOnly("workflow-no-target-dim");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ExecResult {
  runTaskId: string; // bgp-task-runs 的 taskId(reconcile 用)
  runId: string; // bgp-task-runs 的 runId(ULID)
}

// ── 执行单个实例 ──(仅启动 + 挂后台轮询;不阻塞 tick)
export async function executeInstance(plan: BackfillPlanRow, inst: BackfillInstanceRow): Promise<ExecResult> {
  const runDate = inst.date.length > 10 ? inst.date.slice(0, 10) : inst.date; // hour 粒度取日
  const { scope, kind, id: targetId } = plan.target;

  if (scope === "task") {
    if (kind === "etl-job") {
      const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.ETL_JOBS, Key: { userId: USER_ID, jobId: targetId } }));
      if (!Item) throw new Error("ETL 作业不存在");
      // @kf-batch 50-P50.3-mrquery
      // 🔴 **实例自带 targetId**(补数实例的维度已升为 日期 × 节点 × target,见 `plan.ts`)⇒
      // 直接按它执行。原实现不传 targetId ⇒ `runRedshiftSqlJob` 取 `bindingTargets(job)[0]`
      // (通常是 home)⇒ 多区绑定的作业**只补第一个区、另一个区仍是空的**(静默只补一半,
      // 而这类错要等到有人对数才发现)。
      // 🔴 实例上没有 targetId(存量实例)⇒ 回落到绑定的第一个,与改动前逐字节一致。
      const instTarget = inst.targetId || bindingTargets(Item as EtlJob)[0];
      const res = await runEtlJob(Item as EtlJob, { runDate, triggeredBy: "backfill", targetId: instTarget });
      return { runTaskId: targetId, runId: res.runId };
    }
    if (kind === "engine-job") {
      const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.ENGINE_JOBS, Key: { userId: USER_ID, jobId: targetId } }));
      if (!Item) throw new Error("引擎作业不存在");
      const engineType = String((Item as any).engine || "emr-serverless");
      if (!isEngineType(engineType)) throw new Error(`未知引擎类型 ${engineType}`);
      // @kf-batch 50-B51-backfill-pump —— 🔴 B-51a:与上面 etl-job 同一条纪律,**按实例自带的 targetId 提交**。
      // 原来不传 ⇒ provider 缺省 `tgt_home` ⇒ 绑两区的 EMR 作业两区实例**都在主控区跑**(主控区跑两遍、
      // 非主控区一天也没补),而页面显示成功。存量实例没有 targetId ⇒ 回落绑定的第一个(与改动前一致)。
      const instTarget = inst.targetId || bindingTargets(Item as { targets?: unknown; targetId?: unknown })[0];
      const res = await getProvider(engineType).submit(Item as any, { runDate, triggeredBy: "backfill", targetId: instTarget });
      return { runTaskId: targetId, runId: res.runId };
    }
    if (kind === "sync-task") {
      // @kf-batch 37-sync-backfill —— 序 37 ⑦:与手动运行同一个启动核心(triggeredBy=backfill、--ds=实例日期、带补数计划号);
      // 入口判定与「能不能补」在 sync-task.ts(任务可能在建计划之后被改过,执行时再判一次)。
      return runSyncTaskBackfillInstance(targetId, inst, runDate);
    }
    throw new Error(`不支持的补数目标类型 ${kind}`);
  }

  // workflow 作用域:执行单个 DAG 节点。
  const { Item: wf } = await docClient.send(new GetCommand({ TableName: TABLES.WORKFLOWS, Key: { userId: USER_ID, workflowId: targetId } }));
  if (!wf) throw new Error("工作流不存在");
  const node = ((wf as any).dagDefinition?.nodes || []).find((n: any) => String(n.id) === inst.nodeId);
  if (!node) throw new Error(`节点 ${inst.nodeId} 不存在`);

  // 33-B: 补数白名单从 node-registry(SSOT)取,替代硬编码 node.type==="sql"。
  // 白名单内按类型分派(sql / sync);其余节点 honest 失败(不静默跳过)。
  if (nodeSupportsBackfill(node.type) && node.type === "sql") {
    const sql = node.data?.sql;
    if (!sql || !String(sql).trim()) throw new Error("SQL 节点脚本为空");
    // @kf-batch 52-P52.2-W2a-run-stamp
    // ⚠️ 本函数里的局部变量 `targetId` 是**补数目标的 id**(工作流/作业 id),
    // 与模块 50 的执行目标 `targetId`(`tgt_*`)**同名不同物**。盖章要的是后者,
    // 它在工作流行 `wf.targetId` 上 ⇒ 把整行传下去,别传这个局部变量。
    return runWorkflowSqlNode(wf as RunOwner & { workflowId: string }, inst, String(sql), runDate);
  }
  if (nodeSupportsBackfill(node.type) && node.type === "sync") {
    // @kf-batch 37-wf-sync-backfill —— 序 37:工作流里的数据同步节点 = 用实例日期跑一次它关联的同步任务。
    // 字段名 `data.syncTaskId` 与节点执行器(workflow/dag-generator.ts、runtime-lib.ts、scheduler/serverless/runtime-py.ts
    // 的 `data.get("syncTaskId")`)及 node-registry 的 validate 同源 —— 调度跑的和补数跑的是同一个任务。
    const syncTaskId = String(node.data?.syncTaskId || "").trim();
    if (!syncTaskId) throw new Error(`数据同步节点「${node.data?.label || inst.nodeId}」未关联同步任务`);
    // 走 task 作用域同一个入口(能不能补 / 章反向卡 / 跨区取数 / 空活 → 启动核心,唯一作者在 sync-task.ts)。
    // 🔴 实例的 targetId 是**工作流**的章(工作流补数目前 home-only):同步任务若绑在别的区,反向卡会如实拒绝 ——
    //    那样的工作流本来就跨区引用了任务,定时跑也到不了那个区的 Glue 作业;不替它挑一个区去跑。
    // run 记录落在**同步任务**名下(taskType=sync,triggeredBy=backfill,带 runDate / backfillPlanId),
    // 返回的 runTaskId = 同步任务 id ⇒ runner 按 (runTaskId, runId) 回收终态,与 task 作用域的 sync-task 完全同构。
    return runSyncTaskBackfillInstance(syncTaskId, inst, runDate);
  }

  if (nodeSupportsBackfill(node.type) && node.type === "job") {
    // 序 73 模块 57(R6):离线作业节点补数 = 用实例日期跑一次它引用的作业 —— ETL ⇒ runEtlJob、EMR ⇒ provider.submit,
    //   与「立即运行」同一个启动核心(同一个按区 Glue 作业名 / 同一个 application / 同一把作业锁);run 行落在**作业**名下
    //   (triggeredBy=backfill,带 backfillPlanId / backfillNode,与 SQL 节点同形),返回 runTaskId = 作业 id ⇒ runner 按 (runTaskId, runId) 回收终态。
    // 🔴 实例的区 = 工作流的章;作业必须绑在这个区 —— 与发布期同一判定(loadJobNodeRow:不存在 / 不属本项目 / 不绑该区 ⇒ 如实失败,不替它挑区)。
    const wfTarget = inst.targetId || bindingTargets(wf as { targets?: unknown; targetId?: unknown })[0];
    const loaded = await loadJobNodeRow(node, wf as { projectId?: string }, wfTarget);
    const backfill = { planId: inst.planId, nodeId: inst.nodeId };
    if (loaded.kind === "etl") {
      const res = await runEtlJob(loaded.job, { runDate, triggeredBy: "backfill", targetId: wfTarget, backfill });
      return { runTaskId: loaded.job.jobId, runId: res.runId };
    }
    const res = await getProvider("emr-serverless").submit(loaded.job, { runDate, triggeredBy: "backfill", targetId: wfTarget, backfill });
    return { runTaskId: loaded.job.jobId, runId: res.runId };
  }

  // 非补数白名单节点:本期不支持补数(honest 失败,不静默跳过)。
  throw new Error(`节点类型「${node.type}」暂不支持补数(支持 SQL 节点、数据同步节点、离线作业节点与作业级补数)`);
}

// ── 直接执行 workflow SQL 节点:自建 run 记录(triggeredBy=backfill)+ 后台轮询到终态 ──
// run 记录挂在 workflowId 名下(taskType=workflow),带 backfill 标记 → 监控/基线天然排除。
async function runWorkflowSqlNode(
  wf: RunOwner & { workflowId: string },
  inst: BackfillInstanceRow,
  sql: string,
  runDate: string
): Promise<ExecResult> {
  const workflowId = wf.workflowId;
  const rendered = renderTemplate(sql, paramSet(runDate || todayDs()));
  // B-66:语句切分改走唯一作者 splitSql(与工作流发布 / 离线作业同一把刀;规则逐字相同,行为不变)
  const statements = splitSql(rendered);
  if (statements.length === 0) throw new Error("SQL 为空");
  const workgroup = homeWorkgroup();
  const database = process.env.REDSHIFT_DATABASE || "dev";

  // 根治·裂缝C:补数中心对 workflow SQL 节点补数走本独立路径(不过 job-service),同样直接 DROP+CTAS →
  // 同一 workflow 同一 node 的多个业务日期并发会撞同表 OID。加【节点级运行锁】:锁存 WORKFLOWS 行的
  // runLock_<nodeId> 属性,同节点不同日期串行、不同节点仍并行。补数场景排队等前序终态(waitMs 大)。
  // @kf-batch 50-P50.3-multibind —— 改走**唯一作者** `lockAttrFor`(SPEC §3.6 的 4 家之④)。
  // 🔴 workflow 的 nodeId 必用**原始 node.id**(370cd0c 教训);home 时产出与存量逐字节同名。
  const lockAttr = lockAttrFor({
    targetId: (wf as { targetId?: string }).targetId,
    nodeId: String(inst.nodeId),
  });
  const lock = await acquireRunLock(TABLES.WORKFLOWS, { userId: USER_ID, workflowId }, 45 * 60 * 1000, lockAttr);
  if (!lock) throw new RunLockBusy(`节点 ${inst.nodeId} 正在运行中,已跳过本次并发提交(避免并发重建同一结果表)。`);
  try {
    // @kf-batch 52-P52.5a-supply — 静态归类:**project-context**(补数跑的是某项目工作流的节点;
    // 归属取工作流行 `wf.projectId`,与该 workflow 的其它路径同一权威)。
    const SecretArn = await getRedshiftSecretArn({
      project: (wf as { projectId?: string }).projectId,
    });
    const { Id } = await rsData.send(new BatchExecuteStatementCommand({ Sqls: statements, WorkgroupName: workgroup, Database: database, ...(SecretArn ? { SecretArn } : {}) }));
    const runId = ulid();
    // @kf-batch 52-P52.2-W2a-run-stamp
    await putRunRecord({
      taskId: workflowId,
      runId,
      taskType: "workflow",
      triggeredBy: "backfill",
      stamp: resolveRunStamp(wf),
      extra: { runDate, statementId: Id, ...backfillRunExtra({ planId: inst.planId, nodeId: inst.nodeId }) },
    });
    pollRedshiftRun(wf, runId, Id!, lock).catch(() => {});
    return { runTaskId: workflowId, runId };
  } catch (e) {
    await releaseRunLock(lock); // 提交阶段失败→立即释放,不留僵尸锁
    throw e;
  }
}

async function pollRedshiftRun(
  wf: RunOwner & { workflowId: string },
  runId: string,
  statementId: string,
  lock?: any
) {
  const taskId = wf.workflowId;
  // 🔴 P0-6 订正(2026-08-29 外部审核):轮询窗口 150×2s = **5 分钟**,补数的 SQL 常远超此值
  // ⇒ 原实现在第 5 分钟释放节点锁、后端还在跑,同节点下一个日期立刻进来撞同一张表(补数正是
  // 逐日提交、最容易连撞)。现在:续租 + 只有确认终态才释放 + 耗尽保持持锁。
  let reachedTerminal = false;
  try {
    for (let i = 0; i < 150; i++) {
      await sleep(2000);
      if (!(await renewRunLockIfDue(lock))) {
        console.warn("[backfill] 轮询中丢锁,停止回写", taskId, runId);
        reachedTerminal = true;
        return;
      }
      try {
        const desc = await rsData.send(new DescribeStatementCommand({ Id: statementId }));
        if (desc.Status && ["FINISHED", "FAILED", "ABORTED"].includes(desc.Status)) {
          const status = desc.Status === "FINISHED" ? "succeeded" : "failed";
          // @kf-batch 52-P52.2-W2a-run-stamp
          await updateRunRecord({
            taskId,
            runId,
            set: {
              status,
              finishedAt: new Date().toISOString(),
              duration: desc.Duration ? Math.round(Number(desc.Duration) / 1e9) : 0,
              error: desc.Error || null,
              // 序 47b:成功时记受影响行数(补数页据它标「成功(0 行)」;失败 / 取消不写,免得把 0 当成事实)
              ...(status === "succeeded" ? affectedRowsMetrics(desc) : {}),
            },
            stamp: resolveRunStamp(wf),
          });
          reachedTerminal = true;
          return;
        }
      } catch {
        /* keep polling */
      }
    }
  } finally {
    if (reachedTerminal) await releaseRunLock(lock);
    else await keepRunLockForReconcile(lock, { jobId: taskId, runId, engine: "backfill-redshift" });
  }
}
