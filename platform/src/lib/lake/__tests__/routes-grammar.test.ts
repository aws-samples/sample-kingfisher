// 数据湖表桶路由的文法与派生(纯函数;页面与服务端共用这一份)—— 钉事实:闭合清单、正则边界、别名派生的确定性与冲突后缀。
import { describe, it, expect } from "vitest";
import {
  LAKE_ALIAS_RE, LAKE_ALIAS_MAX_LEN, PLATFORM_ROUTE_ALIAS, LAKE_RESERVED_ALIASES, LAKE_TIERS, LAKE_TIER_DEFAULT, LAKE_TIER_LABELS_ZH, LAKE_ACCESS_MODES,
  TABLE_BUCKET_NAME_RE, GLUE_LAKE_CATALOGS_ARG, EMR_LAKE_CATALOGS_CONF, LAKE_NAMESPACE_RE,
  isLakeTier, isLakeAccessMode, aliasProblem, aliasFromBucket, threePartNameExample,
} from "../routes-grammar";

describe("闭合清单与常量", () => {
  it("分层六值 + 缺省 other,每个分层都有中文标签;访问方式只有 read / write", () => {
    expect(LAKE_TIERS).toEqual(["detail", "agg", "result", "ods", "dim", "other"]);
    expect(LAKE_TIER_DEFAULT).toBe("other");
    expect(Object.keys(LAKE_TIER_LABELS_ZH).sort()).toEqual([...LAKE_TIERS].sort());
    expect(LAKE_ACCESS_MODES).toEqual(["read", "write"]);
    expect(isLakeTier("agg")).toBe(true); expect(isLakeTier("gold")).toBe(false); expect(isLakeTier(undefined)).toBe(false);
    expect(isLakeAccessMode("write")).toBe(true); expect(isLakeAccessMode("rw")).toBe(false);
  });
  it("平台路由别名固定 s3tablescatalog 且在保留名里;注入键名两引擎各一个(平台保留键)", () => {
    expect(PLATFORM_ROUTE_ALIAS).toBe("s3tablescatalog");
    expect(LAKE_RESERVED_ALIASES.has(PLATFORM_ROUTE_ALIAS)).toBe(true);
    expect(Array.from(LAKE_RESERVED_ALIASES).sort()).toEqual(["default", "glue_catalog", "s3tablescatalog", "spark_catalog"]);
    expect(GLUE_LAKE_CATALOGS_ARG).toBe("--bgp_lake_catalogs");
    expect(EMR_LAKE_CATALOGS_CONF).toBe("spark.bgp.lakeCatalogs");
  });
});

describe("别名文法", () => {
  it("小写字母开头、[a-z0-9_]、最长 32", () => {
    for (const ok of ["a", "agg", "ods_2026", "b_123", "x".repeat(32)]) expect(LAKE_ALIAS_RE.test(ok), ok).toBe(true);
    for (const bad of ["", "Agg", "1agg", "agg-1", "agg.x", "x".repeat(33), "中文"]) expect(LAKE_ALIAS_RE.test(bad), bad).toBe(false);
    expect(LAKE_ALIAS_MAX_LEN).toBe(32);
  });
  it("aliasProblem:空 / 非法 / 保留名各给一句可读说明;合法回 null;两侧空白容忍", () => {
    expect(aliasProblem("agg")).toBeNull();
    expect(aliasProblem("  agg ")).toBeNull();
    expect(aliasProblem("")).toBe("别名不能为空");
    expect(aliasProblem(undefined)).toBe("别名不能为空");
    expect(aliasProblem("Agg")).toContain("不合法");
    expect(aliasProblem("spark_catalog")).toContain("保留名");
    expect(aliasProblem("s3tablescatalog")).toContain("保留名");
  });
});

describe("表桶名 / 命名空间文法", () => {
  it("表桶名 3–63,小写字母 / 数字 / 连字符,首尾字母数字", () => {
    for (const ok of ["abc", "demo-agg-bucket", "a1-b2", "x".repeat(63)]) expect(TABLE_BUCKET_NAME_RE.test(ok), ok).toBe(true);
    for (const bad of ["ab", "-abc", "abc-", "Abc", "a_b", "a.b", "x".repeat(64)]) expect(TABLE_BUCKET_NAME_RE.test(bad), bad).toBe(false);
  });
  it("命名空间:小写字母 / 数字 / 下划线", () => {
    for (const ok of ["ods", "ods_2026", "a"]) expect(LAKE_NAMESPACE_RE.test(ok), ok).toBe(true);
    for (const bad of ["", "Ods", "ods-1", "ods.x"]) expect(LAKE_NAMESPACE_RE.test(bad), bad).toBe(false);
  });
});

describe("aliasFromBucket(按桶名派生缺省别名;确定性纯函数)", () => {
  it("小写、非 [a-z0-9_] → _、首字符非字母加前缀 b_、截到 32 位", () => {
    expect(aliasFromBucket("demo-agg-bucket")).toBe("demo_agg_bucket");
    expect(aliasFromBucket("Demo.Agg")).toBe("demo_agg");
    expect(aliasFromBucket("123-bucket")).toBe("b_123_bucket");
    expect(aliasFromBucket("-x")).toBe("b__x");
    expect(aliasFromBucket("a".repeat(70))).toBe("a".repeat(32));
    expect(aliasFromBucket("a".repeat(70))).toMatch(LAKE_ALIAS_RE);
  });
  it("与已占别名 / 保留名撞上 ⇒ 加 _2 / _3 … 后缀,截断后仍 ≤ 32 且合法", () => {
    expect(aliasFromBucket("agg", new Set(["agg"]))).toBe("agg_2");
    expect(aliasFromBucket("agg", new Set(["agg", "agg_2"]))).toBe("agg_3");
    expect(aliasFromBucket("spark-catalog")).toBe("spark_catalog_2"); // 保留名也算被占
    expect(aliasFromBucket("default")).toBe("default_2");
    const long = aliasFromBucket("a".repeat(70), new Set(["a".repeat(32)]));
    expect(long).toBe(`${"a".repeat(30)}_2`);
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long).toMatch(LAKE_ALIAS_RE);
  });
  it("同一输入永远同一输出(升级迁移脚本另有逐字相同的实现,靠这个性质对齐)", () => {
    for (const b of ["bigdata-test-sg-tables", "Agg-Bucket", "123-bucket", "ods"]) {
      expect(aliasFromBucket(b)).toBe(aliasFromBucket(b));
      expect(aliasFromBucket(b, new Set(["x"]))).toBe(aliasFromBucket(b, new Set(["x"])));
    }
  });
});

describe("threePartNameExample", () => {
  it("<别名>.<命名空间>.<表>(缺省占位)", () => {
    expect(threePartNameExample("agg")).toBe("agg.<命名空间>.<表>");
    expect(threePartNameExample("agg", "ods", "t1")).toBe("agg.ods.t1");
  });
});
