import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { guard, retrieve } from "@/lib/cookbook";

describe("Athena/Trino 方言规则", () => {
  it("反引号标识符 → 双引号(Trino禁反引号)", () => {
    const g = guard("athena", "SELECT `col` FROM `tbl`;");
    expect(g.code.includes("`")).toBe(false);
    expect(g.code).toContain('"col"');
    expect(g.fixed.some((f) => f.ruleId === "athena.no-backtick-identifier")).toBe(true);
  });

  it("DATEDIFF( → warn 提示(Trino应date_diff)", () => {
    const g = guard("athena", "SELECT DATEDIFF(day, a, b) FROM t;");
    expect(g.violations.some((v) => v.ruleId === "athena.date-diff-trino")).toBe(true);
  });

  it("正确Trino SQL不误伤:三段式双引号+date_diff+approx_distinct", () => {
    const sql = 'SELECT region, approx_distinct(uid) AS uv, date_diff(\'day\', a, b) AS d FROM "s3tablescatalog/bkt"."ns"."t" GROUP BY region LIMIT 100;';
    const g = guard("athena", sql);
    expect(g.blocked).toBe(false);
    expect(g.code).toBe(sql); // 合法SQL完全不变
  });

  it("🔴词法安全:字符串里的反引号不被改", () => {
    const sql = "SELECT 'has `bt` in string' AS note FROM t;";
    const g = guard("athena", sql);
    expect(g.code).toBe(sql); // 字符串内容原样(mask保护)
  });

  it("🔴词法安全:字符串里的DATEDIFF不误报", () => {
    const sql = "SELECT 'DATEDIFF is a redshift func' AS tip FROM t;";
    const g = guard("athena", sql);
    // 字符串内的DATEDIFF被mask遮蔽,不应命中warn
    expect(g.violations.some((v) => v.ruleId === "athena.date-diff-trino")).toBe(false);
  });

  it("Athena配方可检索(湖查询)", async () => {
    const s = await retrieve("athena", { keywords: "查S3Tables湖查询", topK: 3 });
    expect(s.recipes.some((r) => r.id === "athena.s3tables-select")).toBe(true);
  });

  it("Athena方言规则注入retrieve(含三段式/反引号)", async () => {
    const s = await retrieve("athena", { topK: 5 });
    expect(s.dialectRules.some((d) => d.rule.includes("双引号") || d.rule.includes("date_diff"))).toBe(true);
  });

  // 多区避坑知识必须**真能被 AI 路径检索到**(写进 seed ≠ 接上了)
  it("🔴 配方库不许出现两份同义的多区目录教法(单一作者 = 方言规则那一条)", () => {
    const src = readFileSync(resolve(__dirname, "../seed/athena.ts"), "utf8") + readFileSync(resolve(__dirname, "../seed/s3tables.ts"), "utf8");
    expect((src.match(/三样必须是同一个区/g) || []).length).toBe(1);
  });

  it("🔴 多区避坑:Athena「三样同区」+ Flink「sink 表桶占位符」都注入 retrieve,且不拦合法 SQL", async () => {
    const a = await retrieve("athena", { topK: 5 });
    // retrieve 给模型的形状不带 id ⇒ 按标题认
    expect(a.dialectRules.map((d) => d.title)).toContain("多区:目录引用 / 工作组 / 客户端 region 三样必须是同一个区");
    const f = await retrieve("flink", { topK: 5 });
    const keep = f.dialectRules.find((d) => d.title === "占位符必须原样保留(勿写死真实值)");
    expect(keep?.rule).toContain("${TABLE_BUCKET_ARN}");
    // 纯引导:主控区合法 SQL 不被它判违规
    const g = guard("athena", 'SELECT 1 FROM "s3tablescatalog/bgp-table-bucket"."showcase"."t" LIMIT 1;');
    expect(g.violations.map((v) => v.ruleId)).not.toContain("athena.catalog-workgroup-same-region");
    expect(g.blocked).toBe(false);
  });
});
