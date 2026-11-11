// 告警 / SLA 评估泵的**执行体**(内部端点 `/api/internal/alerting/tick` 调它;泵侧不 import 本文件)。
//
// 一次 tick = 一个项目:
//   ① 规则评估 —— 与告警中心「立即评估」**同一个函数** `evaluate`(事件条件写去重 ⇒ 泵与按钮同时跑也不重复告警);
//   ② SLA 滚动预测 —— 对每条启用的 SLA,找出绑定对象的在途运行,逐条走 `predictSlaRun`(与 `/api/sla/predict` 同一个函数),
//      多窗口确认历史落在 SLA 行;确认破线即经通道推送(按 (slaId, runId) 去重)。
// 一条 SLA 预测出错不影响别的 SLA 与规则评估(逐条隔离,错计数回给泵)。
import { evaluate } from "@/lib/alerting/evaluate";
import { listSlas } from "@/lib/baseline/sla-service";
import { predictInFlightRuns } from "@/lib/baseline/sla-predict";
import { ALERTING_PUMP_PRINCIPAL } from "@/lib/scheduler/internal-source";

export interface AlertingTickSummary {
  rulesEvaluated: number;
  runsScanned: number;
  newEvents: number;
  slas: number;
  runsPredicted: number;
  breachAlerts: number;
  slaErrors: number;
}

export async function alertingTick(projectId: string, now = Date.now()): Promise<AlertingTickSummary> {
  const ev = await evaluate(projectId, ALERTING_PUMP_PRINCIPAL.actor);
  const summary: AlertingTickSummary = {
    rulesEvaluated: ev.rulesEvaluated,
    runsScanned: ev.runsScanned,
    newEvents: ev.newEvents,
    slas: 0,
    runsPredicted: 0,
    breachAlerts: 0,
    slaErrors: 0,
  };
  const slas = (await listSlas(projectId)).filter((s) => s.enabled);
  summary.slas = slas.length;
  for (const sla of slas) {
    try {
      const r = await predictInFlightRuns(projectId, sla, now);
      summary.runsPredicted += r.runs;
      summary.breachAlerts += r.breachAlerts;
    } catch (e) {
      summary.slaErrors++;
      console.error(JSON.stringify({ event: "alerting.tick.sla-failed", projectId, slaId: sla.slaId, error: String((e as Error)?.message ?? e).slice(0, 300) }));
    }
  }
  return summary;
}
