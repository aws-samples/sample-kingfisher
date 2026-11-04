// 成本异常检测 + 双路闭环(34 通道推送 + 43-A 知识库沉淀)。
// 隔离红线:只 import 现有稳定导出(alerting dispatch/putEventIfNew、incidents store),
// 不改其任何代码;写 bgp-incidents 走数据面(/incidents 页与诊断 grounding 自然可见)。

import { dispatch } from "@/lib/alerting/notify";
import { putEventIfNew, updateEventDelivery } from "@/lib/alerting/events";
import { listChannels } from "@/lib/alerting/channels";
import { upsertMaster, putOccurrenceIfNew } from "@/lib/incidents/store";
import { normalizeEngine } from "@/lib/incidents/signature";
import { DEFAULT_PROJECT_ID } from "@/lib/projects/constants";
import { detectSpike } from "./anomaly-core";
import { costSignature } from "./cost-signature";
import { listCostDaily, scanAllCostRuns } from "./store";
import { filterRowsByScalar, scalarTargetOf, type TargetScope } from "@/lib/exec-env/scope";
import { isRegionlessCost } from "./types";
import type { CostAnomaly } from "./types";
// P4.0:在线隔离标常量(单一定义,与 baseline/learn.ts 同源 copilot/plan/types.ts)。
import { COPILOT_TRIGGERED_BY } from "@/lib/copilot/plan/types";

// 成本是账号级横切数据,固定落默认工作区分区("proj-default"——务必用常量,
// 裸写 "default" 会落进无人读的分区,/incidents 页与诊断 grounding 都看不见)。
const PROJECT_ID = DEFAULT_PROJECT_ID;

