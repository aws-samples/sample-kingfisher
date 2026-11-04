export const dynamic = "force-dynamic";
// @kf-batch 52-P52.2-W2a-run-stamp
// 监控「运行实例」列表 —— P52.2 读侧(52 SPEC §1「读写同批上线」)+ 50 INTERACTION §3.3 region 筛选。
//
// 🔴 本批修掉的三件现网问题(52 DESIGN §12.4 已登记):
// ① **零鉴权**:改动前本路由连 `resolveIdentity` 都没有 ⇒ 任一登录用户看**全平台**所有 run
//    (任务名 + 错误信息)。现在 `requireProject(viewer)` + 按 `projectId` 过滤,
//    存量无章的 run 由 `projectFilter` 的 legacy 兜底留在默认工作区(不消失)。
// ② **`Limit` 与 `FilterExpression` 同时用**:DDB 的过滤发生在 `Limit` **之后**
//    ⇒ 带筛选时**静默少报**(极端情况:200 条里恰好没有 failed,页面就显示"没有失败"而事实相反)。
//    这与 P52.1 修过的 `redshift/history` 是同一个陷阱。根治 = **翻页扫到够数或扫完**,
//    `limit` 只作用在**过滤后**的结果上。
// ③ **join 用的四张名字表也没翻页**:超 1MB 就有任务查不到名字 ⇒ 页面显示裸 ID。
//
// 读侧分类(52 SPEC §1 P1-4):本路由是**用户视图** ⇒ 必须带项目过滤;
// finops / baseline / alerting 那些是**平台聚合** ⇒ 刻意不加,否则存量会漏算。
import { NextRequest, NextResponse } from "next/server";
import { isSeedRunTaskId, targetOfSeedRunTaskId } from "@/lib/seed/seed-job";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { requireProject, projectFilter } from "@/lib/projects/guard";
// @kf-batch 50-WP4-o1-scope —— 执行范围(50 SPEC §2.6):scope 为主轴,原有 region/targetId 筛降为次级
import { requireScope, scalarTargetOf } from "@/lib/exec-env/scope";
import { scopeIncludesTarget } from "@/lib/scope/scope";
import { listActiveTargets } from "@/lib/exec-env/registry";
// @kf-batch 50-W5-seg2-WP10a
import { auditObservedScheduledRun } from "@/lib/exec-env/residency-audit";

/** 翻页扫表。`stop` 返回 true 时提前结束(带 limit 的场景不必扫完整张表)。 */
async function scanAll(
  params: Record<string, unknown>,
  onPage: (items: Record<string, unknown>[]) => void,
  stop?: () => boolean,
  maxPages = 50
): Promise<void> {
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await docClient.send(new ScanCommand({ ...params, ExclusiveStartKey: startKey } as never));
    onPage((res.Items ?? []) as Record<string, unknown>[]);
    startKey = res.LastEvaluatedKey as never;
    if (!startKey || stop?.()) return;
  }
}

/** 名字表:只取 id + name,翻页扫全,并按调用方项目过滤(省流量也少泄露)。 */
async function nameIndex(
  table: string,
  idAttr: string,
  pf: { clause: string; values: Record<string, unknown> }
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    await scanAll(
      {
        TableName: table,
        ProjectionExpression: `${idAttr}, #n`,
        ExpressionAttributeNames: { "#n": "name" },
        FilterExpression: pf.clause,
        ExpressionAttributeValues: pf.values,
      },
      (items) => {
        for (const it of items) if (it[idAttr]) out[String(it[idAttr])] = String(it.name ?? "");
      }
    );
  } catch {
    /* 名字是展示增强,查不到就退回裸 ID —— 不因此让整个列表 500 */
  }
  return out;
}

