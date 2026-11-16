// 装配层判据:报表视觉对象引用建模指标(取数来源 kind = metric)+ 视觉对象的落点章保存后还在。
//
// 钉的事实:
//   ① 指标来源的视觉对象里只有指标 id;每次取数跑的 SQL = 指标 SQL 构造器按指标**当前**定义生成的那一条
//      (在数据建模里改了指标,下一次取数的 SQL 跟着变 —— 没有第二份快照);
//   ② 只在数仓上跑,落点 = 视觉对象自己的章(指标来源必填),请求点名的盖不过它;结果必过脱敏;结果列显示成指标名(带单位);
//   ③ 指标被删 ⇒ 404 并指路;派生引用的原子没了 ⇒ 400 带原因 —— 都不发 SQL、不回一个没有来历的空结果;
//   ④ 保存视觉对象(看板 / 报表共用的归一化)不丢落点章:2026-11-12 真环境坐实过「某执行区视角建的视觉对象,
//      保存后落点没了,重新打开回到主控区取数、列表『涉及区域』恒为主控区」。
// 只 mock 真外部:DynamoDB、数仓那一跳(Data API 边界)、脱敏读分级、OpenMetadata 术语推送。
// 指标服务 ↔ 指标 SQL 构造器 ↔ BI 取数 ↔ 看板归一化之间一律真跑。
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({ tables: new Map<string, Array<Record<string, any>>>() }));
const seen = vi.hoisted(() => ({
  sqls: [] as string[], places: [] as Array<{ targetId: string; projectId?: string | null }>,
  maskSqls: [] as string[], records: [[{ doubleValue: 1234.5 }]] as unknown[][], masked: [] as string[],
}));
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { MODEL_METRICS: "bgp-model-metrics", BI_ANALYSES: "bgp-bi-analyses", BI_REPORTS: "bgp-bi-reports" },
  docClient: {
    send: async (cmd: any) => {
      const i = cmd.input;
      const rows = db.tables.get(i.TableName) || [];
      if (i.Item) { db.tables.set(i.TableName, [...rows.filter((r) => !sameKey(r, i.Item)), { ...i.Item }]); return {}; }
      if (i.Key && !i.UpdateExpression) return { Item: rows.find((r) => Object.entries(i.Key).every(([k, v]) => r[k] === v)) };
      throw new Error("装配层 mock 不认识这条 DynamoDB 调用");
    },
  },
}));
const sameKey = (a: any, b: any) => (a.pk !== undefined ? a.pk === b.pk && a.modelMetricId === b.modelMetricId : a.projectId === b.projectId && (a.analysisId ?? a.reportId) === (b.analysisId ?? b.reportId));
vi.mock("@/lib/openmetadata/om-glossary", () => ({ pushMetricGlossary: async () => {} }));
vi.mock("@/lib/redshift/direct-query", () => ({
  resolveDirectQueryPlace: async (scope: any) => { seen.places.push({ targetId: scope.targetId, projectId: scope.projectId }); return { targetId: scope.targetId, region: "us-west-2", workgroup: "wg", database: "dev" }; },
  directQueryRaw: async (_place: unknown, sql: string) => { seen.sqls.push(sql); return { columns: ["value"], records: seen.records, totalNumRows: seen.records.length }; },
}));
vi.mock("@/lib/genbi/athena", () => ({ runSelectAthena: async () => { throw new Error("指标来源不该走数据湖引擎"); } }));
vi.mock("@/lib/governance/masking", () => ({
  maskRows: async (i: any) => { seen.maskSqls.push(i.sql); return { rows: i.rows, maskedColumns: seen.masked }; },
}));

import { executeBiQuery, type BiQueryError } from "@/lib/bi/query";
import { normalizeSource, createReport } from "@/lib/bi/reports";
import { createAnalysis } from "@/lib/bi/analysis";
import { analysisRegions } from "@/lib/bi/definition-regions";
import { WIDGET_SOURCE_KINDS } from "@/lib/bi/types";
import { createModelMetric, updateModelMetric } from "@/lib/modeling/model-metrics";
import { buildMetricSql } from "@/lib/modeling/metric-sql";

