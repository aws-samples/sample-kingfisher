export const dynamic = "force-dynamic";

// 多区扇出的唯一写法(L10)
import { forEachTargetPlace } from "@/lib/place/fanout";
import { NextRequest, NextResponse } from "next/server";
// targets 子集的唯一解析作者
import { requestedSubset } from "@/lib/place/resolve";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { TargetBindingRejected, bindingTargets } from "@/lib/exec-env/data-plane-target";
import { runGlueScriptJob, runRedshiftSqlJob, dryRunRedshiftSqlJob } from "@/lib/etl/job-service";
import { runGroupIdFor, isRunGroupId } from "@/lib/monitor/run-group";
// O2:扇出前建组行(严格) / 逐 target 记账(尽力);503 映射单一作者
import { openRunGroupIfFanout, noteFanoutResult } from "@/lib/monitor/run-groups";
import { runGroupWriteErrorResponse } from "@/lib/monitor/run-group-http";
import { resolveRunStamp } from "@/lib/monitor/run-records";
import { currentDefinitionVersion } from "@/lib/versions/version-service";
import { isValidDs } from "@/lib/etl/run-params";
import { recordAudit } from "@/lib/audit";
// 抢不到运行锁 = 用户可修 ⇒ 409(锁的单一作者导出这个类型)
import { RunLockBusy } from "@/lib/etl/run-lock";
import { guardResourceAccess } from "@/lib/projects/guard";
import type { EtlJob } from "@/types/etl-job";
// 同意前置 + 残留错误映射;区域审计在 job-service 内逐 target 写
import { requireResidencyAckForTargets, residencyErrorResponse, userActor } from "@/lib/exec-env/residency-audit";
import { AuditUnavailable, ResidencyAckRequired } from "@/lib/exec-env/residency";

const USER_ID = "default-user";