export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;

  const p = req.nextUrl.searchParams;
  const status = p.get("status") || "";
  const taskType = p.get("taskType") || "";
  const triggeredBy = p.get("triggeredBy") || "";
  const name = p.get("name") || "";
  const startDate = p.get("startDate") || "";
  const endDate = p.get("endDate") || "";
  // 🆕 50 INTERACTION §3.3:region 筛选(UI 暴露的轴)。targetId 是更精确的轴,一并接受
  //    —— 同一 region 可能有多个 target(如 dev/prod 同区),那时只有 targetId 分得开。
  const region = p.get("region") || "";
  const targetId = p.get("targetId") || "";
  const limit = Math.min(Number(p.get("limit") || 200), 500);

  // @kf-batch 50-WP4-o1-scope —— 🔴 主轴是执行范围;region / targetId 两个老参数**降为次级**(与它取交集)。
  // 四种拒因直出 4xx,绝不回落 home/global。
  const scope = await requireScope(req, ctx.projectId);
  if (scope instanceof NextResponse) return scope;

  try {
    const pf = projectFilter(ctx.projectId);

    // ── 执行目标:targetId → region。UI 的下拉与列都靠它。 ──
    // 注册表是"部署单元量级"(个位数),整表读代价可忽略。
    const targetRegion: Record<string, string> = {};
    try {
      for (const t of await listActiveTargets()) {
        targetRegion[String(t.targetId)] = String(t.region ?? "");
      }
    } catch {
      /* 注册表读不到:region 列显示为空,但运行列表照常出(不因增强功能挂掉主功能) */
    }
    // region 筛选 → 落成 targetId 集合(空集 = 该 region 没有任何 target ⇒ 结果必然为空,honest)
    const regionTargets = region
      ? new Set(Object.entries(targetRegion).filter(([, r]) => r === region).map(([id]) => id))
      : null;

    // ── run 扫描:过滤条件全部下推给 DDB,但 **limit 只作用在过滤后的结果上** ──
    const filterParts: string[] = [pf.clause];
    const attrNames: Record<string, string> = {};
    const attrValues: Record<string, unknown> = { ...pf.values };
    if (status) {
      filterParts.push("#st = :st");
      attrNames["#st"] = "status";
      attrValues[":st"] = status;
    }
    if (taskType) {
      filterParts.push("taskType = :tt");
      attrValues[":tt"] = taskType;
    }
    if (triggeredBy) {
      filterParts.push("triggeredBy = :tb");
      attrValues[":tb"] = triggeredBy;
    }
    if (targetId) {
      filterParts.push("targetId = :tid");
      attrValues[":tid"] = targetId;
    }

    const runs: Record<string, unknown>[] = [];
    await scanAll(
      {
        TableName: TABLES.TASK_RUNS,
        FilterExpression: filterParts.join(" AND "),
        ...(Object.keys(attrNames).length > 0 ? { ExpressionAttributeNames: attrNames } : {}),
        ExpressionAttributeValues: attrValues,
      },
      (items) => runs.push(...items),
      // 🔴 提前结束的判据是**已过滤到手的条数**,不是"扫过的条数" —— 这正是原实现错的地方。
      //    统计口径与列表同源,所以这里放宽到 limit 的若干倍,避免统计被列表上限截断。
      () => runs.length >= limit * 5
    );

    // @kf-batch 50-W5-seg2-WP10a —— 观测后审计:监控列表里出现的**定时** run 若在跨法域 target 上且尚无区域审计 ⇒ 现在补写
    //    (SPEC v3.23 §3.2;幂等 pending 抢占协议;非定时 / home 行零 I/O;失败不影响列表)
    await Promise.all(
      runs.map(async (r) => {
        const res = await auditObservedScheduledRun({ taskId: String(r.taskId ?? ""), runId: String(r.runId ?? ""), targetId: r.targetId, triggeredBy: r.triggeredBy, residencyAuditId: r.residencyAuditId });
        if (res.auditId) r.residencyAuditId = res.auditId;
      })
    );

    const nameMap: Record<string, string> = {};
    const [syncNames, wfNames, etlNames, engineNames, actionNames] = await Promise.all([
      nameIndex(TABLES.SYNC_TASKS, "taskId", pf),
      nameIndex(TABLES.WORKFLOWS, "workflowId", pf),
      nameIndex(TABLES.ETL_JOBS, "jobId", pf),
      nameIndex(TABLES.ENGINE_JOBS, "jobId", pf),
      // @kf-batch 50-WP28-platform-action-node —— 平台动作的调度对象(治理定时任务 / 卡片定时刷新)
      //   🔴 少这一张表,它们的 run 行在监控页上只剩一截裸 id(「接口 200 而用户认不出这是哪次运行」)
      nameIndex(TABLES.ACTION_SCHEDULES, "taskId", pf),
    ]);
    Object.assign(nameMap, syncNames, wfNames, etlNames, engineNames, actionNames);
    const etlIds = new Set(Object.keys(etlNames));
    const syncIds = new Set(Object.keys(syncNames));

    let enriched = runs.map((r: Record<string, unknown>) => {
      const tid = String(r.targetId ?? "");
      const rTaskId = String(r.taskId ?? "");
      return {
        taskId: r.taskId,
        runId: r.runId,
        status: r.status,
        duration: r.duration,
        // B1: surface row metrics so the monitor UI shows real 读取/写入 counts (not blank/0).
        metrics: r.metrics || null,
        error: r.error,
        finishedAt: r.finishedAt,
        airflowDagId: r.airflowDagId,
        // 🆕 归属两维直接回给前端:region 列 + "这条 run 在哪跑的"一眼可辨。
        projectId: r.projectId ?? null,
        targetId: r.targetId ?? null,
        // @kf-batch 50-W5-seg2-WP10a —— 跨法域 run 的区域审计 ID(运行历史「审计」列;home 为 null)
        residencyAuditId: r.residencyAuditId ?? null,
        region: tid ? targetRegion[tid] ?? "" : "",
        // @kf-batch 50-CAPSEED-seed-dispatch —— 手动造数的台账对象是「每区一个」(`seed_<targetId>`),不在任何名字表里
        //   ⇒ 给它一个人话名字,而不是一截裸 id(定时那次记在调度对象名下,名字从 bgp-action-schedules 来)
        taskName: nameMap[rTaskId] || (isSeedRunTaskId(rTaskId) ? `造数 · ${targetOfSeedRunTaskId(rTaskId)}` : rTaskId.slice(-12)),
        taskType:
          r.taskType ||
          (syncIds.has(rTaskId) ? "sync" : etlIds.has(rTaskId) ? "etl" : "workflow"),
        triggeredBy: r.triggeredBy || (String(r.runId ?? "").startsWith("scheduled") ? "schedule" : "manual"),
        startedAt: r.startedAt || r.finishedAt || null,
      };
    });

    // region 筛选在 enrich 之后做:它要 targetId → region 的映射(DDB 侧无此维度)。
    if (regionTargets) enriched = enriched.filter((r) => r.targetId && regionTargets.has(String(r.targetId)));

    // Name filter (post-query, since name is from join)
    if (name) {
      const q = name.toLowerCase();
      enriched = enriched.filter((r) => r.taskName?.toLowerCase().includes(q));
    }
    // Date range filter
    if (startDate) enriched = enriched.filter((r) => (r.startedAt || "") >= startDate);
    if (endDate) enriched = enriched.filter((r) => (r.startedAt || "") <= endDate + "T23:59:59");

    // @kf-batch 50-WP4-o1-scope
    // 🔴 **护栏 1 的数字必须与列表同一口径**:run 列表是**带时间窗/带筛选**的,所以
    // 「其他执行范围还有 N 条」不能去问 `/api/scope/counts`(那是不带窗口的全表计数,必然对不上,
    // 会让判据 E-151 假红)。⇒ 就在这条查询里顺手按 target 分组,随响应回给前端(SPEC v3.35 §2.6.6)。
    // 🔴 因此 scope **不下推给 DDB**:下推了就数不到「别的区还有多少条」。run 表虽大,但上面的
    // 提前结束把它钉在 limit*5 以内,代价有界。
    const countsByTarget: Record<string, number> = {};
    for (const r of enriched) {
      const t = scalarTargetOf(r as unknown as Record<string, unknown>, "run");
      countsByTarget[t] = (countsByTarget[t] ?? 0) + 1;
    }
    // 🔴 存量无 targetId 的 run 归 home(与 `scopeFilter` / `bindingTargets` 同一条回落),
    //    否则 home 视角会比 DDB 少报 —— 而判据是拿 DDB 逐行核对的。
    enriched = enriched.filter((r) =>
      scopeIncludesTarget(scope, scalarTargetOf(r as unknown as Record<string, unknown>, "run"))
    );

    enriched.sort((a, b) =>
      String(b.startedAt || b.finishedAt || "").localeCompare(String(a.startedAt || a.finishedAt || ""))
    );

    // Stats。@kf-batch 50-WP4-o1-scope:现在是**当前执行范围内**的集合(scope 过滤已在上面做完)——
    // 这是刻意的:切到 us-west-2 之后,KPI 卡说的就该是那个区的今日成功/失败,
    // 否则「列表按区、卡片按全部」会让人以为列表漏了行。
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const todayRuns = enriched.filter((r) => (r.startedAt || "") >= todayStart);
    const todaySuccess = todayRuns.filter((r) => r.status === "succeeded").length;
    const todayFailed = todayRuns.filter((r) => r.status === "failed").length;
    const durations = todayRuns.filter((r) => r.duration).map((r) => Number(r.duration));

    // 下拉可选项 = 活跃 target ∪ 本次结果里真实出现过的 target(退役 target 的历史 run 也筛得到)。
    const seenTargets = enriched.map((r) => String(r.targetId ?? "")).filter(Boolean);
    const targets = Array.from(new Set(Object.keys(targetRegion).concat(seenTargets))).map((id) => ({
      targetId: id,
      region: targetRegion[id] ?? "",
    }));

    return NextResponse.json({
      runs: enriched.slice(0, limit),
      total: enriched.length,
      targets,
      // @kf-batch 50-WP4-o1-scope —— 护栏 1 的数据源(**与本次查询同一时间窗、同一筛选条件**)。
      // 前端据它显示「其他执行范围还有 N 条」;这条 run 列表刻意**不用** `/api/scope/counts`(理由见上)。
      countsByTarget,
      stats: {
        running: enriched.filter((r) => r.status === "running").length,
        todayTotal: todayRuns.length,
        todaySuccess,
        todayFailed,
        successRate: todayRuns.length > 0 ? Math.round((todaySuccess / todayRuns.length) * 100) : 0,
        avgDuration: durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      },
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { runs: [], total: 0, stats: {}, error: (e as Error)?.message ?? String(e) },
      { status: 500 }
    );
  }
}
