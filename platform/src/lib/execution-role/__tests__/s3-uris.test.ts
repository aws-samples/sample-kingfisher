// 序 72 B-139 / B-140 —— 作业实际引用的 S3 URI(纯函数)+ 平台依赖按落点换桶。
import { describe, it, expect } from "vitest";
import { parseS3Uri, splitS3UriList, s3UrisFromGlueConfig, s3UrisFromScript, localizePlatformDepUri, localizePlatformDepUris, PLATFORM_DEP_KEY_PREFIX } from "../s3-uris";

describe("序 72 s3-uris", () => {
  it("parseS3Uri:s3:// 与 s3a:// 都认并归一;桶名非法 / 没 key / 非 S3 ⇒ null", () => {
    expect(parseS3Uri("s3://bigdata-pro-va-glue-assets/scripts/glue_sql_runner.zip")).toEqual({
      bucket: "bigdata-pro-va-glue-assets", key: "scripts/glue_sql_runner.zip", uri: "s3://bigdata-pro-va-glue-assets/scripts/glue_sql_runner.zip",
    });
    expect(parseS3Uri("s3a://b-1/k")?.uri).toBe("s3://b-1/k");
    expect(parseS3Uri("s3://a/k"), "桶名至少 3 字符").toBeNull();
    expect(parseS3Uri("s3://Bad_Bucket/k")).toBeNull();
    expect(parseS3Uri("s3://bucket-only")).toBeNull();
    expect(parseS3Uri("https://x/y")).toBeNull();
    expect(parseS3Uri(undefined)).toBeNull();
  });

  it("splitS3UriList / s3UrisFromGlueConfig:逗号拆分去空白去重;形态不对的项原样留下(让预检去拒,不吞)", () => {
    expect(splitS3UriList(" s3://aaa/x.jar, ,s3://aaa/y.jar ")).toEqual(["s3://aaa/x.jar", "s3://aaa/y.jar"]);
    expect(splitS3UriList(null)).toEqual([]);
    expect(s3UrisFromGlueConfig({ extraJars: "s3a://aaa/x.jar,s3://aaa/x.jar", extraPyFiles: "s3://bbb/p.whl, nope" }))
      .toEqual(["s3://aaa/x.jar", "s3://bbb/p.whl", "nope"]);
    expect(s3UrisFromGlueConfig(undefined)).toEqual([]);
  });

  it("s3UrisFromScript:只认静态字面;模板 / 占位符跳过;去重", () => {
    const code = [
      'df = spark.read.parquet("s3://cust-data/raw/orders/")',
      "df.write.parquet('s3a://cust-data/raw/orders/')",
      'x = f"s3://cust-data/{date}/part"',
      "y = 's3://cust-data/${env}/part'",
      "# s3://cust-data/raw/orders/ again",
    ].join("\n");
    expect(s3UrisFromScript(code)).toEqual(["s3://cust-data/raw/orders/"]);
    expect(s3UrisFromScript("")).toEqual([]);
    expect(s3UrisFromScript(undefined)).toEqual([]);
  });

  it("B-140 localizePlatformDepUri:平台脚本桶(命名 SSOT 形态)下 glue-deps/ 的对象换成落点的脚本桶;客户桶 / 其它 key / 同桶一字不动", () => {
    const landing = { scriptsBucket: "bgp-glue-scripts-123456789012-tgt-usw2-a" };
    expect(localizePlatformDepUri(`s3://bgp-glue-scripts-123456789012/${PLATFORM_DEP_KEY_PREFIX}J1/utils.py`, landing))
      .toBe(`s3://bgp-glue-scripts-123456789012-tgt-usw2-a/${PLATFORM_DEP_KEY_PREFIX}J1/utils.py`);
    expect(localizePlatformDepUri(`s3://bgp-glue-scripts-123456789012-tgt-use1-a/${PLATFORM_DEP_KEY_PREFIX}J1/utils.py`, landing))
      .toBe(`s3://bgp-glue-scripts-123456789012-tgt-usw2-a/${PLATFORM_DEP_KEY_PREFIX}J1/utils.py`);
    // 同桶不动
    expect(localizePlatformDepUri(`s3://bgp-glue-scripts-123456789012-tgt-usw2-a/${PLATFORM_DEP_KEY_PREFIX}J1/utils.py`, landing))
      .toBe(`s3://bgp-glue-scripts-123456789012-tgt-usw2-a/${PLATFORM_DEP_KEY_PREFIX}J1/utils.py`);
    // 客户自己的桶:哪怕 key 像平台的也不动
    expect(localizePlatformDepUri(`s3://bigdata-pro-va-glue-assets/${PLATFORM_DEP_KEY_PREFIX}J1/utils.py`, landing))
      .toBe(`s3://bigdata-pro-va-glue-assets/${PLATFORM_DEP_KEY_PREFIX}J1/utils.py`);
    // 平台桶但不是依赖前缀(脚本本体)不动
    expect(localizePlatformDepUri("s3://bgp-glue-scripts-123456789012/glue-scripts/etl/J1.py", landing))
      .toBe("s3://bgp-glue-scripts-123456789012/glue-scripts/etl/J1.py");
    // 名字像平台桶但多了别的后缀形态(不是命名 SSOT 的 slug 文法)也不动
    expect(localizePlatformDepUri(`s3://bgp-glue-scripts-12345/${PLATFORM_DEP_KEY_PREFIX}J1/a.py`, landing))
      .toBe(`s3://bgp-glue-scripts-12345/${PLATFORM_DEP_KEY_PREFIX}J1/a.py`);
    expect(localizePlatformDepUris(`s3://bgp-glue-scripts-123456789012/${PLATFORM_DEP_KEY_PREFIX}J1/a.py, s3://cust/x.jar`, landing))
      .toBe(`s3://bgp-glue-scripts-123456789012-tgt-usw2-a/${PLATFORM_DEP_KEY_PREFIX}J1/a.py,s3://cust/x.jar`);
    expect(localizePlatformDepUris(undefined, landing)).toBeUndefined();
    expect(localizePlatformDepUris("", landing)).toBe("");
  });
});
