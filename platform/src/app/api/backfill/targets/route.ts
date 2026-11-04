export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject, projectFilter } from "@/lib/projects/guard";
// 🔴 补数目标下拉必须按执行范围过滤。
// 三张表的行上都已有定义级的区章(`targets[]`),而这里此前**一个区维都没有** ⇒ 在 us-west-2
// 视角下拉里照样列出只在主控区能跑的作业,选中它建的补数计划**必然失败**;更坏的是 `/alerting`
// 的 SLA 面板也读这个接口,于是「给哪个任务定 SLA」的候选也是跨区混的。
import { readScope, filterRowsByScope } from "@/lib/exec-env/scope";
// 同步任务「能不能补」的唯一作者
import { syncTaskBackfillRejection } from "@/lib/backfill/sync-task";

const USER_ID = "default-user";

// GET /api/backfill/targets — 可补数目标统一列表(ETL 作业 / EMR 引擎作业 / 工作流;`?include=sync-task` 时加同步任务),
// 归一成 {id,name,scope,kind,taskType,nodeCount?}。供 /backfill 向导目标下拉。viewer。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const pf = projectFilter(ctx.projectId);
  try {
    const scan = (table: string) => docClient.send(new ScanCommand({
      TableName: table,
      FilterExpression: `userId = :uid AND ${pf.clause}`,
      ExpressionAttributeValues: { ":uid": USER_ID, ...pf.values },
    })).then((r) => r.Items || []).catch(() => []);

    const [etlAll, engineAll, wfAll] = await Promise.all([scan(TABLES.ETL_JOBS), scan(TABLES.ENGINE_JOBS), scan(TABLES.WORKFLOWS)]);
    // 同步任务只在**显式要**时才列(`?include=sync-task`,补数页这么发)。
    // 🔴 本接口还有一个消费者:告警页 SLA 面板(components/alerting/SlaPanel.tsx)拿它当「给哪个任务定 SLA」的候选;
    //    不带该参数 ⇒ 响应与改动前逐字节相同,SLA 面板不被顺带改变。
    const includeSync = req.nextUrl.searchParams.get("include") === "sync-task";
    const syncAll = includeSync ? await scan(TABLES.SYNC_TASKS) : [];

    // 🔴 `readScope` 回 null(= 未传 `?scope=` / 全局)时 `filterRowsByScope` 原样返回 ⇒
    // 响应与改动前逐字节相同(回滚点)。无章的存量行由 `bindingTargetsOf` 统一回落主控区。
    const scope = readScope(req);
    const keep = <T extends Record<string, unknown>>(rows: T[]) => (scope ? filterRowsByScope(rows, scope) : rows);
    const [etl, engine, wf] = [keep(etlAll as any[]), keep(engineAll as any[]), keep(wfAll as any[])];
    // 只列 glue 通道(zero-etl / dms 是持续复制,根本不是补数对象);能列但补不了的带上原因,页面置灰并说明。
    const sync = keep(syncAll as any[]).filter((t: any) => (t.channel || "glue") === "glue");

    const targets = [
      ...etl.map((j: any) => ({ id: j.jobId, name: j.name, scope: "task", kind: "etl-job", taskType: j.type === "glue" ? "etl-glue" : "etl-redshift" })),
      ...engine.map((j: any) => ({ id: j.jobId, name: j.name, scope: "task", kind: "engine-job", taskType: "emr-serverless" })),
      // 多带 `nodeTypes`(去重的节点类型集合;纯追加字段):向导据此在选中含同步节点的工作流时
      //   提前说明「并发固定为 1」并锁住并发框(与同步任务目标同一套 UX),而不是等预览 / 建计划后才发现并发被改了。
      ...wf.map((w: any) => {
        const nodes: Array<{ type?: unknown }> = w.dagDefinition?.nodes || [];
        const nodeTypes = Array.from(new Set(nodes.map((n) => String(n?.type || "")).filter(Boolean)));
        return { id: w.workflowId, name: w.name, scope: "workflow", kind: "workflow", taskType: "workflow", nodeCount: nodes.length, nodeTypes };
      }),
      ...sync.map((t: any) => {
        const reason = syncTaskBackfillRejection(t);
        return { id: t.taskId, name: t.name, scope: "task", kind: "sync-task", taskType: "sync", ...(reason ? { unavailableReason: reason } : {}) };
      }),
    ];
    return apiOk({ targets });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
