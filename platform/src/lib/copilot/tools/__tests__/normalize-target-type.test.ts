import { describe, it, expect } from "vitest";
import { normalizeTargetType } from "../create-service";

// 防腐层单测:planner 领域词汇(warehouse/lake)↔ 同步 targetType(s3-tables/redshift/both)。
// 回归锚点——修复 warehouse bug(计划中心"确认这步"报「非法 targetType「warehouse」」)后,
// 钉住"归一化"这条不变式,防未来有人改词表把它改漂移。
describe("normalizeTargetType(防腐层:planner 词汇 → 合法 targetType)", () => {
  it("planner 数仓词汇 → redshift", () => {
    expect(normalizeTargetType("warehouse")).toBe("redshift");
    expect(normalizeTargetType("data-warehouse")).toBe("redshift");
    expect(normalizeTargetType("dwh")).toBe("redshift");
    expect(normalizeTargetType("redshift")).toBe("redshift");
  });

  it("planner 数据湖词汇 → s3-tables", () => {
    expect(normalizeTargetType("lake")).toBe("s3-tables");
    expect(normalizeTargetType("data-lake")).toBe("s3-tables");
    expect(normalizeTargetType("datalake")).toBe("s3-tables");
    expect(normalizeTargetType("s3")).toBe("s3-tables");
    expect(normalizeTargetType("iceberg")).toBe("s3-tables");
    expect(normalizeTargetType("s3-tables")).toBe("s3-tables");
  });

  it("both/all → both", () => {
    expect(normalizeTargetType("both")).toBe("both");
    expect(normalizeTargetType("all")).toBe("both");
  });

  it("大小写/首尾空白无关(LLM 产出常带这些)", () => {
    expect(normalizeTargetType("Warehouse")).toBe("redshift");
    expect(normalizeTargetType(" WAREHOUSE ")).toBe("redshift");
    expect(normalizeTargetType("Lake")).toBe("s3-tables");
  });

  it("空值 → undefined(交由上层默认 redshift 兜底,不误当非法)", () => {
    expect(normalizeTargetType(undefined)).toBeUndefined();
    expect(normalizeTargetType(null)).toBeUndefined();
    expect(normalizeTargetType("")).toBeUndefined();
  });

  it("无法识别的词原样返回(交由上层 VALID_TARGET_TYPES 校验拒绝,不静默吞)", () => {
    // 归一化只收编【已知】的 planner 同义词;真正的乱值仍应被校验挡下,不能被静默映射掉。
    expect(normalizeTargetType("banana")).toBe("banana");
  });
});
