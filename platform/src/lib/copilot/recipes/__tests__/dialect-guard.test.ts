import { describe, it, expect } from "vitest";
import { guardScript } from "../dialect-guard";
import { allDialectRulesForPrompt, listRecipeEngines } from "../registry";

describe("dialect-guard 根治验证", () => {
  it("修正真实失败的 CTAS+IF NOT EXISTS(Redshift)", () => {
    const bad = "CREATE TABLE IF NOT EXISTS public.ad_campaign_roi AS\nSELECT c.campaign_id FROM public.ad_campaigns c;";
    const r = guardScript("redshift", bad);
    expect(/IF\s+NOT\s+EXISTS\s+\S+\s+AS/i.test(r.script)).toBe(false);
    expect(/DROP TABLE IF EXISTS public\.ad_campaign_roi/i.test(r.script)).toBe(true);
    expect(r.fixed.length).toBeGreaterThan(0);
  });
  it("MySQL 反引号→双引号", () => {
    const r = guardScript("redshift", "SELECT `col` FROM `tbl`;");
    expect(r.script.includes("`")).toBe(false);
    expect(r.script).toContain('"col"');
  });
  it("正常 Redshift SQL 不被误改", () => {
    const ok = "DROP TABLE IF EXISTS x; CREATE TABLE x AS SELECT 1;";
    expect(guardScript("redshift", ok).script).toBe(ok);
  });
});

describe("配方库覆盖多引擎(非只2个)", () => {
  it("引擎覆盖 redshift/s3tables/glue/emr/flink", () => {
    const engines = listRecipeEngines();
    for (const e of ["redshift","s3tables","glue","emr","flink"]) expect(engines).toContain(e);
  });
  it("planner 提示词能拿到方言硬规则", () => {
    const rs = allDialectRulesForPrompt().find(b => b.engine === "redshift");
    expect(rs && rs.rules.some(r => r.includes("CTAS") || r.includes("IF NOT EXISTS"))).toBe(true);
  });
});
