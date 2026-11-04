// 告警引擎核心。一次 evaluate:
//   1. 读所有 enabled && !silenced 规则(限当前项目);
//   2. 扫共享运行台账 bgp-task-runs;
//   3. 按规则条件(失败/超时/成功率/断流)匹配 → 生成候选告警(带幂等去重键);
//   4. putEventIfNew 幂等写事件(同一 run/窗口只告一次)→ 分发到通道 → 回写投递结果;
//   5. 失败类且开了 enrichWithDiagnosis → 挂 AI 诊断(复用startDiagnosis)。
//
// 首期由前端轮询/手动触发调用(无常驻 worker,零常驻成本);无人值守(定时)留二期。
// 水位 lastEvaluatedAt:失败/超时类只看水位之后完成的终态 run,避免历史 run 反复触发。

import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { listRules, bumpWatermark } from "./rules";
import { getChannels } from "./channels";
import { putEventIfNew, updateEventDelivery } from "./events";
import { dispatch, Notification } from "./notify";
import { startDiagnosis } from "@/lib/diagnostics/service";
import type { AlertRule, AlertScope, Severity } from "./types";
// run 行的区章(`SCOPE_SCALAR_ATTR.run`)唯一判定
import { scalarTargetOf } from "@/lib/exec-env/scope";

// bgp-task-runs 行(只取引擎用得到的字段)。
interface TaskRun {
  taskId: string;
  runId: string;
  taskType?: string;
  status?: string; // running / succeeded / failed / stopped
  startedAt?: string;
  finishedAt?: string;
  duration?: number; // 秒
  error?: string;
  taskName?: string;
  /** run 章(52 SPEC §1;缺省经 `scalarTargetOf` 归主控区) */
  targetId?: string;
}

// 一次评估的汇总(回给 API / 前端)。
export interface EvaluateSummary {
  rulesEvaluated: number;
  runsScanned: number;
  newEvents: number;
  events: Array<{ ruleId: string; ruleName: string; severity: Severity; message: string; dedupeKey: string; status: string }>;
}

// 拉取运行台账(演示量级 Scan 够用;实时大屏级别的量走 GSI,列二期)。
async function scanRuns(limit = 500): Promise<TaskRun[]> {
  const { Items = [] } = await docClient.send(new ScanCommand({ TableName: TABLES.TASK_RUNS, Limit: limit }));
  return Items as TaskRun[];
}

// run 是否落在规则作用域内(任务类型 + 可选具体任务 + 可选执行环境)。
function inScope(run: TaskRun, scope: AlertScope): boolean {
  if (scope.taskId && run.taskId !== scope.taskId) return false;
  // 规则可以只盯某几个区(留空 = 全部)
  if (scope.targets && scope.targets.length > 0 && !scope.targets.includes(targetOf(run))) return false;
  if (scope.taskType === "all") return true;
  // etl 作用域同时覆盖 etl-glue/etl-redshift 等以 "etl" 开头的类型(与监控页路由口径一致)。
  if (scope.taskType === "etl") return (run.taskType || "").startsWith("etl");
  return run.taskType === scope.taskType;
}

// 「这条 run 属于哪个区」的**唯一**判定(与全平台过滤同一函数;
// 无章的存量 run 归主控区 —— 那是历史事实:落章之前只有一条执行路径)。
const targetOf = (r: TaskRun) => scalarTargetOf(r as unknown as Record<string, unknown>, "run");

const isFailed = (r: TaskRun) => r.status === "failed";
const isSucceeded = (r: TaskRun) => r.status === "succeeded";
const runTime = (r: TaskRun) => r.finishedAt || r.startedAt || "";

