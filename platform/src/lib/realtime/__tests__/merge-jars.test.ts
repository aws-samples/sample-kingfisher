// 模块 32-CR CR.3 — mergeJars 字节级冲突检测单测(§2.4 约束②分级)。
//
// 锁死:同名类字节相同→去重;字节不同+核心库→FAIL 抛错;字节不同+稳定门面(commons-logging)→WARN 放行;
//       META-INF/services 合并去重;base MANIFEST 优先;strict=false 保持旧行为(自定义 sink 零回归)。

import { describe, it, expect, vi } from "vitest";
import AdmZip from "adm-zip";
import { mergeJars, uberCacheKey, assembleModularUberJar } from "../flink-connectors";
import { FLINK } from "../flink-config";

/** 造一个内含指定条目的假 jar buffer。entries: {路径: 内容字符串}。 */
function makeJar(entries: Record<string, string>): Buffer {
  const z = new AdmZip();
  for (const [name, content] of Object.entries(entries)) z.addFile(name, Buffer.from(content, "utf8"));
  return z.toBuffer();
}

/** 从合并结果 buffer 读某条目的内容(断言用)。 */
function readEntry(buf: Buffer, name: string): string | null {
  const z = new AdmZip(buf);
  const e = z.getEntry(name);
  return e ? e.getData().toString("utf8") : null;
}

describe("mergeJars — 基础合并行为(与现有一致)", () => {
  it("不同路径的类全部合并;base MANIFEST 保留、add 的 MANIFEST 丢弃", () => {
    const base = makeJar({ "META-INF/MANIFEST.MF": "Main-Class: com.bgp.flink.FlinkSqlRunner", "com/a/A.class": "AAA" });
    const add = makeJar({ "META-INF/MANIFEST.MF": "Main-Class: other", "com/b/B.class": "BBB" });
    const out = mergeJars(base, [add]);
    expect(readEntry(out, "com/a/A.class")).toBe("AAA");
    expect(readEntry(out, "com/b/B.class")).toBe("BBB");
    expect(readEntry(out, "META-INF/MANIFEST.MF")).toContain("FlinkSqlRunner"); // base 优先
  });

  it("META-INF/services 合并去重(SPI 工厂拼接)", () => {
    const base = makeJar({ "META-INF/services/org.apache.flink.table.factories.Factory": "com.KinesisFactory\ncom.Shared" });
    const add = makeJar({ "META-INF/services/org.apache.flink.table.factories.Factory": "com.KafkaFactory\ncom.Shared" });
    const out = mergeJars(base, [add]);
    const svc = readEntry(out, "META-INF/services/org.apache.flink.table.factories.Factory")!;
    expect(svc).toContain("com.KinesisFactory");
    expect(svc).toContain("com.KafkaFactory");
    // Shared 只出现一次(去重)
    expect(svc.split("\n").filter((l) => l.trim() === "com.Shared").length).toBe(1);
  });

  it("丢弃签名文件与 multi-release", () => {
    const base = makeJar({ "com/a/A.class": "A" });
    const add = makeJar({ "META-INF/FOO.SF": "sig", "META-INF/versions/9/X.class": "v9", "com/c/C.class": "C" });
    const out = mergeJars(base, [add]);
    expect(readEntry(out, "META-INF/FOO.SF")).toBeNull();
    expect(readEntry(out, "META-INF/versions/9/X.class")).toBeNull();
    expect(readEntry(out, "com/c/C.class")).toBe("C");
  });
});

describe("mergeJars — §2.4 约束② 冲突检测分级(strict)", () => {
  it("同名类【字节相同】→ 静默去重(合并无害)", () => {
    const base = makeJar({ "com/shared/Same.class": "IDENTICAL_BYTES" });
    const add = makeJar({ "com/shared/Same.class": "IDENTICAL_BYTES" });
    const out = mergeJars(base, [add], { strict: true });
    expect(readEntry(out, "com/shared/Same.class")).toBe("IDENTICAL_BYTES"); // 不抛错
  });

  it("同名类【字节不同 + 核心库】→ FAIL 抛错(拒绝静默合并)", () => {
    const base = makeJar({ "com/fasterxml/jackson/databind/ObjectMapper.class": "v2.15" });
    const add = makeJar({ "com/fasterxml/jackson/databind/ObjectMapper.class": "v2.18" });
    expect(() => mergeJars(base, [add], { strict: true })).toThrow(/冲突|字节不同|版本分叉/);
  });

  it("同名类【字节不同 + 稳定门面 commons-logging】→ WARN 放行(先加入者胜)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const base = makeJar({ "org/apache/commons/logging/LogFactory.class": "impl-v1" });
    const add = makeJar({ "org/apache/commons/logging/LogFactory.class": "impl-v2" });
    const out = mergeJars(base, [add], { strict: true });
    expect(readEntry(out, "org/apache/commons/logging/LogFactory.class")).toBe("impl-v1"); // base 优先,不抛错
    expect(warnSpy).toHaveBeenCalled(); // 有 WARN
    warnSpy.mockRestore();
  });

  it("非 .class 同名文件字节不同 → 不触发冲突检测(只管类)", () => {
    const base = makeJar({ "some/resource.txt": "a" });
    const add = makeJar({ "some/resource.txt": "b" });
    expect(() => mergeJars(base, [add], { strict: true })).not.toThrow();
  });
});

