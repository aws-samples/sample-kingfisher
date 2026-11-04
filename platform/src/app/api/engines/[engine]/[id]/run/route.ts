export const dynamic = "force-dynamic";

// POST /api/engines/[engine]/[id]/run  body { runDate? }
// SPI 分派：getProvider(engine).submit()。EMR 提交一次 job-run。
//
// 模块 55 第三批 / B-136(2026-10-29):提交段(逐区 submit:上传脚本 → 确保 EMR 应用并等 STARTED 最多 ~60s → StartJobRun → 台账)在
//   lib/engines/long-ops.ts(engine-run)。原先同步串在这里,冷启动一跳就撞 CloudFront 60 秒墙 ⇒ 页面 504 而运行照样提交(B-129 同类)。
//   超 45 秒由统一框架转 202,页面右下「正在后台执行:运行引擎作业」;对象租约 `engine-job:<jobId>`:提交中再点运行 / 改 / 删 ⇒ 409。
//   路由里只留**快**校验与**快**写:作业行 / 脚本非空 / runDate / targets 子集 / 跨法域同意 / 运行组行 / 定义版本。

import { NextRequest, NextResponse } from "next/server";
// @kf-batch 50-WP31-place-first-class —— targets 子集的唯一解析作者
import { requestedSubset } from "@/lib/place/resolve";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { isEngineType } from "@/lib/engines/registry";
import { isValidDs } from "@/lib/etl/run-params";
// @kf-batch 50-P50.3-engines
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
// @kf-batch 50-W3f-T0-T3
import { runGroupIdFor, isRunGroupId } from "@/lib/monitor/run-group";
// @kf-batch 50-WP5-rungroup —— O2:扇出前建组行(严格);503 映射单一作者。逐 target 记账在执行体里(尽力)
import { openRunGroupIfFanout } from "@/lib/monitor/run-groups";
import { runGroupWriteErrorResponse } from "@/lib/monitor/run-group-http";
import { resolveRunStamp } from "@/lib/monitor/run-records";
import { currentDefinitionVersion } from "@/lib/versions/version-service";
// @kf-batch 50-W5-seg2-WP10a
import { requireResidencyAckForTargets, residencyErrorResponse } from "@/lib/exec-env/residency-audit";
import { getCorrelationId } from "@/lib/observability/logger";
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";

