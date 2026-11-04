// 模块 32-CR — connector-modules 单测(CR.1)。
//
// 锁死 DESIGN §2.1 注册表映射:SQL token → 模块 id 集合。
// 🔴 用【平台真实 SQL 样板】(flink-service.ts 的 defaultFlinkSql/s3TableSinkSql 等)验证,
//    而非臆造 SQL —— 防实现与真实模板脱节(样板变了单测就该红)。

import { describe, it, expect } from "vitest";
import { resolveModules } from "../connector-modules";
import {
  defaultFlinkSql,   // Kinesis 源 → filesystem sink(json)
  mysqlSinkSql,      // Kinesis 源 → jdbc sink(json)
  s3TableSinkSql,    // Kinesis 源 → iceberg/s3tables sink(json)
  customSinkSql,     // Kinesis 源 → opensearch(自定义)sink(json)
} from "../flink-service";

describe("resolveModules — 真实样板 token→模块映射(DESIGN §2.1)", () => {
  it("defaultFlinkSql:kinesis 源 + filesystem sink + json → [files, json, kinesis]", () => {
    // 稳定排序后升序:files < json < kinesis
    expect(resolveModules(defaultFlinkSql())).toEqual(["files", "json", "kinesis"]);
  });

  it("mysqlSinkSql:kinesis 源 + jdbc sink + json → [jdbc, json, kinesis]", () => {
    expect(resolveModules(mysqlSinkSql())).toEqual(["jdbc", "json", "kinesis"]);
  });

  it("s3TableSinkSql:kinesis 源 + iceberg/s3tables + json → [iceberg-s3tables, json, kinesis]", () => {
    expect(resolveModules(s3TableSinkSql())).toEqual(["iceberg-s3tables", "json", "kinesis"]);
  });

  it("customSinkSql:kinesis 源 + json(opensearch 连接器为用户上传,不在内置注册表)→ [json, kinesis]", () => {
    // opensearch-2 是用户上传连接器(connectorIds 路径),不在内置模块注册表 —— 严格:只解析内置 token。
    expect(resolveModules(customSinkSql())).toEqual(["json", "kinesis"]);
  });
});

describe("resolveModules — MSK/Kafka token(DESIGN §2.1 条件依赖)", () => {
  const kafkaBase = `CREATE TABLE src (a INT) WITH (
    'connector' = 'kafka',
    'topic' = 'orders',
    'format' = 'json'
  );
  INSERT INTO sink SELECT a FROM src;`;

  it("kafka 源(非 IAM)→ [json, kafka](不追加 msk-iam-auth)", () => {
    expect(resolveModules(kafkaBase)).toEqual(["json", "kafka"]);
  });

  it("kafka 源 + AWS_MSK_IAM → 追加 msk-iam-auth → [json, kafka, msk-iam-auth]", () => {
    const iamSql = kafkaBase.replace(
      "'format' = 'json'",
      "'format' = 'json', 'properties.sasl.mechanism' = 'AWS_MSK_IAM'",
    );
    expect(resolveModules(iamSql)).toEqual(["json", "kafka", "msk-iam-auth"]);
  });

  it("kafka + SCRAM(无 AWS_MSK_IAM)→ 不追加 msk-iam-auth", () => {
    const scramSql = kafkaBase.replace(
      "'format' = 'json'",
      "'format' = 'json', 'properties.sasl.mechanism' = 'SCRAM-SHA-512'",
    );
    expect(resolveModules(scramSql)).toEqual(["json", "kafka"]);
  });

  it("kafka → S3Tables(Kafka→S3Tables 最典型组合)→ [iceberg-s3tables, json, kafka]", () => {
    const kafka2s3t = `CREATE TABLE src (a INT) WITH ('connector'='kafka','topic'='t','format'='json');
    CREATE CATALOG s3t WITH ('type'='iceberg','catalog-impl'='software.amazon.s3tables.iceberg.S3TablesCatalog','warehouse'='arn');
    INSERT INTO s3t.db.tbl SELECT a FROM src;`;
    expect(resolveModules(kafka2s3t)).toEqual(["iceberg-s3tables", "json", "kafka"]);
  });
});

describe("resolveModules — 纯函数性质与边界", () => {
  it("确定性 + 稳定排序:同输入多次调用完全相等(供 CR.3 内容哈希)", () => {
    const sql = s3TableSinkSql();
    const r1 = resolveModules(sql);
    const r2 = resolveModules(sql);
    expect(r1).toEqual(r2);
    // 升序不变量:结果必须是已排序的(CR.3 哈希依赖此)。
    expect([...r1].sort()).toEqual(r1);
  });

  it("去重:同一 connector 出现多次只算一个模块", () => {
    const twoKinesis = `CREATE TABLE a (x INT) WITH ('connector'='kinesis','format'='json');
    CREATE TABLE b (y INT) WITH ('connector'='kinesis','format'='json');
    INSERT INTO b SELECT x FROM a;`;
    expect(resolveModules(twoKinesis)).toEqual(["json", "kinesis"]);
  });

  it("空/无已知 connector → 空数组(不抛)", () => {
    expect(resolveModules("")).toEqual([]);
    expect(resolveModules("SELECT 1")).toEqual([]);
    expect(resolveModules(null as any)).toEqual([]);
    expect(resolveModules(undefined as any)).toEqual([]);
  });

  it("多源 join(kinesis + kafka)→ 两源模块都在", () => {
    const multi = `CREATE TABLE k (a INT) WITH ('connector'='kinesis','format'='json');
    CREATE TABLE f (b INT) WITH ('connector'='kafka','topic'='t','format'='json');
    INSERT INTO sink SELECT a FROM k JOIN f ON k.a=f.b;`;
    expect(resolveModules(multi)).toEqual(["json", "kafka", "kinesis"]);
  });
});
