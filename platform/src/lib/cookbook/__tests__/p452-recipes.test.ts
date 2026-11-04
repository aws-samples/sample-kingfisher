import { describe, it, expect } from "vitest";
import { retrieve } from "@/lib/cookbook";
describe("P45.2 新配方可检索", () => {
  it("拉链表命中 scd2", async () => {
    const s = await retrieve("redshift", { keywords: "拉链表 缓变维 用户维度变化", topK: 3 });
    expect(s.recipes.some(r => r.id === "redshift.scd2-history")).toBe(true);
  });
  it("留存命中 retention", async () => {
    const s = await retrieve("redshift", { keywords: "次日留存率", topK: 3 });
    expect(s.recipes.some(r => r.id === "redshift.retention-funnel")).toBe(true);
  });
  it("JDBC读源命中 glue", async () => {
    const s = await retrieve("glue", { keywords: "从mysql读数据", topK: 3 });
    expect(s.recipes.some(r => r.id === "glue.jdbc-read-source")).toBe(true);
  });
  it("配方总数增长(redshift>=7)", async () => {
    const s = await retrieve("redshift", { topK: 50 });
    expect(s.totalMatched).toBeGreaterThanOrEqual(7);
  });
});
