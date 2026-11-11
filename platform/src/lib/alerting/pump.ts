// 告警 / SLA 评估的**后台泵**—— 挂在周期 reconciler 旁的独立 60s 计时器(与补数泵 `backfill/pump.ts` 同一形状)。
//
// 🔴 为什么要有:告警规则的评估原来**只由告警中心的「立即评估」按钮触发**,SLA 的破线预测接口**没有任何调用方**
//    ⇒ 用户配好规则 / SLA 以后不点按钮就永远不会产生告警,「破线前预警」在页面上写着却没人在运行途中算过一次。
//
// ── 只做两件事 ──────────────────────────────────────────────────────────────
//   ① 一次 Query 取全部项目的键(项目表是小表);
//   ② 对每个项目回环 POST 本进程的 `/api/internal/alerting/tick`(真正的评估 = `alerting/tick.ts#alertingTick`:
//      规则评估与页面「立即评估」**同一个函数**;SLA 预测与 `/api/sla/predict` **同一个函数**)。
//
// 🔴🔴 **泵侧零执行器 import**:本文件在 `instrumentation.ts` 的可达面里(reconciler-loop 起它),
//    评估器碰通道 / 诊断 / 基线 ⇒ 都留在内部端点那一侧,这里只有 DynamoDB 读键 + 回环 HTTP。
// 🔴 正确性不依赖选主:evaluate 的事件写是条件写(同一 run / 窗口只告一次)、预测推送按 (slaId, runId) 去重
//    ⇒ 泵与页面同时评估、两个泵同时评估,都不会重复告警。选主只是省得 N 个副本一起敲。
// 🔴 开关:`BGP_RECONCILER_DISABLED=1`(整个周期循环不起,泵随之不起)/ `BGP_ALERTING_PUMP_PAUSED=1`(只停本泵;
//    页面「立即评估」照旧可用)。
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { PROJECTS_PK } from "@/lib/projects/constants";
import { loadInternalDispatchKey, selfBaseUrl } from "@/lib/dataplane-jobs/pump";
import {
  INTERNAL_KEY_HEADER,
  INTERNAL_SOURCE_ALERTING_PUMP,
  INTERNAL_SOURCE_HEADER,
} from "@/lib/scheduler/internal-source";
import { ALERTING_PUMP_INTERVAL_MS } from "@/lib/alerting/types";

export { ALERTING_PUMP_INTERVAL_MS };
/** 回环 HTTP 超时:一次 tick = 扫运行台账 + 逐规则匹配 + 逐 SLA 预测 + 可能的通道投递,给足 55s。 */
export const ALERTING_PUMP_HTTP_TIMEOUT_MS = 55_000;
/** 内部端点路径(路由文件与泵共用这一个常量)。 */
export const ALERTING_TICK_ENDPOINT_PATH = "/api/internal/alerting/tick";
/** 每轮最多评估几个项目(项目是小表;超过的下一轮继续 —— 一轮里串行回环,别让一次 tick 跑过周期)。 */
export const ALERTING_PUMP_MAX_PROJECTS_PER_TICK = 50;

export function alertingPumpPaused(): boolean {
  return process.env.BGP_ALERTING_PUMP_PAUSED === "1";
}

export interface AlertingPumpTickSummary {
  ran: boolean;
  /** 不跑的原因(paused / not-leader / no-key) */
  skipped?: string;
  projects: number;
  posted: number;
  failed: number;
}

export interface AlertingPumpDeps {
  isLeader: () => boolean;
  fetchImpl?: typeof fetch;
  loadKey?: () => Promise<string>;
  baseUrl?: string;
  listProjectIds?: (limit: number) => Promise<string[]>;
}

/** 「有哪些项目要评估」的唯一一次读:只取键(projectId),按字典序稳定排列。 */
export async function listProjectIdsForAlerting(limit = ALERTING_PUMP_MAX_PROJECTS_PER_TICK): Promise<string[]> {
  const out: string[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await docClient.send(
      new QueryCommand({
        TableName: TABLES.PROJECTS,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": PROJECTS_PK },
        ProjectionExpression: "projectId",
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      })
    );
    for (const it of r.Items ?? []) {
      const id = String(it.projectId ?? "");
      if (id) out.push(id);
    }
    startKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!startKey) break;
  }
  out.sort();
  return out.slice(0, Math.max(1, limit));
}

async function post(deps: AlertingPumpDeps, key: string, body: unknown): Promise<boolean> {
  const f = deps.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ALERTING_PUMP_HTTP_TIMEOUT_MS);
  try {
    const r = await f(`${deps.baseUrl ?? selfBaseUrl()}${ALERTING_TICK_ENDPOINT_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [INTERNAL_SOURCE_HEADER]: INTERNAL_SOURCE_ALERTING_PUMP,
        [INTERNAL_KEY_HEADER]: key,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    // 404 = 项目刚被删(下一轮就不会再列出来),不算失败
    return r.ok || r.status === 404;
  } catch (e) {
    console.error(JSON.stringify({ event: "alerting.pump.post-failed", error: String((e as Error)?.message ?? e) }));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 一轮(可无定时器直接测)。项目之间**串行**评估:每个项目一次 tick 可能投递通道 / 挂诊断,不并发打爆下游。 */
export async function runAlertingPumpTick(deps: AlertingPumpDeps): Promise<AlertingPumpTickSummary> {
  const base: AlertingPumpTickSummary = { ran: false, projects: 0, posted: 0, failed: 0 };
  if (alertingPumpPaused()) return { ...base, skipped: "paused" };
  if (!deps.isLeader()) return { ...base, skipped: "not-leader" };
  const key = await (deps.loadKey ?? loadInternalDispatchKey)();
  if (!key) return { ...base, skipped: "no-key" };
  const ids = await (deps.listProjectIds ?? listProjectIdsForAlerting)(ALERTING_PUMP_MAX_PROJECTS_PER_TICK);
  let posted = 0;
  let failed = 0;
  for (const projectId of ids) {
    if (await post(deps, key, { projectId })) posted++;
    else failed++;
  }
  return { ran: true, projects: ids.length, posted, failed };
}

/** 起泵(reconciler-loop 在 `startReconcilerLoop` 里调;递归 setTimeout + unref ⇒ 一轮跑完才排下一轮,不重叠)。 */
export function startAlertingPump(deps: AlertingPumpDeps): void {
  const schedule = (delay: number) => {
    const timer = setTimeout(runOnce, delay);
    if (typeof timer.unref === "function") timer.unref();
  };
  const runOnce = async () => {
    try {
      const s = await runAlertingPumpTick(deps);
      if (s.ran && s.failed > 0) console.log("[alerting-pump] tick:", JSON.stringify(s));
    } catch (e) {
      console.error("[alerting-pump] tick 未捕获异常:", String((e as Error)?.message ?? e));
    } finally {
      schedule(ALERTING_PUMP_INTERVAL_MS);
    }
  };
  console.log("[alerting-pump] 已启动(interval=%dms)", ALERTING_PUMP_INTERVAL_MS);
  schedule(ALERTING_PUMP_INTERVAL_MS);
}
