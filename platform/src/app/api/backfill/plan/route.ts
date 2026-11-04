export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
// @kf-batch 50-P50.3-mrquery
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
import { recordAudit } from "@/lib/audit";
import { previewInstances, createPlan } from "@/lib/backfill/service";
// @kf-batch 37-wf-sync-backfill —— 「强制并发」唯一判定出口(同步任务 = 1;含同步节点的工作流同理)
import { BACKFILL_TARGET_KINDS, forcedBackfillConcurrency } from "@/lib/backfill/types";
import type { BackfillGranularity, BackfillScope, BackfillTargetKind, CreatePlanInput } from "@/lib/backfill/types";
// @kf-batch 37-sync-backfill —— 同步任务「能不能补」的唯一作者
import { syncTaskBackfillRejection } from "@/lib/backfill/sync-task";
import { DEFAULT_PROJECT_ID } from "@/lib/projects/constants";

const USER_ID = "default-user";
const MAX_INSTANCES_HARD = 500; // 全局天花板上界(计划自身 maxInstances 不得超此)

// 校验入参并构造 CreatePlanInput + 取 workflow DAG(cascade 需要)。
async function build(req: NextRequest, projectId: string, createdBy: string, body: any): Promise<{ input: CreatePlanInput; dag?: any } | string> {
  const scope = body?.target?.scope as BackfillScope;
  const kind = body?.target?.kind as BackfillTargetKind;
  const id = String(body?.target?.id || "");
  if (!id) return "缺少补数目标 id";
  if (scope !== "task" && scope !== "workflow") return "target.scope 应为 task 或 workflow";
  if (!(BACKFILL_TARGET_KINDS as readonly string[]).includes(kind)) return "target.kind 非法";
  if (scope === "workflow" && kind !== "workflow") return "workflow 作用域的 kind 必须为 workflow";
  if (scope === "task" && kind === "workflow") return "task 作用域不支持 workflow kind";

  const granularity = (body?.dateRange?.granularity || "day") as BackfillGranularity;
  const dateRange = { start: String(body?.dateRange?.start || ""), end: String(body?.dateRange?.end || ""), granularity };
  const cascade = !!body?.cascade;
  if (cascade && scope !== "workflow") return "仅 workflow 作用域支持级联下游(cascade)";
  // 客户端要的并发(1..10,缺省 2);有强制并发的目标(同步任务 / 含同步节点的工作流 = 1)在取到 DAG 之后由
  // `forcedBackfillConcurrency` 一处判定并覆盖(@kf-batch 37-sync-backfill / 37-wf-sync-backfill)。
  const requestedConcurrency = Math.max(1, Math.min(10, parseInt(body?.concurrency, 10) || 2));
  const maxInstances = Math.max(1, Math.min(MAX_INSTANCES_HARD, parseInt(body?.maxInstances, 10) || 100));

  // 取目标名 + (workflow)DAG。
  let name = "";
  let taskType: string | undefined;
  let dag: any;
  // @kf-batch 50-P50.3-mrquery
  // 🔴 **执行目标从资源行解析,绝不接受客户端指定** —— 客户端能挑"补到哪个区"就等于绕过绑定。
  // 单绑(存量全部)时展开结果与改动前**逐字节相同**。
  let execTargets: string[] = ["tgt_home"];
  if (kind === "etl-job") {
    const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.ETL_JOBS, Key: { userId: USER_ID, jobId: id } }));
    if (!Item) return "ETL 作业不存在";
    name = Item.name; taskType = Item.type === "glue" ? "etl-glue" : "etl-redshift";
    execTargets = bindingTargets(Item);
  } else if (kind === "engine-job") {
    const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.ENGINE_JOBS, Key: { userId: USER_ID, jobId: id } }));
    if (!Item) return "引擎作业不存在";
    name = Item.name; taskType = "emr-serverless";
    // 引擎作业(EMR)本期没有 target 绑定写入路径 ⇒ 归一到 home(与它的执行路径一致)。
    execTargets = bindingTargets(Item);
  } else if (kind === "sync-task") {
    // @kf-batch 37-sync-backfill —— 序 37 ⑦:同步任务补数(glue 通道 + 用到了日期变量;每个业务日期一个实例)。
    if (granularity === "hour") return "同步任务按业务日期补数,只支持按天 / 按周";
    const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId: id } }));
    // 跨项目的任务按「不存在」回(与目标下拉的项目过滤同一口径:存量无 projectId 的行属默认工作区)
    if (!Item || (Item.projectId || DEFAULT_PROJECT_ID) !== projectId) return "同步任务不存在";
    const reject = syncTaskBackfillRejection(Item);
    if (reject) return reject;
    name = Item.name; taskType = "sync";
    // 同步任务只有一个章(建任务时由数据源的落点派生)⇒ 展开出的每个实例都带这个章。
    execTargets = bindingTargets(Item);
  } else {
    const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.WORKFLOWS, Key: { userId: USER_ID, workflowId: id } }));
    if (!Item) return "工作流不存在";
    name = Item.name; dag = Item.dagDefinition;
    execTargets = bindingTargets(Item);
    // @kf-batch 50-B51-backfill-pump —— 🔴 B-51b:工作流补数的执行合同是 **home-only**
    // (`backfill/execute.ts` 的 SQL 节点走 `redshiftClientForHomeOnly("workflow-no-target-dim")` + 主控区工作组)。
    // 原来照绑定区展开 ⇒ 非主控区的实例**实际在主控区执行**(主控区跑两遍、那个区一天没补),页面却显示成功。
    // ⇒ 绑了非主控区就**如实拒绝**(不静默只补主控区那一半),给出路。
    const nonHome = execTargets.filter((t) => t !== "tgt_home");
    if (nonHome.length > 0) {
      return `工作流补数目前只支持主控区:该工作流绑定了 ${nonHome.join(", ")}。请对单个离线作业做补数,或改为只绑定主控区后再补`;
    }
  }

  // @kf-batch 37-wf-sync-backfill —— 强制并发只有这一个判定出口;客户端传值在这里被覆盖(同步任务与改动前逐字节同值 = 1)。
  const concurrency = forcedBackfillConcurrency({ kind, dag }) ?? requestedConcurrency;

  const input: CreatePlanInput = {
    projectId,
    name: String(body?.name || `补数-${name}`).slice(0, 120),
    createdBy,
    target: { id, scope, kind, name, taskType },
    dateRange,
    cascade,
    concurrency,
    maxInstances,
    execTargets,
  };
  return { input, dag };
}

// POST /api/backfill/plan  { target:{id,scope,kind}, dateRange:{start,end,granularity}, cascade, concurrency, maxInstances, dryRun? }
// dryRun=true(默认):只展开预览(不落库);dryRun=false:确认落库并置 planned(等 tick 推进)。
export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  try {
    const built = await build(req, ctx.projectId, ctx.identity.username, body);
    if (typeof built === "string") return apiError(built, 400, { code: "VALIDATION_FAILED" });

    if (body?.dryRun === false) {
      const plan = await createPlan(built.input, built.dag);
      recordAudit(req, "backfill.plan.create", {
        resourceType: "backfill-plan",
        resourceId: plan.planId,
        detail: { target: built.input.target.name, total: plan.progress.total, cascade: built.input.cascade },
      }).catch(() => {});
      return apiOk(plan, 201);
    }
    // dry-run 预览。
    const specs = previewInstances(built.input, built.dag);
    return apiOk({ count: specs.length, preview: specs.slice(0, 200), input: built.input });
  } catch (e: any) {
    return apiError(e?.message || "补数计划创建失败", 400, { code: "VALIDATION_FAILED" });
  }
}
