import { describe, it, expect } from "vitest";
import { parseSqlLineage, tableFqn } from "../sql-lineage";

// Table-level heuristic lineage parser. Used by governance impact analysis AND by masking
// (to resolve referenced tables). Must be robust & never throw.
describe("parseSqlLineage", () => {
  it("extracts source + target + edge for a CTAS", () => {
    const r = parseSqlLineage("CREATE TABLE public.dwd_orders AS SELECT * FROM public.orders", {
      database: "dev",
    });
    expect(r.targets.map(tableFqn)).toContain("bgp-redshift.dev.public.dwd_orders");
    expect(r.sources.map(tableFqn)).toContain("bgp-redshift.dev.public.orders");
    expect(r.edges).toHaveLength(1);
    expect(tableFqn(r.edges[0].from)).toBe("bgp-redshift.dev.public.orders");
    expect(tableFqn(r.edges[0].to)).toBe("bgp-redshift.dev.public.dwd_orders");
    expect(r.statements[0].kind).toBe("ctas");
  });

  it("captures multiple sources across FROM + JOIN", () => {
    const r = parseSqlLineage(
      "INSERT INTO public.t SELECT a.* FROM public.orders a JOIN public.customers c ON a.cid=c.id"
    );
    const sources = r.sources.map((s) => s.table).sort();
    expect(sources).toEqual(["customers", "orders"]);
    expect(r.statements[0].kind).toBe("insert");
  });

  it("does NOT treat CTE names as real source tables", () => {
    const r = parseSqlLineage(
      "CREATE TABLE public.agg AS WITH c AS (SELECT * FROM public.orders) SELECT * FROM c"
    );
    const tables = r.sources.map((s) => s.table);
    expect(tables).toContain("orders");
    expect(tables).not.toContain("c"); // c is a CTE alias, not a table
  });

  it("excludes self-reference (target appearing in its own FROM, e.g. incremental MERGE-like)", () => {
    const r = parseSqlLineage("INSERT INTO public.t SELECT * FROM public.t WHERE x > 1");
    // source == target → edge suppressed
    expect(r.edges).toHaveLength(0);
  });

  it("normalizes unqualified names with provided defaults", () => {
    const r = parseSqlLineage("SELECT * FROM orders", { database: "prod", schema: "mart" });
    expect(r.sources.map(tableFqn)).toContain("bgp-redshift.prod.mart.orders");
  });

  it("handles DELETE ... USING (source comes from USING, not FROM)", () => {
    const r = parseSqlLineage("DELETE FROM public.t USING public.staging WHERE t.id=staging.id");
    expect(r.statements[0].kind).toBe("delete");
    expect(r.sources.map((s) => s.table)).toContain("staging");
  });

  it("ignores tables mentioned only inside string literals", () => {
    const r = parseSqlLineage("SELECT * FROM public.orders WHERE note = 'from public.secret'");
    const tables = r.sources.map((s) => s.table);
    expect(tables).toContain("orders");
    expect(tables).not.toContain("secret");
  });

  it("never throws and returns empty result on blank input", () => {
    expect(parseSqlLineage("")).toEqual({ targets: [], sources: [], edges: [], statements: [] });
    expect(() => parseSqlLineage("this is not ::: valid (((sql")).not.toThrow();
  });
});
