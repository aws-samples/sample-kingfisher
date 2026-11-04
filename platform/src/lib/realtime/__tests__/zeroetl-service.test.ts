import { describe, it, expect } from "vitest";
import { zeroEtlNames, buildZeroEtlDataFilter } from "../zeroetl-service";

// 模块 31 (Zero-ETL) — 纯函数单测(命名派生 + data-filter 构造)。
describe("zeroetl-service 纯函数", () => {
  it("zeroEtlNames:由 taskId 稳定派生集成名 + 目标库名(合规且确定)", () => {
    const n = zeroEtlNames("01KVZN9V291WK3DMXFT73CPFCZ");
    expect(n.integrationName).toMatch(/^bgp-zeroetl-[a-z0-9]{1,12}$/);
    expect(n.destDb).toMatch(/^zeroetl_[a-z0-9]{1,12}$/);
    // 同 taskId 必须稳定(幂等命名,可追溯)。
    expect(zeroEtlNames("01KVZN9V291WK3DMXFT73CPFCZ")).toEqual(n);
    // 不同 taskId 不冲突。
    expect(zeroEtlNames("01AAAAAAAAAAAAAAAAAAAAAAAA").destDb).not.toBe(n.destDb);
  });

  it("buildZeroEtlDataFilter:有表→include 列表(逗号分隔);无表→整库 *", () => {
    expect(buildZeroEtlDataFilter("ecommerce", ["products"])).toBe("include: ecommerce.products");
    expect(buildZeroEtlDataFilter("ecommerce", ["products", "orders"])).toBe(
      "include: ecommerce.products, ecommerce.orders"
    );
    expect(buildZeroEtlDataFilter("ecommerce", [])).toBe("include: ecommerce.*");
  });
});