describe("mergeJars — strict=false 保持旧行为(自定义 sink 零回归)", () => {
  it("字节不同的核心库同名类 → 不抛错,先加入者胜(旧语义逐字保持)", () => {
    const base = makeJar({ "com/fasterxml/jackson/databind/ObjectMapper.class": "v2.15" });
    const add = makeJar({ "com/fasterxml/jackson/databind/ObjectMapper.class": "v2.18" });
    // strict=false(自定义 sink 路径)→ 旧行为:静默先来者胜,不抛错。
    const out = mergeJars(base, [add], { strict: false });
    expect(readEntry(out, "com/fasterxml/jackson/databind/ObjectMapper.class")).toBe("v2.15");
  });
});

describe("uberCacheKey — 内容哈希缓存 key(确定性 + 顺序无关)", () => {
  it("相同(base+模块集合+用户连接器)→ 完全相同的 key(缓存命中前提)", () => {
    const k1 = uberCacheKey("flink/modules/flink-module-base.jar", ["json", "kinesis"], []);
    const k2 = uberCacheKey("flink/modules/flink-module-base.jar", ["json", "kinesis"], []);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^flink\/uber-cache\/uber-[0-9a-f]{32}\.jar$/);
  });
  it("用户连接器 keys 顺序无关(内部排序)→ 同 key", () => {
    const a = uberCacheKey("base.jar", ["kinesis"], ["flink/connectors/x.jar", "flink/connectors/y.jar"]);
    const b = uberCacheKey("base.jar", ["kinesis"], ["flink/connectors/y.jar", "flink/connectors/x.jar"]);
    expect(a).toBe(b);
  });
  it("模块集合不同 → key 不同(避免错误复用)", () => {
    const k1 = uberCacheKey("base.jar", ["json", "kinesis"], []);
    const k2 = uberCacheKey("base.jar", ["json", "kafka"], []);
    const k3 = uberCacheKey("base.jar", ["iceberg-s3tables", "json", "kinesis"], []);
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
  });
  it("base key 不同(如升级薄基础)→ key 不同(强制重建)", () => {
    const k1 = uberCacheKey("base-v1.jar", ["kinesis"], []);
    const k2 = uberCacheKey("base-v2.jar", ["kinesis"], []);
    expect(k1).not.toBe(k2);
  });
});

describe("assembleModularUberJar — §2.0 分治边界(含 iceberg 走预构建,不运行期合并)", () => {
  it("含 iceberg-s3tables 的 SQL → 返回预构建 s3t 包 key,prebuilt=true(不碰 S3 合并,规避 ZIP64)", async () => {
    // catalog-impl=S3TablesCatalog → resolveModules 命中 iceberg-s3tables → 分治返回预构建包,在碰 S3 前 return。
    const sql = `CREATE TABLE src (a INT) WITH ('connector'='kinesis','format'='json');
    CREATE CATALOG s3t WITH ('type'='iceberg','catalog-impl'='software.amazon.s3tables.iceberg.S3TablesCatalog','warehouse'='arn:x');
    INSERT INTO s3t.db.t SELECT a FROM src;`;
    const r = await assembleModularUberJar(sql, [], { region: "us-east-1", codeBucket: "cb" });
    expect(r.prebuilt).toBe(true);
    expect(r.key).toBe(FLINK.s3tableCodeKey);         // 预构建 s3t 包(ZIP64、已跑通)
    expect(r.modules).toContain("iceberg-s3tables");
    expect(r.modules).toContain("kinesis");
  });

  it("Bug#5:kafka 源 + iceberg sink → 返回【组合包】s3tKafkaCodeKey(s3t 包无 kafka connector,必须组合包)", async () => {
    // kafka connector + S3TablesCatalog 同时命中 → 短路走 kafka+iceberg 组合包(补 s3t 包缺的 KafkaDynamicTableFactory)。
    const sql = `CREATE TABLE src (a INT) WITH ('connector'='kafka','topic'='t','format'='json','properties.sasl.mechanism'='AWS_MSK_IAM');
    CREATE CATALOG s3t WITH ('type'='iceberg','catalog-impl'='software.amazon.s3tables.iceberg.S3TablesCatalog','warehouse'='arn:x');
    INSERT INTO s3t.db.t SELECT a FROM src;`;
    const r = await assembleModularUberJar(sql, [], { region: "us-east-1", codeBucket: "cb" });
    expect(r.prebuilt).toBe(true);
    expect(r.key).toBe(FLINK.s3tKafkaCodeKey);        // 🔴 组合包,不是纯 s3t 包
    expect(r.key).not.toBe(FLINK.s3tableCodeKey);
    expect(r.modules).toContain("iceberg-s3tables");
    expect(r.modules).toContain("kafka");
    expect(r.modules).toContain("msk-iam-auth");       // AWS_MSK_IAM → 追加认证模块
  });

  it("Bug#5 零回归:纯 iceberg(无 kafka,如 Kinesis/CDC→S3Tables)仍走原 s3t 包", async () => {
    // 确保新分支不误伤现有 Kinesis→S3Tables:无 kafka connector → 维持 s3tableCodeKey。
    const sql = `CREATE TABLE src (a INT) WITH ('connector'='kinesis','format'='json');
    CREATE CATALOG s3t WITH ('type'='iceberg','catalog-impl'='software.amazon.s3tables.iceberg.S3TablesCatalog','warehouse'='arn:x');
    INSERT INTO s3t.db.t SELECT a FROM src;`;
    const r = await assembleModularUberJar(sql, [], { region: "us-east-1", codeBucket: "cb" });
    expect(r.key).toBe(FLINK.s3tableCodeKey);          // 零回归:仍是原 s3t 包
    expect(r.modules).not.toContain("kafka");
  });
});
