// 模块 43-B — SLA 关键路径破线预测(纯预测核心 + 多窗口燃尽率)。
//
// 思路:对进行中的 workflow run,已完成节点用【实际】耗时,未开始/进行中节点用【基线】→ 沿
// 关键路径滚动算剩余 → etaAt = now + 剩余关键路径。与 SLA 承诺时刻比较 → willBreach + riskLevel。
// 破线判定做多窗口确认(短窗急/长窗稳)降抖动误报。

import { analyzeCriticalPath } from "./critical-path";
import type { RiskLevel, SlaTarget } from "./types";

export interface NodeRuntimeState {
  nodeId: string;
  status: "succeeded" | "running" | "pending" | "failed" | string;
  actualSec?: number; // 已完成节点的实际耗时
  elapsedSec?: number; // 进行中节点已耗时
}

// 承诺完成时刻(绝对 epoch ms)。relative:触发时刻 + offset;absolute:今天(或明天)的 clockTime。
export function computeSlaDeadline(target: SlaTarget, triggerAtMs: number, now: number): number {
  if (target.type === "relative") {
    return triggerAtMs + (target.offsetMinFromTrigger || 0) * 60_000;
  }
  // absolute:取"触发日"的 clockTime;若该时刻早于触发(如凌晨批 02:00 而触发在前一天 23:00),
  // 则取次日。tz 首期按 UTC 处理(部署区一致);后续可接 tz。
  const [hh, mm] = String(target.clockTime || "00:00").split(":").map((x) => parseInt(x, 10) || 0);
  const base = new Date(triggerAtMs);
  const cand = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hh, mm, 0);
  return cand >= triggerAtMs ? cand : cand + 86400_000;
}

export interface PredictInput {
  dag: { nodes?: any[]; edges?: any[] };
  baselineDurationOf: (nodeId: string) => number; // 节点基线时长(sec)
  runtime: Record<string, NodeRuntimeState>; // nodeId → 运行态
  startedAtMs: number; // run 实际开始
  triggerAtMs: number; // 调度触发(relative SLA 用);无独立字段时 = startedAtMs
  slaTarget: SlaTarget;
  warnLeadMin: number;
  now: number;
}

export interface PredictResult {
  etaAtMs: number;
  slaAtMs: number;
  willBreach: boolean;
  riskLevel: RiskLevel;
  criticalPathNode?: string; // 当前卡点(关键路径上第一个未完成节点)
  marginMin: number;
  remainingSec: number;
}

// 单次预测(不含多窗口去抖;供 predictWithBurnRate 与单测直用)。
export function predictEta(input: PredictInput): PredictResult {
  const { dag, baselineDurationOf, runtime, startedAtMs, triggerAtMs, slaTarget, warnLeadMin, now } = input;

  // 每节点"有效时长":已完成用实际;进行中用 max(基线, 已耗时)(不会低于已耗时);未开始用基线。
  const effDur = (nodeId: string): number => {
    const st = runtime[nodeId];
    const base = baselineDurationOf(nodeId);
    if (!st) return base;
    if (st.status === "succeeded" || st.status === "failed") return Math.max(0, st.actualSec ?? base);
    if (st.status === "running") return Math.max(base, st.elapsedSec ?? 0);
    return base;
  };

  const cp = analyzeCriticalPath(dag, effDur);

  // 已完成节点集合;剩余关键路径 = 关键路径上未完成节点的有效时长之和,
  // 但进行中节点只算"剩余"(基线 - 已耗时,下限 0)。
  let remainingSec = 0;
  let stuck: string | undefined;
  for (const nodeId of cp.criticalPath) {
    const st = runtime[nodeId];
    const status = st?.status;
    if (status === "succeeded" || status === "failed") continue; // 已完成不计入剩余
    if (!stuck) stuck = nodeId; // 关键路径第一个未完成 = 当前卡点
    if (status === "running") {
      const base = baselineDurationOf(nodeId);
      const elapsed = st?.elapsedSec ?? 0;
      remainingSec += Math.max(0, base - elapsed);
    } else {
      remainingSec += baselineDurationOf(nodeId);
    }
  }

  const etaAtMs = now + remainingSec * 1000;
  const slaAtMs = computeSlaDeadline(slaTarget, triggerAtMs || startedAtMs, now);
  const marginMs = slaAtMs - etaAtMs;
  const marginMin = Math.round(marginMs / 60_000);
  const warnLeadMs = warnLeadMin * 60_000;

  let riskLevel: RiskLevel;
  let willBreach: boolean;
  if (marginMs < 0) { riskLevel = "red"; willBreach = true; }
  else if (marginMs < warnLeadMs) { riskLevel = "yellow"; willBreach = false; }
  else { riskLevel = "green"; willBreach = false; }

  return { etaAtMs, slaAtMs, willBreach, riskLevel, criticalPathNode: stuck, marginMin, remainingSec };
}

// 多窗口燃尽率去抖:短窗(急,如最近 1 次预测)与长窗(稳,如最近 N 次预测)都判破线才确认告警,
// 避免单点抖动(某节点偶发变慢又恢复)造成误报。history=最近若干次预测的 willBreach 序列(旧→新)。
export function confirmBreachMultiWindow(currentBreach: boolean, history: boolean[], shortN = 2, longRate = 0.6): boolean {
  if (!currentBreach) return false;
  // 短窗:最近 shortN 次(含当前)全破线 → 急促确认。
  const recent = [...history, currentBreach].slice(-shortN);
  const shortConfirm = recent.length >= shortN && recent.every(Boolean);
  // 长窗:整段历史(含当前)破线占比 ≥ longRate → 稳态确认。
  const all = [...history, currentBreach];
  const longConfirm = all.length > 0 && all.filter(Boolean).length / all.length >= longRate;
  return shortConfirm || longConfirm;
}
