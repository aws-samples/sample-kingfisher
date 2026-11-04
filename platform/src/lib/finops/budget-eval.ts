// 预算评估:算本月已耗 → 与预算限额比 → 越 80%/100% 档经 34 通道推送。
// 幂等:notifiedMarks 记录 "<month>#<threshold>",每月每档只推一次。

import { dispatch } from "@/lib/alerting/notify";
import { listChannels, getChannels } from "@/lib/alerting/channels";
import { DEFAULT_PROJECT_ID } from "@/lib/projects/constants";
import { listBudgets, listCostDaily, markBudgetNotified, updateBudgetEval } from "./store";
import type { Budget } from "./types";

const THRESHOLDS = [80, 100] as const;

function monthOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

// 预算作用域 → 本月已耗(读 bgp-cost-daily;project 作用域一期=account 全额,项目级归因二期)。
async function spentOf(b: Budget, month: string): Promise<number> {
  const rows = await listCostDaily(month);
  if (b.scope.kind === "service") {
    const svc = b.scope.service;
    return rows.filter((r) => r.service === svc).reduce((a, r) => a + r.amountUsd, 0);
  }
  // region 作用域:只算**那个区**的花费。
  // 🔴 落 REGION 分组之前采的存量行没有 region ⇒ **不算进任何区的预算**。
  //    把它们算进来会让某个区的预算凭空多出一大笔(那是账号级合计),预算当场误报越档;
  //    漏掉它们则是「这个区的预算暂时少算了 —— 重采后就准了」,两害相权取后者,
  //    并由大盘那条 `unattributedNote` 把「有多少钱还没归区」如实说给用户。
  if (b.scope.kind === "region") {
    const want = b.scope.region;
    return rows.filter((r) => (r.region || "") === want).reduce((a, r) => a + r.amountUsd, 0);
  }
  return rows.reduce((a, r) => a + r.amountUsd, 0);
}

export interface BudgetEvalResult {
  budgetId: string;
  name: string;
  month: string;
  spentUsd: number;
  limitUsd: number;
  pct: number;
  notifiedThreshold?: number;
}

export async function evaluateBudgets(): Promise<BudgetEvalResult[]> {
  const month = monthOf(new Date());
  // 预算横切账号级,统一存 default 分区(与异常检测的 PROJECT_ID 一致)。
  const budgets = (await listBudgets(DEFAULT_PROJECT_ID)).filter((b) => b.enabled);
  const out: BudgetEvalResult[] = [];

  for (const b of budgets) {
    const spentUsd = await spentOf(b, month);
    const pct = b.monthlyLimitUsd > 0 ? (spentUsd / b.monthlyLimitUsd) * 100 : 0;
    const result: BudgetEvalResult = {
      budgetId: b.budgetId,
      name: b.name,
      month,
      spentUsd,
      limitUsd: b.monthlyLimitUsd,
      pct,
    };

    await updateBudgetEval(DEFAULT_PROJECT_ID, b.budgetId, { month, spentUsd, pct, at: new Date().toISOString() });

    // 只推最高越档(100 优先于 80),每月每档一次。
    const marks = new Set(b.notifiedMarks ?? []);
    const crossed = THRESHOLDS.filter((t) => pct >= t && !marks.has(`${month}#${t}`)).pop();
    if (crossed) {
      const channels = b.channelIds.length ? await getChannels(b.channelIds) : (await listChannels()).filter((c) => c.enabled);
      await dispatch(channels, {
        title: `[FinOps] 预算${crossed >= 100 ? "超限" : "预警"}:${b.name}`,
        severity: crossed >= 100 ? "P2" : "P3",
        ruleName: "FinOps 预算护栏",
        message: `预算「${b.name}」${month} 已耗 $${spentUsd.toFixed(2)} / 限额 $${b.monthlyLimitUsd.toFixed(2)}(${pct.toFixed(0)}%),越过 ${crossed}% 档。`,
        trigger: { metricValue: spentUsd },
      });
      await markBudgetNotified(DEFAULT_PROJECT_ID, b.budgetId, `${month}#${crossed}`);
      result.notifiedThreshold = crossed;
    }
    out.push(result);
  }
  return out;
}
