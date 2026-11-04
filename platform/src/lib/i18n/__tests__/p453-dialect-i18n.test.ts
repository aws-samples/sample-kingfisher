import { describe, it, expect } from "vitest";
import { translate } from "@/lib/i18n/translate";
describe("dialect回显 i18n", () => {
  it("已修正文案 en 有翻译(非回退中文)", () => {
    const en = translate("已按平台方言规则自动修正 {n} 处", "en", { n: 2 });
    expect(en).toContain("Auto-corrected");
    expect(en).toContain("2");
    expect(en).not.toContain("已按"); // 不能回退中文
  });
  it("检出违规文案 en 有翻译", () => {
    const en = translate("检出 {n} 处方言问题(运行前会再次校验,error 级会拦截执行)", "en", { n: 1 });
    expect(en).toContain("dialect");
    expect(en).not.toContain("检出");
  });
});
