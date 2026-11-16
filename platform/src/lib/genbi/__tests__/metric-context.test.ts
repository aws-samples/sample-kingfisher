// 建模指标 → 问数语义上下文(core 纯转换)的判据。
//
// 钉三件事实:
//   ① 给模型读的定义文本与「指标的可执行 SQL」说的是同一件事 —— 聚合表达式、表、过滤谓词逐项与指标 SQL 构造器的产出相同
//      (只差一处:SQL 里标识符带双引号,给模型读的文本不带);
//      三份闭合清单(聚合 / 运算符 / 时间周期)新增一种而这里没有对应文本 ⇒ 红。
//   ② 派生指标落到它引用的原子上(表与聚合取原子的,过滤与时间范围取自己的);落不成的行不进上下文,不编造。
//   ③ 口径行与指标行合并后的顺序 / 截断是确定的(最近更新在前),与输入顺序无关。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { EN } from "@/lib/i18n/messages/en";
import {
  METRIC_AGG_TEXT, METRIC_OP_TEXT, METRIC_TIME_WINDOW_TEXT,
  metricAggText, metricTableOf, metricDefinitionText, metricsToContextEntries, groundingEntries, resolveMetricSpec,
  type MetricRowLike,
} from "../core/metric-context";
import { CONTEXT_KIND_LABEL, contextToPromptText, contextToUsedItems, contextToGroundingItems } from "../core/context-format";
import type { ContextEntry } from "../core/types";
import { AGGS, OPS, TIME_WINDOWS, aggExpr, modifierPredicate, quoteTable, timeWindowPredicate, buildMetricSql } from "@/lib/modeling/metric-sql";

