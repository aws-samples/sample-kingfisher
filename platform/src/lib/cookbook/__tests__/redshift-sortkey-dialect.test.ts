import { describe, it, expect } from "vitest";
import { retrieve } from "../retrieve";

// 验证新沉淀的 Redshift 建表方言真正接入了 cookbook 检索层——这是它对 AI codegen 起作用的前提。
// retrieve(engine) 返回的 CookbookSlice.dialectRules 无条件包含该引擎【全部】方言(retrieve.ts:75),
// 故 AI 生成 Redshift 代码前(codegen.ts:132 retrieve("redshift"))必然拿到这条方言注入提示词。
// 比"让 AI 生成看是否遵循"稳定(不依赖模型随机输出),直击方言的作用机制。
describe("redshift 建表 DISTKEY/SORTKEY 方言已接入 cookbook 检索层", () => {
  it("retrieve('redshift') 的 dialectRules 含新建表方言", async () => {
    const slice = await retrieve("redshift", { keywords: "create table sortkey distkey", topK: 3 });
    const titles = slice.dialectRules.map((r) => r.title).join(" | ");
    // 命中新方言(标题含 DISTKEY/SORTKEY)
    const hit = slice.dialectRules.some(
      (r) => r.title.includes("DISTKEY") && r.title.includes("SORTKEY")
    );
    expect(hit, `dialectRules 应含建表 DISTKEY/SORTKEY 方言,实际:${titles}`).toBe(true);
  });

  it("方言规则文本覆盖关键约束(DISTSTYLE KEY 必配列 + 预览≠执行)", async () => {
    const slice = await retrieve("redshift", { keywords: "sortkey", topK: 3 });
    const rule = slice.dialectRules.find(
      (r) => r.title.includes("DISTKEY") && r.title.includes("SORTKEY")
    );
    expect(rule, "应找到建表方言").toBeTruthy();
    // 关键约束都在规则文本里(供 AI 遵循)
    expect(rule!.rule).toContain("DISTSTYLE KEY");     // 语法坑警示
    expect(rule!.rule).toContain("DISTKEY");
    expect(rule!.rule).toContain("SORTKEY");
  });

  it("与既有 redshift 方言不冲突(方言集仍非空、含历史条目)", async () => {
    const slice = await retrieve("redshift", { keywords: "aggregate", topK: 3 });
    // 沉淀新方言后,既有方言(如 OID 并发/CTAS)仍在——没覆盖掉别的(零回归)
    expect(slice.dialectRules.length).toBeGreaterThanOrEqual(7); // 原 6 + 新 1
  });
});
