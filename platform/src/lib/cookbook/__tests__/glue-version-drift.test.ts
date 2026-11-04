// 序 53 —— cookbook 内联的 Glue 版本事实 vs 平台真源(lib/sync/glue-version.ts)的漂移守卫。
//   cookbook 是「零 @/ alias」的 core 包(随 genbi 容器 core-dist 分发),不能 import 真源 ⇒ 内联一份;
//   本单测同时 import 两边 toEqual 比对:真源加了新 Glue 版本 / 换了缺省,这里没跟就红(与 param-advisor core 的做法同一个范式)。
import { describe, it, expect } from "vitest";
import { COOKBOOK_GLUE_VERSIONS, COOKBOOK_GLUE_VERSION_DEFAULT, COOKBOOK_GLUE_DEFAULT_RUNTIME, GLUE_DIALECT_RULES, GLUE_RECIPES } from "../seed/glue";
import { GLUE_VERSIONS, GLUE_VERSION_DEFAULT, GLUE_RUNTIME_FACTS } from "@/lib/sync/glue-version";

describe("序 53 cookbook 内联 Glue 版本事实 vs 真源", () => {
  it("清单逐项一致", () => {
    expect(COOKBOOK_GLUE_VERSIONS).toEqual([...GLUE_VERSIONS]);
  });
  it("缺省一致(缺省 = 最高)", () => {
    expect(COOKBOOK_GLUE_VERSION_DEFAULT).toBe(GLUE_VERSION_DEFAULT);
  });
  it("缺省版本的 Spark / Python / Iceberg 一致", () => {
    const f = GLUE_RUNTIME_FACTS[GLUE_VERSION_DEFAULT];
    expect(COOKBOOK_GLUE_DEFAULT_RUNTIME).toEqual({ spark: f.spark, python: f.python, iceberg: f.iceberg });
  });
  it("版本规则文案把缺省版本、可选清单、6.0 的 ANSI 迁移点都说出来;配方里不再有写死「GlueVersion=5.1」", () => {
    const rule = GLUE_DIALECT_RULES.find((r) => r.id === "glue.version-policy");
    expect(rule).toBeDefined();
    expect(rule!.rule).toContain(`Glue ${GLUE_VERSION_DEFAULT}`);
    expect(rule!.rule).toContain(GLUE_VERSIONS.join(" / "));
    expect(rule!.rule).toMatch(/ANSI/);
    expect(GLUE_DIALECT_RULES.some((r) => r.id === "glue.version-5")).toBe(false);
    const all = JSON.stringify([...GLUE_RECIPES, ...GLUE_DIALECT_RULES]);
    expect(all).not.toMatch(/GlueVersion=5\.1/);
    expect(all).not.toMatch(/GlueVersion显式5\.1/);
  });
});