/** SQL 构造器给标识符加的双引号去掉后,应与定义文本逐字相同。 */
const bare = (sqlFragment: string) => sqlFragment.replace(/"/g, "");

const atomic: MetricRowLike = {
  modelMetricId: "01ATOMIC", name: "订单总额", metricType: "atomic", caliber: "已支付订单的金额合计", unit: "元",
  fqn: "dev.public.orders", agg: "sum", measureColumn: "amount", timeColumn: "created_at",
  createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z",
};
const derived: MetricRowLike = {
  modelMetricId: "01DERIVED", name: "近30日华东订单总额", metricType: "derived", atomicId: "01ATOMIC", timeWindow: "30d",
  modifiers: [{ column: "region", op: "=", value: "East" }, { column: "status", op: "in", value: ["paid", "shipped"] }],
  createdAt: "2026-11-03T00:00:00.000Z", updatedAt: "2026-11-03T00:00:00.000Z",
};

describe("指标定义文本与指标 SQL 构造器逐项一致", () => {
  it("聚合:闭合清单同集合,每一种的表达式文本 == SQL 构造器的聚合表达式", () => {
    expect(Object.keys(METRIC_AGG_TEXT).sort()).toEqual([...AGGS].sort());
    for (const agg of AGGS) expect(metricAggText(agg, "amount"), agg).toBe(bare(aggExpr(agg, "amount")));
  });

  it("运算符:闭合清单同集合,每一种的过滤文本 == SQL 构造器的谓词", () => {
    expect(Object.keys(METRIC_OP_TEXT).sort()).toEqual([...OPS].sort());
    for (const op of OPS) {
      const m = { column: "status", op, value: op === "in" ? ["paid", "it's"] : "it's" };
      const text = metricDefinitionText({ fqn: "public.orders", agg: "count", measureColumn: undefined, timeColumn: undefined, timeWindow: undefined, modifiers: [m] });
      expect(text, op).toContain(`过滤条件 ${bare(modifierPredicate(m as any))}`);
    }
  });

  it("时间周期:闭合清单同集合;SQL 里有时间谓词的周期这里必有说明,「全部」两边都不出", () => {
    expect(Object.keys(METRIC_TIME_WINDOW_TEXT).sort()).toEqual([...TIME_WINDOWS].sort());
    for (const tw of TIME_WINDOWS) {
      const hasPredicate = timeWindowPredicate(tw, "created_at") !== "";
      const text = metricDefinitionText({ fqn: "public.orders", agg: "count", measureColumn: undefined, timeColumn: "created_at", timeWindow: tw, modifiers: [] }) || "";
      expect(text.includes("时间范围"), tw).toBe(hasPredicate);
      if (hasPredicate) expect(text, tw).toContain(`时间范围 ${METRIC_TIME_WINDOW_TEXT[tw]},按时间列 created_at`);
    }
  });

  it("没有时间列 ⇒ SQL 没有时间过滤,定义文本也不声称有时间范围", () => {
    expect(timeWindowPredicate("30d", undefined)).toBe("");
    const text = metricDefinitionText({ fqn: "public.orders", agg: "count", measureColumn: undefined, timeColumn: undefined, timeWindow: "30d", modifiers: [] });
    expect(text).not.toContain("时间范围");
  });

  it("表:取全名最后两段,与 SQL 构造器取表相同", () => {
    for (const fqn of ["dev.public.orders", "public.orders", "svc.dev.ecommerce.order_items"]) expect(metricTableOf(fqn)).toBe(bare(quoteTable(fqn)));
    expect(metricTableOf("orders")).toBeNull();
  });

  it("派生指标:定义文本里的表 / 聚合 / 过滤 == 同一份解析规格生成的 SQL 里的那几段", () => {
    const r = resolveMetricSpec(derived, atomic);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sql = buildMetricSql(r.spec as any);
    const [entry] = metricsToContextEntries([atomic, derived]).filter((e) => e.entryId === "metric:01DERIVED");
    expect(bare(sql)).toBe("SELECT SUM(amount) AS value FROM public.orders WHERE region = 'East' AND status IN ('paid', 'shipped') AND created_at >= DATEADD(day, -30, CURRENT_DATE)");
    expect(entry.body).toContain("数仓表 public.orders");
    expect(entry.body).toContain("计算方式 SUM(amount)");
    expect(entry.body).toContain("过滤条件 region = 'East' AND status IN ('paid', 'shipped')");
    expect(entry.body).toContain("时间范围 最近 30 天(自 30 天前零点起),按时间列 created_at");
    expect(entry.body).toContain("基于原子指标「订单总额」");
  });
});

describe("指标行 → 上下文条目", () => {
  it("原子指标:kind = metric、标题 = 指标名、适用范围 = 表、正文带口径 / 表 / 计算方式 / 单位,归 global", () => {
    const [e] = metricsToContextEntries([atomic]);
    expect(e).toEqual({
      projectId: "global", entryId: "metric:01ATOMIC", kind: "metric", title: "订单总额", scope: "public.orders", enabled: true,
      body: "已支付订单的金额合计;数仓表 public.orders;计算方式 SUM(amount);单位 元",
      createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z",
    });
  });

  it("进提示与进页面的标签是「建模指标」,与用户手建的口径条目分得开", () => {
    const es = metricsToContextEntries([atomic]);
    expect(CONTEXT_KIND_LABEL.metric).toBe("建模指标");
    expect(contextToPromptText(es)).toBe("- [建模指标] 订单总额（适用：public.orders）：已支付订单的金额合计;数仓表 public.orders;计算方式 SUM(amount);单位 元");
    expect(contextToUsedItems(es)).toEqual([{ title: "订单总额", kindLabel: "建模指标", scope: "public.orders" }]);
    expect(contextToGroundingItems(es)[0]).toMatchObject({ kind: "建模指标", title: "订单总额", scope: "public.orders" });
  });

  it("条目标签在英文模式下不露中文:每种标签在英文词典里都有译,问数结果卡经 t() 渲染标签(动态键,词典覆盖守卫扫不到)", () => {
    for (const label of Object.values(CONTEXT_KIND_LABEL)) expect(label in EN, `英文词典缺「${label}」`).toBe(true);
    const page = fs.readFileSync(path.join(process.cwd(), "src/app/genbi/page.tsx"), "utf8");
    expect(page).toContain("{t(c.kindLabel)} · {c.title}");
    expect(page).not.toContain("{c.kindLabel} · {c.title}");
  });

  it("落不成定义的行一律不进上下文:派生找不到原子 / 引用的不是原子 / 聚合不在清单 / 缺度量列 / 缺名字 / 不是指标行", () => {
    const rows: MetricRowLike[] = [
      { ...derived, modelMetricId: "D1", atomicId: "NOPE" },
      { ...derived, modelMetricId: "D2", atomicId: "01DERIVED" },
      { ...atomic, modelMetricId: "A1", agg: "median" },
      { ...atomic, modelMetricId: "A2", measureColumn: undefined },
      { ...atomic, modelMetricId: "A3", name: "  " },
      { ...derived, modelMetricId: "D3", modifiers: [{ column: "region", op: "like", value: "E%" }] },
      { ...derived, modelMetricId: "D4", timeWindow: "1y" },
      // 口径表的行被误当指标行喂进来(两张表的行形态不同)⇒ 跳过,不炸
      { projectId: "global", entryId: "x", kind: "term", title: "大R", body: "高付费玩家" } as unknown as MetricRowLike,
    ];
    expect(metricsToContextEntries([derived, ...rows]).map((e) => e.entryId)).toEqual([]);
    expect(metricsToContextEntries(undefined as unknown as MetricRowLike[])).toEqual([]);
  });

  it("正文恒为一行:口径里的换行被压成空格(提示里一条一行)", () => {
    const [e] = metricsToContextEntries([{ ...atomic, caliber: "第一行\n第二行\t尾" }]);
    expect(e.body.startsWith("第一行 第二行 尾;")).toBe(true);
    expect(e.body).not.toMatch(/[\n\t]/);
  });
});

describe("口径行 ∪ 指标行:合并顺序与截断", () => {
  const ctx = (id: string, updatedAt: string, extra: Partial<ContextEntry> = {}): ContextEntry =>
    ({ projectId: "p", entryId: id, kind: "caliber", title: `口径${id}`, body: "x", enabled: true, createdAt: updatedAt, updatedAt, ...extra });

  it("最近更新在前;同一批行换个输入顺序,结果相同", () => {
    const rowsA = [ctx("a", "2026-11-01T00:00:00.000Z"), ctx("b", "2026-11-04T00:00:00.000Z")];
    const a = groundingEntries(rowsA, [atomic, derived]).map((e) => e.entryId);
    const b = groundingEntries([...rowsA].reverse(), [derived, atomic]).map((e) => e.entryId);
    expect(a).toEqual(["b", "metric:01DERIVED", "metric:01ATOMIC", "a"]);
    expect(b).toEqual(a);
  });

  it("问题里提到指标名 ⇒ 该指标排到最前;停用的口径行被剔除;指标不会因为排在后面被截掉", () => {
    const many = Array.from({ length: 45 }, (_, i) => ctx(`c${String(i).padStart(2, "0")}`, `2026-11-10T00:00:${String(i).padStart(2, "0")}.000Z`));
    const out = groundingEntries([...many, ctx("off", "2026-11-11T00:00:00.000Z", { enabled: false })], [atomic], "上个月订单总额是多少");
    expect(out).toHaveLength(40);
    expect(out[0].entryId).toBe("metric:01ATOMIC");
    expect(out.some((e) => e.entryId === "off")).toBe(false);
  });
});