const USER_ID = "default-user";

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ engine: string; id: string }> }
) {
  const params = await props.params;
  if (!isEngineType(params.engine)) return apiError("未知引擎", 400, { code: "VALIDATION_FAILED" });
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.ENGINE_JOBS, Key: { userId: USER_ID, jobId: params.id } })
  );
  if (!Item) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const guard = await guardResourceAccess(req, Item, "editor");
  if (guard instanceof NextResponse) return guard;

  const job = Item as any;
  if (!job.script || !job.script.trim()) return apiError("脚本为空，请先编写脚本", 400, { code: "VALIDATION_FAILED" });

  const body = await req.json().catch(() => ({}));
  const runDate = body?.runDate || undefined;
  if (runDate && !isValidDs(runDate)) return apiError("runDate 格式应为 YYYY-MM-DD", 400, { code: "VALIDATION_FAILED" });

  // @kf-batch 50-P50.3-engines
  // 🔴 **运行扇出**(与 etl-jobs 同一形状):一个 Spark 作业绑了 N 个区,点一次「运行」
  // 就该在 N 个区各跑一次 —— 一条 run 只发生在一个区(run 记录的 targetId 是单值)⇒ 扇出 = N 条 run。
  // 缺省取**全部绑定**而不是"第一个":取第一个会让「绑了两个区、只有一个区有产物」悄悄发生,
  // 正是客户痛点「怕漏 region 导致数据对不上」。单绑(存量全部)行为逐字节不变。
  // 🔴 **逐 target 各自 try**:第 2 个区失败时第 1 个区已经提交上去了,整体抛错会让界面
  // 显示"运行失败"而其实有一个区正在跑(用户于是不去看它的结果)。
  const bound = bindingTargets(job as { targets?: unknown; targetId?: unknown });
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

  // @kf-batch 50-W5-seg2-WP10a —— 同意前置先判全部 target(与 etl-jobs 运行路由同一形状;409 带文案)
  try {
    await requireResidencyAckForTargets(guard.identity, runTargets);
  } catch (e) {
    const r = residencyErrorResponse(e);
    if (r) return r;
    throw e;
  }
  // @kf-batch 50-W3f-T0-T3 —— 与 etl-jobs 运行路由同一形状:循环前算一次,多区共享、单区不带。
  // @kf-batch 50-WP5-rungroup —— 「只重试失败区」的链:由 `/api/run-groups/[id]/retry-failed` 给出
  // 🔴 形态先校验:拿任意字符串当链会写出一条指向不存在的组的回指(页面上点不回去,而且看不出为什么)
  const retryOf = typeof body?.retryOfRunGroupId === "string" ? body.retryOfRunGroupId : undefined;
  if (retryOf !== undefined && !isRunGroupId(retryOf)) {
    return apiError(`retryOfRunGroupId 形态非法:${String(retryOf)}`, 400, { code: "VALIDATION_FAILED" });
  }
  // 🔴 `forceGroup`:只剩一个区失败时也要成组,否则重试链在这里断掉(理由见 run-group.ts)
  const runGroupId = runGroupIdFor(runTargets, { forceGroup: !!retryOf });
  // @kf-batch 50-WP5-rungroup —— 与 etl-jobs 路由同一形状:组行**先建**,写不进去就拒绝本次运行(E-167)
  const ledgerWarnings: string[] = [];
  try {
    await openRunGroupIfFanout({
      runGroupId,
      definitionKind: "engine-job",
      definitionId: job.jobId,
      projectId: resolveRunStamp(job).projectId,
      requestedTargets: runTargets,
      triggeredBy: "manual",
      ...(retryOf ? { retryOfRunGroupId: retryOf } : {}),
    });
  } catch (e) {
    const r = runGroupWriteErrorResponse(e);
    if (r) return r;
    throw e;
  }
  // @kf-batch 50-WP5-rungroup —— 本次产物的定义版本(E-168:跨区版本差要在组里看得见)。
  // 🔴 循环**之前**算一次:放循环里会对同一个定义连查 N 遍,而且两次之间可能被人改了版本。
  //    读不到就不写(注解缺失 ≠ 运行失败),但**不许**编一个 0 —— 那会显示成「v0」骗人。
  const defVersion = runGroupId ? await currentDefinitionVersion("engine-job", job.jobId).catch(() => undefined) : undefined;
  // 闭包里 TS 看不到上面 isEngineType 的收窄 ⇒ 先取成常量(值不变,仍是同一个 params.engine)
  const engine = params.engine;
  // B-136:提交段(逐区 submit / 失败分类 / 运行组逐 target 记账 / 审计 / 响应摊平)整体在执行体 lib/engines/long-ops.ts;
  //   执行体在等待预算内失败 ⇒ 原错误(LongOpHttpError 503 / 409 / 500 原口径)由 longOpErrorResponse 逐字沿用。
  try {
    const result = await submitLongOp(
      {
        kind: "engine-run",
        params: { engine, jobId: job.jobId, projectId: resolveRunStamp(job).projectId, runTargets, runDate, runGroupId, definitionVersion: defVersion },
        correlationId: getCorrelationId(req),
      },
      { req, identity: guard.identity },
    );
    return longOpResponse(req, result);
  } catch (e: any) {
    const lo = longOpErrorResponse(e);
    if (lo) return lo;
    return apiError(`运行失败: ${String(e?.message ?? e)}`, 500, { code: "UPSTREAM_ERROR" });
  }
}