// POST /api/etl-jobs/[id]/run  body { runDate?, dryRun? }
// runDate (YYYY-MM-DD) parameterizes ${ds} etc.; dryRun (Redshift only) validates via EXPLAIN
// without mutating data.
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.ETL_JOBS, Key: { userId: USER_ID, jobId: params.id } })
  );
  if (!Item) return apiError("作业不存在", 404);
  const guard = await guardResourceAccess(req, Item, "editor");
  if (guard instanceof NextResponse) return guard;
  const job = Item as EtlJob;
  if (!job.script || !job.script.trim()) return apiError("脚本为空，请先编写脚本");

  const body = await req.json().catch(() => ({}));
  const runDate = body?.runDate || undefined;
  if (runDate && !isValidDs(runDate)) return apiError("runDate 格式应为 YYYY-MM-DD");
  const dryRun = Boolean(body?.dryRun);
  if (dryRun && job.type !== "redshift") return apiError("试运行目前仅支持 Redshift SQL 作业");

  // 🔴 **运行扇出**:一个定义绑了 N 个区,点一次「运行」就该在 N 个区各跑一次
  // (一条 run 只发生在一个区 —— run 记录的 `targetId` 是单值,扇出 = N 条 run)。
  // 缺省取**全部绑定**而不是"第一个":取第一个会让「绑了两个区、只有一个区有数据」
  // 悄悄发生,那正是客户痛点「怕漏 region 对不上」。单绑(存量全部)行为逐字节不变。
  // `targets` 可显式指定子集,但**必须是绑定的子集**:不在绑定里的 target 直接拒,
  // 不静默忽略 —— 静默忽略等于"我按你说的跑了",而其实没跑。
  // 🔴 **Glue 不再被折叠成"绑定的第一个"**(W3-g:Glue 已按 target 执行)。
  // 原来那句 `job.type === "glue" ? [bound[0]] : bound` 会让一个绑了两个区的 Glue 作业
  // 只在第一个区跑 —— 而界面上两个区都亮着,正是客户痛点「怕漏 region 导致数据对不上」。
  const bound = bindingTargets(job);
  let runTargets = bound;
  const want = requestedSubset(body);
  if (want) {
    const unknown = want.filter((t: string) => !bound.includes(t));
    if (unknown.length) {
      return apiError(
        `以下执行目标不在该作业的绑定里,已拒绝:${unknown.join("/")}(当前绑定:${bound.join("/")})`,
        409,
        { code: "CONFLICT" }
      );
    }
    if (want.length === 0) return apiError("targets 传了空列表:没有可运行的执行目标", 400, { code: "VALIDATION_FAILED" });
    runTargets = want;
  }

  // 🔴 同意前置**先判全部 target 再提交任何一个**(SPEC v3.23 §3.2):任一跨法域 target 缺同意 ⇒ 整个请求 409(带文案),
  //    前端弹免责告知、同意后重试;home / 同法域空操作。区域审计本身在 job-service 里逐 target 写(抢锁之前)。
  try {
    await requireResidencyAckForTargets(guard.identity, runTargets);
  } catch (e) {
    const r = residencyErrorResponse(e);
    if (r) return r;
    throw e;
  }
  const actor = userActor(guard.identity);

  const runs: Array<Record<string, unknown>> = [];
  const failures: Array<{ targetId: string; error: string; rejected: boolean; auditUnavailable?: boolean }> = [];
  // 🔴 **多区扇出的 N 条 run 共享一个 runGroupId**(单区 = undefined,行上不落属性)。
  // 这是「这些任务会产生关联性」在数据上的第一道门:今天不盖,将来 RunGroup(O2)对这批 run 就是盲的。
  // 在循环**之前**算一次 —— 循环里算会让每条 run 各拿一个值,等于没分组。
  // 「只重试失败区」的链:由 `/api/run-groups/[id]/retry-failed` 给出
  // 🔴 形态先校验:拿任意字符串当链会写出一条指向不存在的组的回指(页面上点不回去,而且看不出为什么)
  const retryOf = typeof body?.retryOfRunGroupId === "string" ? body.retryOfRunGroupId : undefined;
  if (retryOf !== undefined && !isRunGroupId(retryOf)) {
    return apiError(`retryOfRunGroupId 形态非法:${String(retryOf)}`, 400, { code: "VALIDATION_FAILED" });
  }
  // 🔴 `forceGroup`:只剩一个区失败时也要成组,否则重试链在这里断掉(理由见 run-group.ts)
  const runGroupId = runGroupIdFor(runTargets, { forceGroup: !!retryOf });
  // O2:**扇出循环之前**把组行建出来。
  // 🔴 写不进去就**拒绝这次运行**:放行的后果是这批 run 永远归不到一个组里,
  //    而 run 行是只追加的历史事实,事后补不回来(掉头成本的门在数据不在代码)。
  const ledgerWarnings: string[] = [];
  try {
    await openRunGroupIfFanout({
      runGroupId,
      definitionKind: "etl-job",
      definitionId: job.jobId,
      projectId: resolveRunStamp(job).projectId,
      requestedTargets: runTargets,
      triggeredBy: dryRun ? "dryrun" : "manual",
      ...(retryOf ? { retryOfRunGroupId: retryOf } : {}),
    });
  } catch (e) {
    const r = runGroupWriteErrorResponse(e);
    if (r) return r;
    throw e;
  }
  // 本次产物的定义版本(跨区版本差要在组里看得见)。
  // 🔴 循环**之前**算一次:放循环里会对同一个定义连查 N 遍,而且两次之间可能被人改了版本。
  //    读不到就不写(注解缺失 ≠ 运行失败),但**不许**编一个 0 —— 那会显示成「v0」骗人。
  const defVersion = runGroupId ? await currentDefinitionVersion("etl-job", job.jobId).catch(() => undefined) : undefined;
  // 🔴 **逐 target 各自 try**:第 2 个区失败时第 1 个区**已经提交上去了**。
  // 整体抛错会让界面显示"运行失败",而其实有一个区正在跑 —— 用户于是不去看它的结果。
  // 一次请求碰多个区 ⇒ 唯一写法 `forEachTargetPlace`(L10):逐区**顺序**执行(保留「第 1 个区已提交、
  //   第 2 个区失败」的语义),解析得开的区各自一个嵌套落点上下文;循环体一字未改(typed rejection 照旧由下面的 catch 分 409 / 500)。
  await forEachTargetPlace(
    runTargets,
    async (targetId) => {
      try {
        const res = dryRun
          ? await dryRunRedshiftSqlJob(job, { runDate, targetId, runGroupId, actor })
          : job.type === "glue"
          ? await runGlueScriptJob(job, { runDate, targetId, runGroupId, actor })
          : await runRedshiftSqlJob(job, { runDate, targetId, runGroupId, actor });
        runs.push({ ...res, targetId: res.targetId || targetId });
        // 记账是**尽力**的:run 已经提交出去了,为了台账让整个请求失败等于「明明在跑却说没跑」;
        // 而子 run 的真值源是 run 行本身,这一格没记上组状态派生依然正确(理由见 run-groups.ts)。
        const w = await noteFanoutResult(runGroupId, targetId, { runId: (res as { runId?: string }).runId, definitionVersion: defVersion });
        if (w) ledgerWarnings.push(w);
      } catch (e: any) {
        failures.push({
          targetId,
          error: String(e?.message ?? e),
          // 绑定被拒是**用户可修**的(目标没装 redshift / 落点冲突 / 缺凭证 / 跨法域)——
          // 报 500 会把人引去查平台故障,真正该做的是换目标、清落点字段或补装组件。
          // (真环境验收 W3a-9 就是这么暴露出来的:落点冲突回了 500。)
          // 🔴 **抢不到运行锁也是「用户可修」**(上一次还在跑,等一下再点)。
          // 原来它是 `new Error(文案)` ⇒ 落到下面的 500「运行失败」⇒ 把人引去查平台故障。
          // 与上面那条注释(落点冲突报 500 = W3a-9)同一个病,当时只修了绑定那一类;
          // 2026-09-09 硬门 w3f 段 W3f-3 又撞到(单区运行紧跟两区运行 ⇒ 500)。
          rejected: e instanceof TargetBindingRejected || e instanceof ResidencyAckRequired || e instanceof RunLockBusy,
          // 区域审计写不成 = 该 target 未提交(审计完整性),不是绑定问题也不是平台 500
          auditUnavailable: e instanceof AuditUnavailable,
        });
        const w = await noteFanoutResult(runGroupId, targetId, { reason: String(e?.message ?? e).slice(0, 400) });
        if (w) ledgerWarnings.push(w);
      }
    },
    { sequential: true, via: "etl-job.run" }
  );

  const verb = dryRun ? "试运行" : "运行";
  if (runs.length === 0) {
    // 一个区都没跑起来 ⇒ 如实报错。全是"绑定被拒"时用 409(可修),否则 500。
    const msg = failures.map((fail) => (runTargets.length > 1 ? `${fail.targetId}: ${fail.error}` : fail.error)).join(" | ");
    if (failures.length > 0 && failures.every((f) => f.auditUnavailable)) {
      return apiError(`${verb}未提交(区域审计写不进去,审计完整性):${msg}`, 503, { code: "UPSTREAM_ERROR", detail: { reason: "audit-unavailable", failures } });
    }
    const allRejected = failures.every((f) => f.rejected);
    return allRejected
      ? apiError(`${verb}被拒:${msg}`, 409, { code: "CONFLICT", detail: { failures } })
      : apiError(`${verb}失败: ${msg}`, 500, { detail: { failures } });
  }

  const first = runs[0] as { runId?: string; runDate?: string };
  recordAudit(req, dryRun ? "etl-job.dryrun" : "etl-job.run", {
    resourceType: "etl-job",
    resourceId: job.jobId,
    detail: { type: job.type, runId: first?.runId, runDate: first?.runDate, dryRun, targets: runTargets, failures },
  }).catch(() => {});
  // 🔴 顶层仍摊平第一条 run(存量调用方读的是 `data.runId`),多区结果在 `runs` 里;
  // 部分失败**如实回报**(`partial` + `failures`),不许把"2 个区跑成 1 个"说成成功。
  return apiOk({
    ...runs[0],
    runs,
    ...(runGroupId ? { runGroupId } : {}),
    ...(failures.length ? { partial: true, failures } : {}),
    // 🔴 台账没记全**如实说出来**,不假装完整(它不影响组状态,但会少 definitionVersion 这类注解)
    ...(ledgerWarnings.length ? { groupLedgerIncomplete: ledgerWarnings } : {}),
  });
}