// 按区分组(顺序稳定:按 targetId 字典序,便于判据逐条比)
function groupByTarget(rows: TaskRun[]): Array<[string, TaskRun[]]> {
  const m = new Map<string, TaskRun[]>();
  for (const r of rows) {
    const k = targetOf(r);
    const arr = m.get(k);
    if (arr) arr.push(r);
    else m.set(k, [r]);
  }
  return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

// 一条候选告警(尚未写库)。
//   message   ：中文成品串(用于 webhook 投递 + i18n key + 兜底显示);
//   msgKey/msgParams：模板 key + 参数,供前端按当前语种 t(msgKey, msgParams) 渲染(en.ts 已备译文)。
//     —— 事件跨语种持久展示,故不在服务端定语种;渲染期由 UI 决定。
interface Candidate {
  dedupeKey: string;
  message: string;
  msgKey: string;
  msgParams: Record<string, string | number>;
  trigger: Notification["trigger"] & { taskId?: string; taskName?: string; runId?: string; taskType?: string; metricValue?: number };
  diagRef?: { taskId: string; runId: string }; // 失败类可挂诊断
}

// 针对一条规则,在给定 run 集合上算出候选告警(可能 0..N 条)。
function matchRule(rule: AlertRule, runs: TaskRun[], nowMs: number): Candidate[] {
  const scoped = runs.filter((r) => inScope(r, rule.scope));
  const c = rule.condition;

  if (c.type === "failure") {
    const wm = rule.lastEvaluatedAt || "";
    return scoped
      .filter((r) => isFailed(r) && runTime(r) > wm) // 只看水位之后的失败
      .map((r) => {
        const name = r.taskName || r.taskId;
        const err = r.error ? `：${String(r.error).slice(0, 200)}` : "";
        return {
          dedupeKey: `run#${r.runId}`,
          message: `任务「${name}」运行失败${err}`,
          msgKey: r.error ? "任务「{name}」运行失败：{err}" : "任务「{name}」运行失败",
          msgParams: { name, ...(r.error ? { err: String(r.error).slice(0, 200) } : {}) },
          // 单条 run 的告警天然属于一个区,但**得说出来**:
          // 值班的人第一件事就是问「哪个区挂了」(dedupeKey 用 runId 已唯一,不用带区)
          trigger: { taskId: r.taskId, taskName: r.taskName, runId: r.runId, taskType: r.taskType, targetId: targetOf(r) },
          diagRef: r.runId ? { taskId: r.taskId, runId: r.runId } : undefined,
        };
      });
  }

  if (c.type === "timeout") {
    const wm = rule.lastEvaluatedAt || "";
    const thr = c.thresholdMinutes || 0;
    return scoped
      .filter((r) => Number(r.duration) > thr * 60 && runTime(r) > wm && (isSucceeded(r) || isFailed(r)))
      .map((r) => {
        const name = r.taskName || r.taskId;
        const mins = Math.round(Number(r.duration) / 60);
        return {
          dedupeKey: `run#${r.runId}`,
          message: `任务「${name}」运行时长 ${mins} 分钟，超过阈值 ${thr} 分钟`,
          msgKey: "任务「{name}」运行时长 {mins} 分钟，超过阈值 {thr} 分钟",
          msgParams: { name, mins, thr },
          trigger: { taskId: r.taskId, taskName: r.taskName, runId: r.runId, taskType: r.taskType, metricValue: Number(r.duration), targetId: targetOf(r) },
        };
      });
  }

  if (c.type === "success-rate") {
    // 滚动窗口内(按完成时间)统计终态 run 成功率;低于阈值告一次(窗口桶去重)。
    // 🔴🔴 **按区分别评估**(缺省;合同 INTERACTION §4sexies)。
    // 改动前:全部区揉成一个 rate + 一个 `win#<bucket>` 桶 ⇒ A 区全挂、B 区健康时总体不越阈值
    // ⇒ **不告警**(静默漏告)。现在每个区各算一遍、各自去重,桶键带上 targetId。
    const winMs = (c.windowMinutes || 1440) * 60000;
    const since = new Date(nowMs - winMs).toISOString();
    const bucket = Math.floor(nowMs / winMs);
    const win = c.windowMinutes || 1440;
    const thr = c.thresholdPercent || 0;

    const evalOne = (rows: TaskRun[], tid: string | null): Candidate[] => {
      const terminal = rows.filter((r) => (isSucceeded(r) || isFailed(r)) && runTime(r) >= since);
      if (terminal.length === 0) return [];
      const ok = terminal.filter(isSucceeded).length;
      const rate = Math.round((ok / terminal.length) * 100);
      if (rate >= thr) return [];
      const where = tid ? `执行环境 ${tid} ` : "作用域内";
      return [{
        // 🔴 桶键必须带区:不带的话第一个越阈值的区会把这个窗口「用掉」,
        // 同窗口里第二个区再挂也不再告警(幂等写会认为已经告过了)。
        dedupeKey: tid ? `win#${bucket}#${tid}` : `win#${bucket}`,
        message: `${where}最近 ${win} 分钟成功率 ${rate}%（${ok}/${terminal.length}），低于阈值 ${thr}%`,
        msgKey: tid
          ? "执行环境 {target} 最近 {win} 分钟成功率 {rate}%（{ok}/{total}），低于阈值 {thr}%"
          : "作用域内最近 {win} 分钟成功率 {rate}%（{ok}/{total}），低于阈值 {thr}%",
        msgParams: { win, rate, ok, total: terminal.length, thr, ...(tid ? { target: tid } : {}) },
        trigger: { taskType: rule.scope.taskType, metricValue: rate, ...(tid ? { targetId: tid } : {}) },
      }];
    };

    if (c.evaluation === "pooled") return evalOne(scoped, null);
    return groupByTarget(scoped).flatMap(([tid, rows]) => evalOne(rows, tid));
  }

  if (c.type === "no-run") {
    // 断流:窗口内无成功 run。规则式先顶(预测留二期)。
    // 🔴🔴 **按区分别评估**(缺省)。改动前:只要**任意一个区**
    // 窗口内有一次成功,就整体不报 ⇒ 一个区完全断流可以永远不被发现(静默漏告里最坏的一种)。
    // 🔴 候选区取「**这条规则作用域里出现过的所有区**」而不是「窗口内有 run 的区」:
    // 断流的定义恰恰是「这个区现在没有成功 run」,拿窗口内的行去枚举区,断流的那个区会直接消失。
    const winMs = (c.windowMinutes || 1440) * 60000;
    const since = new Date(nowMs - winMs).toISOString();
    const bucket = Math.floor(nowMs / winMs);
    const win = c.windowMinutes || 1440;

    const evalOne = (rows: TaskRun[], tid: string | null): Candidate[] => {
      const recentSuccess = rows.filter((r) => isSucceeded(r) && runTime(r) >= since);
      if (recentSuccess.length > 0) return [];
      const where = tid ? `执行环境 ${tid} ` : "作用域内";
      return [{
        dedupeKey: tid ? `win#${bucket}#${tid}` : `win#${bucket}`,
        message: `${where}最近 ${win} 分钟无成功运行（疑似断流/调度停摆）`,
        msgKey: tid
          ? "执行环境 {target} 最近 {win} 分钟无成功运行（疑似断流/调度停摆）"
          : "作用域内最近 {win} 分钟无成功运行（疑似断流/调度停摆）",
        msgParams: { win, ...(tid ? { target: tid } : {}) },
        trigger: { taskType: rule.scope.taskType, ...(tid ? { targetId: tid } : {}) },
      }];
    };

    if (c.evaluation === "pooled") return evalOne(scoped, null);
    // 规则显式点名了区 ⇒ 就按它点名的那些评估(哪怕某个区一条 run 都没有 —— 那更该报断流);
    // 没点名 ⇒ 用作用域里出现过的区(不限窗口)。
    const candidates =
      rule.scope.targets && rule.scope.targets.length > 0
        ? rule.scope.targets
        : Array.from(new Set(scoped.map(targetOf)));
    return candidates.flatMap((tid) => evalOne(scoped.filter((r) => targetOf(r) === tid), tid));
  }

  return [];
}

// 给门禁用的测试缝:`matchRule` 是纯函数(规则 × run 集合 → 候选),
// 而「按区分别评估」这件事**只能在它这一层验**(再往上就要连 DDB 与通道一起 mock,判据会变脆)。
// 🔴 只导出这一个纯函数,不导出任何会写库的东西。
export { matchRule as __matchRuleForTest };

// 主入口:评估当前项目的所有规则,写新事件 + 分发。
export async function evaluate(projectId: string, createdBy: string): Promise<EvaluateSummary> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const rules = (await listRules(projectId)).filter((r) => r.enabled && !r.silenced);
  const runs = await scanRuns();

  const summary: EvaluateSummary = { rulesEvaluated: rules.length, runsScanned: runs.length, newEvents: 0, events: [] };

  for (const rule of rules) {
    const candidates = matchRule(rule, runs, nowMs);
    for (const cand of candidates) {
      // 幂等:同一 (ruleId, dedupeKey) 已告过 → putEventIfNew 返回 null,跳过。
      const ev = await putEventIfNew({
        ruleId: rule.ruleId,
        ruleName: rule.name,
        severity: rule.severity,
        projectId,
        dedupeKey: cand.dedupeKey,
        message: cand.message,
        msgKey: cand.msgKey,
        msgParams: cand.msgParams,
        trigger: cand.trigger,
      });
      if (!ev) continue; // 重复,幂等跳过

      // 可选 AI 富化:失败类 + 开关开 + 有 runId → 挂诊断(fire-and-forget,不阻塞分发)。
      let diagnosisId: string | undefined;
      if (rule.enrichWithDiagnosis && rule.condition.type === "failure" && cand.diagRef) {
        try {
          const diag = await startDiagnosis({ ...cand.diagRef, projectId, createdBy });
          diagnosisId = diag.diagnosticId;
        } catch {
          /* 诊断失败不影响告警本身 */
        }
      }

      // 分发到规则绑定的通道。
      const channels = (await getChannels(rule.channelIds)).filter((c) => c.enabled);
      const title = `[${rule.severity}] ${rule.name}`;
      const notification: Notification = {
        title,
        severity: rule.severity,
        ruleName: rule.name,
        message: cand.message + (diagnosisId ? `\n\n🔍 已自动发起 AI 诊断（可在平台查看诊断报告）` : ""),
        trigger: cand.trigger,
      };
      const { status, results } = await dispatch(channels, notification);
      await updateEventDelivery(rule.ruleId, cand.dedupeKey, status, results, diagnosisId);

      summary.newEvents++;
      summary.events.push({ ruleId: rule.ruleId, ruleName: rule.name, severity: rule.severity, message: cand.message, dedupeKey: cand.dedupeKey, status });
    }
    // 推进水位(即使无命中也推进,避免下轮重扫历史)。
    await bumpWatermark(rule.ruleId, nowIso);
  }

  return summary;
}
