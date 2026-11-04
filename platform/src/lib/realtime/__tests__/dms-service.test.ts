import { describe, it, expect } from "vitest";
import { dmsResourceNames, tableMappings } from "../dms-service";
import { genDmsSafePassword } from "../redshift-target";

describe("dmsResourceNames", () => {
  it("derives stable DMS identifiers from a task id", () => {
    const n = dmsResourceNames("01KVTM4S3CYMKRMZ6TS39ZNX00");
    expect(n.srcId).toMatch(/^bgp-src-[a-z0-9]+$/);
    expect(n.tgtId).toMatch(/^bgp-tgt-[a-z0-9]+$/);
    expect(n.taskIdent).toMatch(/^bgp-rt-[a-z0-9]+$/);
    // 同一 taskId 稳定可复现(幂等查找依赖)
    expect(dmsResourceNames("01KVTM4S3CYMKRMZ6TS39ZNX00")).toEqual(n);
  });

  it("sanitizes to DMS-legal identifier chars (lowercase alnum + hyphen)", () => {
    const n = dmsResourceNames("Weird_ID!@#012345678");
    expect(n.srcId).toMatch(/^bgp-src-[a-z0-9]+$/);
  });
});

describe("tableMappings", () => {
  it("builds a valid selection rule for schema.table", () => {
    const m = JSON.parse(tableMappings("ecommerce", "realtime_demo"));
    expect(m.rules[0]["rule-type"]).toBe("selection");
    expect(m.rules[0]["object-locator"]).toEqual({ "schema-name": "ecommerce", "table-name": "realtime_demo" });
    expect(m.rules[0]["rule-action"]).toBe("include");
  });

  it("supports whole-schema wildcard", () => {
    const m = JSON.parse(tableMappings("ecommerce", "%"));
    expect(m.rules[0]["object-locator"]["table-name"]).toBe("%");
  });
});

describe("genDmsSafePassword", () => {
  it("never contains DMS-forbidden characters {},; (踩坑④)", () => {
    for (let i = 0; i < 50; i++) {
      const pwd = genDmsSafePassword();
      expect(pwd).not.toMatch(/[{},;]/);
      expect(pwd.length).toBeGreaterThanOrEqual(16);
    }
  });

  it("generates distinct passwords (high entropy)", () => {
    expect(genDmsSafePassword()).not.toBe(genDmsSafePassword());
  });
});
