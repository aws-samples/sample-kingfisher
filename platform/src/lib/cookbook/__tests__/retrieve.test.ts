import { describe, it, expect } from "vitest";
import { retrieve } from "../retrieve";
import { normalizeCapability, normalizeQueryTokens } from "../capability-vocab";
import { allDialectRulesForPrompt, listCookbookEngines } from "../registry";

describe("cookbook retrieve — 打分 + topK(控 token)", () => {
  it("恒定注入该引擎方言规则(error 在前)", async () => {
    const slice = await retrieve("redshift");
    expect(slice.dialectRules.length).toBeGreaterThan(0);
    // 至少含 CTAS 那条 error 规则,且排在 warn 之前。
    const firstWarnIdx = slice.dialectRules.findIndex((d) => d.severity === "warn");
    const lastErrIdx = slice.dialectRules.map((d) => d.severity).lastIndexOf("error");
    if (firstWarnIdx >= 0 && lastErrIdx >= 0) expect(lastErrIdx).toBeLessThan(firstWarnIdx);
  });

  it("按 capability 命中相关配方在前(aggregate → CTAS 聚合配方)", async () => {
    const slice = await retrieve("redshift", { capability: "aggregate", topK: 1 });
    expect(slice.recipes.length).toBe(1);
    expect(slice.recipes[0].capability).toBe("ctas-aggregate");
  });

  it("topK 截断生效(控 token)", async () => {
    const all = await retrieve("redshift", { topK: 50 });
    const limited = await retrieve("redshift", { topK: 1 });
    expect(limited.recipes.length).toBeLessThanOrEqual(1);
    expect(all.recipes.length).toBeGreaterThanOrEqual(limited.recipes.length);
  });

  it("引擎过滤:redshift 检索不返回 flink 配方", async () => {
    const slice = await retrieve("redshift", { topK: 50 });
    expect(slice.recipes.every((r) => r.engine === "redshift")).toBe(true);
  });

  // P45.2 后词表升级:留存/roi 从 aggregate 分出各自专属能力(有了专属配方)。
  it("同义词归一到各自专属能力词", () => {
    expect(normalizeCapability("留存")).toBe("retention");   // 有 retention-funnel 配方
    expect(normalizeCapability("roi")).toBe("ctas-aggregate"); // ROI 归聚合建表
    expect(normalizeCapability("拉链表")).toBe("scd2");       // 有 scd2 配方
    expect(normalizeCapability("去重")).toBe("dedup");
  });

  it("中文诉求分词归一命中(ROI → ctas-aggregate)", () => {
    const tokens = normalizeQueryTokens("帮我把广告 ROI 算出来");
    expect(tokens.has("ctas-aggregate")).toBe(true);
  });
});

describe("cookbook — 引擎覆盖 + planner 提示词", () => {
  it("覆盖 redshift/s3tables/glue/emr/flink", () => {
    const engines = listCookbookEngines();
    for (const e of ["redshift", "s3tables", "glue", "emr", "flink"]) expect(engines).toContain(e);
  });
  it("planner 能拿到 Redshift error 级方言规则(CTAS)", () => {
    const rs = allDialectRulesForPrompt().find((b) => b.engine === "redshift");
    expect(rs && rs.rules.some((r) => r.includes("CTAS") || r.includes("IF NOT EXISTS"))).toBe(true);
  });
});