function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function prevMonthOf(date: Date): string {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

// ── 检测(纯读)────────────────────────────────────────────────

// 任务级:每任务最新一次 run 成本 vs 该任务历史 run 成本(排除 backfill 与 copilot 触发,43-B 硬约束同款)。
// P4.0:补 copilot 排除——补数与 Copilot 代执行都是非常规触发,会污染成本异常检测基线。
/**
 * 🔴 **按区检测**。
 *
 * 为什么过滤要发生在**算基线之前**:这与告警 `evaluate.ts` 的池化病是同一个 ——
 * 把两个区的历史成本混在一个基线里,一个区的突增会被另一个区的均值稀释,结果是**不报异常**。
 * 传 `scope` 时先按区切,再各自算自己的基线。
 */
export async function detectTaskAnomalies(opts?: { scope?: TargetScope }): Promise<CostAnomaly[]> {
  let all = await scanAllCostRuns();
  if (opts?.scope) {
    all = filterRowsByScalar(all as unknown as Array<Record<string, unknown>>, opts.scope, "cost") as unknown as typeof all;
  }
  // 🔴 基线按 **(task, target)** 分组,不是按 task。
  // 不带 target 维的后果(本包的变异用例钉住):同一个任务扇出到两个区,两区的 run 并进同一条基线 ——
  //   · A 区每次 $1、B 区每次 $10 ⇒ 池化中位数落在 $1 附近,B 区一次**完全正常**的 $10 被报成 10× 突增;
  //   · 反过来 A 区真的从 $1 涨到 $5,却因为「最新一条」恰好是 B 区的 run 而根本没被检查。
  // 上面 `scope` 过滤只解决「单区视角」;`POST /detect` 与全部视角走的是不带 scope 的这条路,照样池化。
  // 归属判定走 `scalarTargetOf`(与范围过滤同一条规则;存量无章行归主控区)。
  const byTaskTarget = new Map<string, { taskId: string; targetId: string; runs: typeof all }>();
  for (const r of all) {
    if (r.triggeredBy === "backfill" || r.triggeredBy === COPILOT_TRIGGERED_BY) continue;
    const targetId = scalarTargetOf(r as unknown as Record<string, unknown>, "cost");
    const k = `${r.taskId}\u0000${targetId}`;
    const g = byTaskTarget.get(k) ?? { taskId: r.taskId, targetId, runs: [] as typeof all };
    g.runs.push(r);
    byTaskTarget.set(k, g);
  }

  const out: CostAnomaly[] = [];
  for (const { taskId, targetId, runs } of Array.from(byTaskTarget.values())) {
    if (runs.length < 2) continue;
    const sorted = [...runs].sort((a, b) => (a.finishedAt < b.finishedAt ? -1 : 1));
    const latest = sorted[sorted.length - 1];
    const history = sorted.slice(0, -1).map((r) => r.costUsd);
    const v = detectSpike(history, latest.costUsd);
    if (!v.isSpike) continue;
    out.push({
      scope: "task",
      key: taskId,
      targetId,
      engine: normalizeEngine(latest.engine === "emr-serverless" ? "emr" : latest.engine),
      displayName: taskId,
      date: latest.finishedAt.slice(0, 10),
      actualUsd: latest.costUsd,
      baselineUsd: v.baseline,
      deviationX: v.deviationX,
      samples: v.samples,
      incidentRecorded: false,
      notified: false,
    });
  }
  return out;
}

// 服务级:昨日服务成本 vs 近 30 日该服务日成本分布。
/**
 * 🔴 基线按 **(service, region)** 分组(与任务级按 target 同一条道理):
 * 账单已按区采(v2),把两个区的同一服务并成一条基线,一个区的突增会被另一个区稀释。
 * `regions` 给了就只检这些区(单区视角);无区域归属的全局服务只在全部视角(`regions` 缺省)下检 ——
 * 它们不属于任何区,不许挂到某个区的视角里。
 */
export async function detectServiceAnomalies(opts?: { regions?: ReadonlySet<string> | null }): Promise<CostAnomaly[]> {
  const now = new Date();
  const rows = [...(await listCostDaily(monthOf(now))), ...(await listCostDaily(prevMonthOf(now)))];
  const yesterday = new Date(now.getTime() - 86400_000).toISOString().slice(0, 10);
  const regions = opts?.regions ?? null;

  const bySvcRegion = new Map<string, { service: string; region: string; days: { date: string; amountUsd: number }[] }>();
  for (const r of rows) {
    if (regions && (isRegionlessCost(r.region) || !regions.has(r.region))) continue;
    const k = `${r.service}\u0000${r.region}`;
    const g = bySvcRegion.get(k) ?? { service: r.service, region: r.region, days: [] };
    g.days.push({ date: r.date, amountUsd: r.amountUsd });
    bySvcRegion.set(k, g);
  }

  const out: CostAnomaly[] = [];
  for (const { service, region, days } of Array.from(bySvcRegion.values())) {
    const current = days.find((d) => d.date === yesterday);
    if (!current) continue;
    const history = days.filter((d) => d.date < yesterday).map((d) => d.amountUsd);
    const v = detectSpike(history, current.amountUsd);
    if (!v.isSpike || current.amountUsd < 0.5) continue; // 微额服务突增无行动价值,降噪
    out.push({
      scope: "service",
      key: service,
      region,
      displayName: service,
      date: yesterday,
      actualUsd: current.amountUsd,
      baselineUsd: v.baseline,
      deviationX: v.deviationX,
      samples: v.samples,
      incidentRecorded: false,
      notified: false,
    });
  }
  return out;
}

// ── 闭环(推送 + 沉淀,全幂等)─────────────────────────────────

// 对确认的异常:①写 bgp-alert-events(dedupeKey 幂等)+ 34 通道推送;②沉淀 bgp-incidents。
// 幂等由 putEventIfNew/putOccurrenceIfNew 的条件写保证——重复 detect 不重推不重沉淀。
export async function settleAnomalies(anomalies: CostAnomaly[]): Promise<CostAnomaly[]> {
  if (!anomalies.length) return anomalies;
  const channels = (await listChannels()).filter((c) => c.enabled);

  for (const a of anomalies) {
    const engine = a.scope === "task" ? a.engine || "unknown" : "finops";
    const sig = costSignature(a, engine);
    // 🔴 去重键带「属于哪里」:不带的话 A 区先报了,同一天 B 区
    // 同一任务的突增会被当成「已推过」吞掉(与告警窗口桶键不带 targetId 是同一个病)。
    const where = a.scope === "task" ? a.targetId : a.region;
    const dedupeKey = `cost#${a.scope}#${a.key}#${where}#${a.date}`;
    const message =
      `${a.displayName}(${where})${a.date} 成本 $${a.actualUsd.toFixed(4)},` +
      `相对基线 $${a.baselineUsd.toFixed(4)} 偏离 ${a.deviationX.toFixed(1)}×(样本 ${a.samples})`;

    // ① 告警事件 + 通道推送(putEventIfNew 返回 null = 本轮已推过,幂等跳过)。
    const ev = await putEventIfNew({
      ruleId: "finops-cost-anomaly", // 虚拟规则 ID(FinOps 无 34 规则实体,仅复用事件表+通道)
      ruleName: "FinOps 成本突增检测",
      severity: a.deviationX >= 5 ? "P2" : "P3",
      projectId: PROJECT_ID,
      dedupeKey,
      message,
      // 任务级带 targetId ⇒ 告警事件盖区章(events.ts 从 trigger.targetId 盖),告警中心按区可见
      trigger: { taskId: a.scope === "task" ? a.key : undefined, metricValue: a.actualUsd, ...(a.scope === "task" ? { targetId: a.targetId } : {}) },
    });
    if (ev) {
      const { status, results } = await dispatch(channels, {
        title: `[FinOps] 成本突增:${a.displayName}`,
        severity: ev.severity,
        ruleName: ev.ruleName,
        message,
        trigger: ev.trigger as Record<string, unknown>,
      });
      await updateEventDelivery(ev.ruleId, ev.sk, status, results);
      a.notified = true;
    }

    // ② 知识库沉淀(数据面写入;occ 的 diagnosticId 用 dedupeKey 兜底幂等)。
    await upsertMaster({
      projectId: PROJECT_ID,
      signature: sig.signature,
      engine: sig.engine,
      title: sig.title,
      taskName: a.displayName,
      occurredAt: new Date().toISOString(),
      rootCauseSummary: message,
    });
    const newOcc = await putOccurrenceIfNew({
      pk: `incident#${PROJECT_ID}`,
      sk: `occ#${sig.signature}#${dedupeKey}`,
      projectId: PROJECT_ID,
      signature: sig.signature,
      occurredAt: new Date().toISOString(),
      taskId: a.scope === "task" ? a.key : "-",
      taskName: a.displayName,
      taskType: a.scope === "task" ? "cost" : "cost-service",
      runId: "-",
      diagnosticId: dedupeKey,
      symptomDigest: sig.title,
    });
    a.incidentRecorded = newOcc || a.incidentRecorded;
  }
  return anomalies;
}
