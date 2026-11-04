import { describe, it, expect } from "vitest";
import { sliceToPromptText } from "../prompt";
import { retrieve } from "../retrieve";
import type { CookbookSlice } from "../types";

describe("cookbook sliceToPromptText — 注入格式", () => {
  it("空切片返回空串(不占 token)", () => {
    const empty: CookbookSlice = { engine: "redshift", dialectRules: [], recipes: [], totalMatched: 0 };
    expect(sliceToPromptText(empty)).toBe("");
  });

  it("渲染方言规则(error 标【必须】,warn 标【建议】)", () => {
    const slice: CookbookSlice = {
      engine: "redshift",
      dialectRules: [
        { title: "CTAS 无 IF NOT EXISTS", rule: "用 DROP+CREATE AS", severity: "error" },
        { title: "日期函数", rule: "用 DATEADD", severity: "warn" },
      ],
      recipes: [],
      totalMatched: 0,
    };
    const txt = sliceToPromptText(slice);
    expect(txt).toContain("【必须】CTAS 无 IF NOT EXISTS");
    expect(txt).toContain("【建议】日期函数");
    expect(txt).toContain("redshift");
  });

  it("includeTemplates=false 不含模板正文", () => {
    const slice: CookbookSlice = {
      engine: "redshift",
      dialectRules: [],
      recipes: [{ id: "x", engine: "redshift", capability: "agg", title: "T", whenToUse: "W", template: "SECRET_TEMPLATE", dialectNotes: [], tags: [] }],
      totalMatched: 1,
    };
    expect(sliceToPromptText(slice, { includeTemplates: false })).not.toContain("SECRET_TEMPLATE");
    expect(sliceToPromptText(slice, { includeTemplates: true })).toContain("SECRET_TEMPLATE");
  });

  it("totalMatched > topK 时提示还有更多", () => {
    const slice: CookbookSlice = {
      engine: "redshift", dialectRules: [], totalMatched: 5,
      recipes: [{ id: "x", engine: "redshift", capability: "agg", title: "T", whenToUse: "W", template: "t", dialectNotes: [], tags: [] }],
    };
    expect(sliceToPromptText(slice)).toContain("另有 4 条");
  });

  it("端到端:retrieve → sliceToPromptText 产出非空且含方言", async () => {
    const slice = await retrieve("redshift", { capability: "aggregate", topK: 2 });
    const txt = sliceToPromptText(slice);
    expect(txt.length).toBeGreaterThan(0);
    expect(txt).toContain("方言硬规则");
    expect(/CTAS|IF NOT EXISTS/i.test(txt)).toBe(true); // 恒定注入的 error 方言
  });
});
