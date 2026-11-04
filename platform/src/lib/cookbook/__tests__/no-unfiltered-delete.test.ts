import { describe, it, expect } from "vitest";
import { guard } from "@/lib/cookbook";

describe("redshift 无条件DELETE/TRUNCATE阻断(error无fix)", () => {
  it("DELETE FROM t; (无WHERE) → blocked", () => {
    const g = guard("redshift", "DELETE FROM public.orders;");
    expect(g.blocked).toBe(true);
    expect(g.violations.some(v => v.ruleId === "redshift.no-unfiltered-delete-truncate")).toBe(true);
  });
  it("TRUNCATE TABLE t → blocked", () => {
    const g = guard("redshift", "TRUNCATE TABLE public.orders;");
    expect(g.blocked).toBe(true);
  });
  it("DELETE FROM t WHERE ... (带WHERE) → 不阻断", () => {
    const g = guard("redshift", "DELETE FROM public.orders WHERE dt = '2026-01-01';");
    expect(g.blocked).toBe(false);
  });
  it("UPSERT范式 DELETE FROM t USING s WHERE... → 不阻断(不误伤自己的配方)", () => {
    const g = guard("redshift", "DELETE FROM public.target USING public.staging s WHERE public.target.pk = s.pk;");
    expect(g.blocked).toBe(false);
  });
  it("正常CTAS不阻断", () => {
    const g = guard("redshift", "DROP TABLE IF EXISTS x; CREATE TABLE x AS SELECT 1;");
    expect(g.blocked).toBe(false);
  });
});
