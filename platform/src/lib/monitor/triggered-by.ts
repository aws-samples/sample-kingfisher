// run 行 `triggeredBy` 的**闭合清单与页面文案**唯一作者。
//
// 【为什么要有这个文件】任务监控页原来把「触发」列写成 `v === "schedule" ? 自动 : 手动`,筛选下拉也只有 自动 / 手动 两项 ——
// 于是补数(backfill)/ 试运行(dryrun)/ 重跑(rerun)/ Copilot 发起的运行**全部显示成「手动」**,而补数实例抽屉的
// 「去监控页定位」带的正是 `?triggeredBy=backfill`:到了监控页,下拉里连「补数」这个选项都没有、列上又都写着「手动」,
// 用户没法确认自己看到的就是补数产生的那几条。「页面显示的状态只许来自真正的结论」(AGENTS §11.9),这里把它钉死:
// 每一种 triggeredBy 有且只有一个文案,列与筛选从同一张表取。
//
// 🔴 清单是闭合的:写 run 行的几处(lib/etl/job-service.ts · lib/engines/spi.ts · lib/sync/start-run.ts · lib/backfill/execute.ts ·
//   lib/copilot/plan/types.ts COPILOT_TRIGGERED_BY)用的值都在这里;新增一种触发来源先登记到这里再接线(单测钉清单)。
import { COPILOT_TRIGGERED_BY } from "@/lib/copilot/plan/types";

export const TRIGGERED_BY_VALUES = ["schedule", "manual", "backfill", "dryrun", "rerun", "dependency", COPILOT_TRIGGERED_BY] as const;
export type TriggeredBy = (typeof TRIGGERED_BY_VALUES)[number];

export interface TriggeredByMeta {
  /** 中文原文(页面经 t() 翻译;Copilot 是产品名,两种语言同形) */
  label: string;
  /** antd Tag 颜色;undefined = 默认灰 */
  color?: string;
}

const META: Record<TriggeredBy, TriggeredByMeta> = {
  schedule: { label: "自动", color: "green" },
  manual: { label: "手动" },
  backfill: { label: "补数", color: "gold" },
  dryrun: { label: "试运行", color: "default" },
  rerun: { label: "重跑", color: "blue" },
  // 上游任务成功后由依赖链触发的下游运行(lib/scheduler/dependency.ts)
  dependency: { label: "依赖触发", color: "cyan" },
  [COPILOT_TRIGGERED_BY]: { label: "Copilot", color: "purple" },
};

export function isTriggeredBy(v: unknown): v is TriggeredBy {
  return typeof v === "string" && (TRIGGERED_BY_VALUES as readonly string[]).includes(v);
}

/** 未知值(存量脏数据 / 新来源没登记)⇒ 原值照出,不冒称「手动」。 */
export function triggeredByMeta(v: unknown): TriggeredByMeta {
  if (isTriggeredBy(v)) return META[v];
  return { label: typeof v === "string" && v ? v : "-" };
}

/** 监控页「触发方式」筛选下拉的选项(label 为中文原文,页面再 t();value = run 行的原值) */
export const TRIGGERED_BY_FILTER_OPTIONS: ReadonlyArray<{ label: string; value: TriggeredBy }> =
  TRIGGERED_BY_VALUES.map((v) => ({ label: META[v].label, value: v }));