const opts = (targetId: string) => ({ identity: null, correlationId: "cid", targetId, projectId: "proj-a" });
const bare = (s: string) => s.replace(/"/g, "");
async function caught(p: Promise<unknown>): Promise<BiQueryError> {
  try { await p; } catch (e) { return e as BiQueryError; }
  throw new Error("应当抛 BiQueryError");
}

describe("报表视觉对象引用建模指标", () => {
  let atomId = "";
  let derivedId = "";
  beforeEach(async () => {
    db.tables.clear(); seen.sqls.length = 0; seen.places.length = 0; seen.maskSqls.length = 0; seen.masked = []; seen.records = [[{ doubleValue: 1234.5 }]];
    const atom = await createModelMetric({ name: "订单总额", metricType: "atomic", unit: "元", fqn: "dev.public.orders", agg: "sum", measureColumn: "amount", timeColumn: "created_at" }, "admin");
    const derived = await createModelMetric({ name: "近7日华东订单总额", metricType: "derived", atomicId: atom.modelMetricId, timeWindow: "7d", modifiers: [{ column: "region", op: "=", value: "East" }] }, "admin");
    atomId = atom.modelMetricId; derivedId = derived.modelMetricId;
  });

  it("取数来源的闭合清单里有 metric", () => {
    expect([...WIDGET_SOURCE_KINDS]).toEqual(["sql", "dataapi", "genbi", "metric"]);
  });

  it("原子指标:跑的就是指标 SQL 构造器那一条,落在视觉对象自己的章上(请求点名别的区也不改),过脱敏,结果列 = 指标名(单位)", async () => {
    const r = await executeBiQuery({ kind: "metric", modelMetricId: atomId, targetId: "tgt_usw2_a" }, opts("tgt_home"));
    const expected = buildMetricSql({ fqn: "dev.public.orders", agg: "sum", measureColumn: "amount", timeColumn: "created_at" });
    expect(seen.sqls).toHaveLength(1);
    expect(seen.sqls[0]).toContain(expected);
    expect(bare(expected)).toBe("SELECT SUM(amount) AS value FROM public.orders");
    expect(seen.places).toEqual([{ targetId: "tgt_usw2_a", projectId: "proj-a" }]);
    expect(seen.maskSqls).toEqual([expected]);
    expect(r.columns).toEqual(["订单总额(元)"]);
    expect(r.rows).toEqual([["1234.5"]]);
  });

  it("派生指标:SQL 带它自己的过滤与时间范围;视觉对象自己的落点章赢过请求点名的", async () => {
    await executeBiQuery({ kind: "metric", modelMetricId: derivedId, targetId: "tgt_home" }, opts("tgt_usw2_a"));
    expect(bare(seen.sqls[0])).toContain("SELECT SUM(amount) AS value FROM public.orders WHERE region = 'East' AND created_at >= DATEADD(day, -7, CURRENT_DATE)");
    expect(seen.places[0].targetId).toBe("tgt_home");
  });

  it("在数据建模里改了指标定义 ⇒ 同一个视觉对象下一次取数的 SQL 跟着变", async () => {
    const source = { kind: "metric" as const, modelMetricId: atomId, targetId: "tgt_home" };
    await executeBiQuery(source, opts("tgt_home"));
    await updateModelMetric(atomId, { agg: "avg", measureColumn: "amount_usd" });
    await executeBiQuery(source, opts("tgt_home"));
    expect(bare(seen.sqls[0])).toContain("SELECT SUM(amount) AS value FROM public.orders");
    expect(bare(seen.sqls[1])).toContain("SELECT AVG(amount_usd) AS value FROM public.orders");
  });

  it("被脱敏的结果列也按指标名报出来", async () => {
    seen.masked = ["value"];
    const r = await executeBiQuery({ kind: "metric", modelMetricId: atomId, targetId: "tgt_home" }, opts("tgt_home"));
    expect(r.maskedColumns).toEqual(["订单总额(元)"]);
  });

  it("指标被删 ⇒ 404 NOT_FOUND 并指路,不发 SQL", async () => {
    db.tables.set("bgp-model-metrics", (db.tables.get("bgp-model-metrics") || []).filter((r) => r.modelMetricId !== atomId));
    const e = await caught(executeBiQuery({ kind: "metric", modelMetricId: atomId, targetId: "tgt_home" }, opts("tgt_home")));
    expect(e).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(e.error).toContain("重新选择指标");
    expect(seen.sqls).toHaveLength(0);
  });

  it("派生指标引用的原子没了 ⇒ 400 带原因,不发 SQL;没给指标 id ⇒ 400", async () => {
    db.tables.set("bgp-model-metrics", (db.tables.get("bgp-model-metrics") || []).filter((r) => r.modelMetricId !== atomId));
    const e = await caught(executeBiQuery({ kind: "metric", modelMetricId: derivedId, targetId: "tgt_home" }, opts("tgt_home")));
    expect(e.status).toBe(400);
    expect(e.error).toContain("派生指标引用的原子指标不存在");
    const e2 = await caught(executeBiQuery({ kind: "metric", modelMetricId: "", targetId: "tgt_home" }, opts("tgt_home")));
    expect(e2.status).toBe(400);
    expect(seen.sqls).toHaveLength(0);
  });
});

describe("保存视觉对象:取数来源归一化", () => {
  beforeEach(() => db.tables.clear());

  it("metric 来源:只存指标 id + 落点章,不存 SQL;缺 id / id 形状不对 ⇒ 拒", () => {
    expect(normalizeSource({ kind: "metric", modelMetricId: " 01JABCDEF ", sql: "select 1", engine: "athena", targetId: "tgt_usw2_a" }))
      .toEqual({ kind: "metric", modelMetricId: "01JABCDEF", targetId: "tgt_usw2_a" });
    expect(() => normalizeSource({ kind: "metric", targetId: "tgt_home" })).toThrow("指标来源需要选择一个指标");
    expect(() => normalizeSource({ kind: "metric", modelMetricId: "a b;drop", targetId: "tgt_home" })).toThrow("指标 id 非法");
  });

  it("metric 来源的落点必填:没给 / 给空 ⇒ 拒(不默认主控区);给了非法值 ⇒ 拒;主控区也要明写", () => {
    expect(() => normalizeSource({ kind: "metric", modelMetricId: "01JABCDEF" })).toThrow("指标来源需要取数落点");
    expect(() => normalizeSource({ kind: "metric", modelMetricId: "01JABCDEF", targetId: "" })).toThrow("指标来源需要取数落点");
    expect(() => normalizeSource({ kind: "metric", modelMetricId: "01JABCDEF", targetId: "us-west-2" })).toThrow("取数落点非法");
    expect(normalizeSource({ kind: "metric", modelMetricId: "01JABCDEF", targetId: "tgt_home" })).toEqual({ kind: "metric", modelMetricId: "01JABCDEF", targetId: "tgt_home" });
  });

  it.each([
    ["sql", { kind: "sql", engine: "redshift", sql: "select 1 as v" }],
    ["genbi", { kind: "genbi", engine: "athena", sql: "select 1 as v", question: "多少" }],
  ])("%s 来源(有存量行):落点章原样存下来;没给就不写字段;给了非法值 ⇒ 拒(不静默丢)", (_k, base) => {
    expect(normalizeSource({ ...base, targetId: "tgt_usw2_a" })).toEqual({ ...base, targetId: "tgt_usw2_a" });
    expect(normalizeSource(base)).toEqual(base);
    expect("targetId" in normalizeSource({ ...base, targetId: "" })).toBe(false);
    expect(() => normalizeSource({ ...base, targetId: "us-west-2" })).toThrow("取数落点非法");
  });

  it("看板落库的行里视觉对象带着落点章 ⇒ 列表「涉及区域」是它真取数的区,不是恒主控区", async () => {
    const a = await createAnalysis({
      name: "跨区看板",
      widgets: [
        { name: "西部指标", source: { kind: "metric", modelMetricId: "01JABCDEF", targetId: "tgt_usw2_a" }, viz: { chart: "metric" } },
        { name: "西部 SQL", source: { kind: "sql", engine: "redshift", sql: "select 1 as v", targetId: "tgt_usw2_a" }, viz: { chart: "table" } },
        { name: "主控区 SQL", source: { kind: "sql", engine: "redshift", sql: "select 1 as v" }, viz: { chart: "table" } },
      ],
    }, { projectId: "proj-a", createdBy: "admin" });
    const row = (db.tables.get("bgp-bi-analyses") || []).find((r) => r.analysisId === a.analysisId)!;
    expect(row.widgets.map((w: any) => w.source.targetId)).toEqual(["tgt_usw2_a", "tgt_usw2_a", undefined]);
    expect(row.widgets[0].source).toEqual({ kind: "metric", modelMetricId: "01JABCDEF", targetId: "tgt_usw2_a" });
    expect(analysisRegions(row)).toEqual(["tgt_home", "tgt_usw2_a"]);
  });

  it("报表库的行同样带着落点章", async () => {
    const r = await createReport({ name: "西部报表", source: { kind: "sql", engine: "redshift", sql: "select 1 as v", targetId: "tgt_usw2_a" }, viz: { chart: "table" } } as any, { projectId: "proj-a", createdBy: "admin" } as any);
    const row = (db.tables.get("bgp-bi-reports") || []).find((x) => x.reportId === r.reportId)!;
    expect(row.source.targetId).toBe("tgt_usw2_a");
  });
});
