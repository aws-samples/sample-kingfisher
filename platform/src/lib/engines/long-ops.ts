// (2026-10-29 两个测试账号安装链 showcase 执行区「EMR 运行」HTTP 504 而运行已提交并成功):
// Spark 引擎作业「运行」的**提交段**执行体 —— 逐区 `getProvider(engine).submit`(上传脚本 → 确保 EMR 应用并等它 STARTED(最多 ~60s)
// → StartJobRun → 台账),原先同步串在 `POST /api/engines/[engine]/[id]/run` 的请求路径上,冷启动一跳就撞 CloudFront 60 秒墙:
// 页面拿到 504,服务端照样把运行提交上去 ⇒ 「报错了但又跑了」,再点一次就是第二次运行。
// 55 DESIGN §6 第 12 行早把 `ensureApplication / ensureStarted` 列为请求路径上的等待点却一直没迁;本刀接成长操作:
// 超 45 秒自动 202 + 页面轮询(右下「正在后台执行:运行引擎作业」),对象租约 `engine-job:<jobId>` 让提交期间再点「运行」/ 改 / 删 ⇒ 409。
//
// 路由里留下的是**快**校验与**快**写(作业行 / 脚本非空 / runDate / targets 子集 / 跨法域同意 / 运行组行 / 定义版本),
// 这里的主体与接入前的路由循环体**逐字同形**:逐区顺序 submit、逐 target 各自 try、失败分类(被拒 / 审计不可用)、运行组逐 target 记账、
// 审计 `engine.<engine>.run`、响应摊平第一条 + runs + partial / failures / groupLedgerIncomplete。零 run 时按原口径抛 503 / 409 / 500。
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { recordAudit } from "@/lib/audit";
import { forEachTargetPlace } from "@/lib/place/fanout";
import { getProvider } from "@/lib/engines/registry";
import { RunLockBusy, JobRowMissing } from "@/lib/etl/run-lock"; // 2026-11-04:作业行已删 ⇒ 用户可修的 409
import { LakeRouteError } from "@/lib/lake/routes";
import { TargetBindingRejected } from "@/lib/exec-env/data-plane-target";
import { AuditUnavailable, ResidencyAckRequired } from "@/lib/exec-env/residency";
import { userActor } from "@/lib/exec-env/residency-audit";
import { noteFanoutResult } from "@/lib/monitor/run-groups";
import { LongOpHttpError } from "@/lib/long-ops/store";
import type { LongOpExecutor, LongOpExecutorRegistry } from "@/lib/long-ops/executor-types";

const USER_ID = "default-user";

const engineRun: LongOpExecutor<"engine-run"> = async (params, ctx) => {
  const { engine, jobId, runTargets, runDate, runGroupId, definitionVersion: defVersion } = params;
  // 作业行由执行体按 jobId 重读(任务可能被另一次请求接管;路由已核过存在与权限)
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.ENGINE_JOBS, Key: { userId: USER_ID, jobId } }));
  if (!Item) throw new LongOpHttpError(404, "作业不存在", { code: "NOT_FOUND" });
  const job = Item as Record<string, unknown>;
  const actor = userActor(ctx.identity);

  const runs: Array<Record<string, unknown>> = [];
  const failures: Array<{ targetId: string; error: string; rejected: boolean; auditUnavailable?: boolean }> = [];
  const ledgerWarnings: string[] = [];
  // 一次请求碰多个区 ⇒ 唯一写法 forEachTargetPlace(L10):逐区**顺序**执行(保留「第 1 个区已提交、第 2 个区失败」的语义)
  await forEachTargetPlace(
    runTargets,
    async (targetId) => {
      try {
        const res = await getProvider(engine).submit(job as never, { runDate, targetId, runGroupId, actor });
        runs.push({ ...res, targetId });
        const w = await noteFanoutResult(runGroupId, targetId, { runId: (res as { runId?: string }).runId, definitionVersion: defVersion });
        if (w) ledgerWarnings.push(w);
      } catch (e: any) {
        failures.push({
          targetId,
          error: String(e?.message ?? e),
          // 🔴 抢不到运行锁 / 绑定被拒 / 需要跨法域同意 / 作业行已删 / 数据湖表桶声明按本区解析不过 都是「用户可修」⇒ 409,不是平台故障
          rejected: e instanceof TargetBindingRejected || e instanceof ResidencyAckRequired || e instanceof RunLockBusy || e instanceof JobRowMissing || e instanceof LakeRouteError,
          auditUnavailable: e instanceof AuditUnavailable,
        });
        const w = await noteFanoutResult(runGroupId, targetId, { reason: String(e?.message ?? e).slice(0, 400) });
        if (w) ledgerWarnings.push(w);
      }
    },
    { sequential: true, via: "engine-job.run" },
  );

  if (runs.length === 0) {
    const msg = failures.map((f) => (runTargets.length > 1 ? `${f.targetId}: ${f.error}` : f.error)).join(" | ");
    if (failures.length > 0 && failures.every((f) => f.auditUnavailable)) {
      throw new LongOpHttpError(503, `运行未提交(区域审计写不进去,审计完整性):${msg}`, { code: "UPSTREAM_ERROR", detail: { reason: "audit-unavailable", failures } });
    }
    const allRejected = failures.length > 0 && failures.every((f) => f.rejected);
    if (allRejected) throw new LongOpHttpError(409, `运行被拒:${msg}`, { code: "CONFLICT", detail: { failures } });
    throw new LongOpHttpError(500, `运行失败: ${msg}`, { code: "UPSTREAM_ERROR", detail: { failures } });
  }
  const first = runs[0] as { runId?: string; nativeRunId?: string; runDate?: string };
  recordAudit(ctx.req, `engine.${engine}.run`, {
    resourceType: "engine-job",
    resourceId: jobId,
    detail: { runId: first?.runId, nativeRunId: first?.nativeRunId, runDate: first?.runDate, targets: runTargets, failures },
  }).catch(() => {});
  // 🔴 顶层仍摊平第一条(存量调用方读 `data.runId`),多区结果在 `runs` 里;部分失败**如实回报**(`partial` + `failures`)
  return {
    data: {
      ...runs[0],
      runs,
      ...(runGroupId ? { runGroupId } : {}),
      ...(failures.length ? { partial: true, failures } : {}),
      ...(ledgerWarnings.length ? { groupLedgerIncomplete: ledgerWarnings } : {}),
    },
  };
};

export type EngineLongOpKind = "engine-run";
export const ENGINE_LONG_OP_EXECUTORS: Pick<LongOpExecutorRegistry, EngineLongOpKind> = {
  "engine-run": engineRun,
};
