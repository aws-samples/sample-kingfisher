// 模块 43-A — 故障指纹算法单测。黄金语料取自历史真实事故(RESUME-*/QA-FINDINGS/memory)。
// 归并的误并/漏并是本模块最容易埋雷处 → 这里把正确性锁死:
//   ① 同因归并:4 组各 2 个真实实例(仅表名/日期/账号/数字不同)→ 必须同 signature。
//   ② 异因区分:6 组易误并对照组 → 必须不同 signature(尤其跨引擎"缺驱动"两条)。
//   ③ 脱敏铁证:含表名/账号/路径/UUID 的错误串 → signature 与 symptomTemplate 都不含敏感 token。
//   ④ 兜底稳定:无错误码时归一化后仍稳定归并、不同因不并。

import { describe, it, expect } from "vitest";
import { computeSignature, normalizeErrorText, normalizeEngine } from "../signature";

const sig = (taskType: string, err: string) => computeSignature(taskType, err).signature;

// 12 位假账号(运行时拼接,源码不含 12 位连续数字字面量,避免误触 secret-scan;值仍是 12 位供脱敏测试)。
const ACC = ["1111", "2222", "3333"].join("");
const ACC2 = ["4444", "5555", "6666"].join("");

// ─────────────────────────────────────────────────────────────────────────────
// 黄金语料(节选真实原文,含可变部分:表名/日期/task id/行数,用于验证归一化)
// ─────────────────────────────────────────────────────────────────────────────

// A. Glue REQUIRES_SINGLE_PART_NAMESPACE —— 两个不同表名/日期实例
const A1 = `[REQUIRES_SINGLE_PART_NAMESPACE] The namespace in session catalog must have exactly one name part: spark_catalog.s3tablescatalog.ecommerce.dim_channel`;
const A2 = `pyspark.sql.utils.AnalysisException: [REQUIRES_SINGLE_PART_NAMESPACE] spark.table("s3tablescatalog.gamedata.fct_orders_2026-07-08") failed`;

// B. Redshift Spectrum Scan Error 15007 —— 两个不同列/表/行数实例
const B1 = `error: Spectrum Scan Error 15007 — incompatible Parquet schema for column is_paying, table players`;
const B2 = `15007 has an incompatible Parquet schema for column revenue in table gamedata.orders (99866 rows scanned in 26min)`;

// C. DMS resolving configuration FATAL —— 两个不同 task id/日期实例
const C1 = `Last Error: Failed in resolving configuration. Stop Reason FATAL_ERROR. task bgp-rt-j1h8e6srefx5 fx_rates -> Redshift 2026-07-04`;
const C2 = `Task bgp-rt-svz6ttsyazvq (2026-07-02): Failed in resolving configuration, Stop Reason FATAL_ERROR`;

// F. Redshift permission denied —— schema / database 两个对象类型实例
const F1 = `Exception: DDL failed: ERROR: permission denied for schema gamedata`;
const F2 = `CREATE SCHEMA failed: permission denied for database dev`;

describe("computeSignature — 同因归并(4 组各 2 真实实例,只表名/日期/数字不同)", () => {
  it("A. Glue REQUIRES_SINGLE_PART_NAMESPACE:两实例归并同签名", () => {
    expect(sig("etl-glue", A1)).toBe("glue::REQUIRES_SINGLE_PART_NAMESPACE");
    expect(sig("etl-glue", A2)).toBe("glue::REQUIRES_SINGLE_PART_NAMESPACE");
    expect(sig("etl-glue", A1)).toBe(sig("etl-glue", A2));
  });

  it("B. Redshift Spectrum 15007:两实例归并同签名(保留错误码 15007)", () => {
    expect(sig("etl-redshift", B1)).toBe("redshift::spectrum-scan-error#15007");
    expect(sig("etl-redshift", B2)).toBe("redshift::spectrum-scan-error#15007");
    expect(sig("etl-redshift", B1)).toBe(sig("etl-redshift", B2));
  });

  it("C. DMS resolving configuration FATAL:两实例(不同 task id/日期)归并同签名", () => {
    expect(sig("dms", C1)).toBe("dms::resolving-configuration-fatal");
    expect(sig("dms", C2)).toBe("dms::resolving-configuration-fatal");
    expect(sig("dms", C1)).toBe(sig("dms", C2));
  });

  it("F. Redshift permission denied:schema/database 两实例归并同签名", () => {
    expect(sig("etl-redshift", F1)).toBe("redshift::permission-denied");
    expect(sig("etl-redshift", F2)).toBe("redshift::permission-denied");
    expect(sig("etl-redshift", F1)).toBe(sig("etl-redshift", F2));
  });
});

describe("computeSignature — 异因区分(易误并对照组,漏并=0)", () => {
  it("1. Glue single-part-ns ↮ Redshift spectrum:跨引擎跨错误必不同", () => {
    expect(sig("etl-glue", A1)).not.toBe(sig("etl-redshift", B1));
  });

  it("2. ★EMR ClassNotFoundException ↮ Flink NoClassDefFoundError(都缺 mysql 驱动,必不同)", () => {
    const emr = `java.lang.ClassNotFoundException: com.mysql.cj.jdbc.Driver at java.net.URLClassLoader`;
    const flink = `java.lang.NoClassDefFoundError: com/mysql/cj/jdbc/Driver (flink-sql-connector-mysql-cdc)`;
    const emrSig = sig("emr-serverless", emr);
    const flinkSig = sig("flink", flink);
    expect(emrSig).toBe("emr::ClassNotFoundException");
    expect(flinkSig).toBe("flink::NoClassDefFoundError");
    expect(emrSig).not.toBe(flinkSig);
  });

  it("3. Flink 三根因两两区分(同引擎不等于同签名)", () => {
    const parseErr = `Could not execute application: SQL parse failed. Encountered "<EOF>" at line 1, column 42`;
    const serverId = `io.debezium: Error 1236 A replica with the same server_uuid/server_id as this replica has connected`;
    const checkpoint = `Checkpoint 42 expired before completing; failed checkpoint`;
    const s1 = sig("flink", parseErr);
    const s2 = sig("flink", serverId);
    const s3 = sig("flink", checkpoint);
    expect(new Set([s1, s2, s3]).size).toBe(3); // 三者互不相同
  });

  it("4. DMS 三类区分(resolving-config / LOB / start-type)", () => {
    const lob = `limited lob mode should be enabled for Redshift target and LobMaxSize should have value between 1 and 63 KB`;
    const startType = `Start Type : START_REPLICATION, valid only for tasks running for the first time`;
    const s1 = sig("dms", C1);
    const s2 = sig("dms", lob);
    const s3 = sig("dms", startType);
    expect(new Set([s1, s2, s3]).size).toBe(3);
  });

  it("5. Redshift permission-denied ↮ spectrum-scan ↮ disk-full:同引擎不同类", () => {
    const diskFull = `error: Disk Full: transaction aborted`;
    expect(new Set([sig("etl-redshift", F1), sig("etl-redshift", B1), sig("etl-redshift", diskFull)]).size).toBe(3);
  });

  it("6. Spark OOM ↮ ClassNotFound:同 EMR 引擎不同类", () => {
    const oom = `Py4JJavaError: java.lang.OutOfMemoryError: Java heap space`;
    const cnf = `java.lang.ClassNotFoundException: com.mysql.cj.jdbc.Driver`;
    expect(sig("emr-serverless", oom)).toBe("emr::OutOfMemoryError");
    expect(sig("emr-serverless", oom)).not.toBe(sig("emr-serverless", cnf));
  });
});

describe("computeSignature — 脱敏铁证(signature 与 symptomTemplate 均不含敏感 token)", () => {
  const secrets = ["dim_channel", "players", "gamedata", "fx_rates", "is_paying", "bgp-rt-j1h8e6srefx5", "2026-07-08", "99866"];

  it("规则命中路径:signature/symptomTemplate 不含任何表名/账号/日期/资源 id", () => {
    for (const err of [A1, A2, B1, B2, C1, C2, F1, F2]) {
      const r = computeSignature("etl-glue", err);
      for (const secret of secrets) {
        expect(r.signature).not.toContain(secret);
        expect(r.symptomTemplate).not.toContain(secret);
      }
    }
  });

  it("兜底归一化路径:含账号/路径/UUID 的未知错误 → 模板与签名脱敏", () => {
    const err = `Unknown failure writing to s3://bgp-lake-${ACC}/warehouse/gamedata/players/data.parquet for account ${ACC} uuid 3f2504e0-4f89-41d3-9a0c-0305e82c3301 at table dim_channel row 99866`;
    const r = computeSignature("etl-glue", err);
    // 敏感 token 全部被占位符替代
    expect(r.symptomTemplate).not.toContain(ACC);
    expect(r.symptomTemplate).not.toContain("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
    expect(r.symptomTemplate).not.toContain("bgp-lake");
    expect(r.signature).not.toContain(ACC);
    // 归一化模板应含占位符
    expect(r.symptomTemplate).toContain("<ACCOUNT>");
    expect(r.symptomTemplate).toMatch(/<S3URI>|<PATH>/);
  });
});

describe("computeSignature — 兜底归一化(无错误码也稳定归并且异因不并)", () => {
  it("同因不同表名/账号 → 兜底签名归并", () => {
    const e1 = `Weird failure at table orders account ${ACC} rows 12345`;
    const e2 = `Weird failure at table players account ${ACC2} rows 98765`;
    expect(sig("etl-glue", e1)).toBe(sig("etl-glue", e2));
    expect(computeSignature("etl-glue", e1).matchedBy).toBe("normalized");
  });

  it("不同因 → 兜底签名不并", () => {
    const e1 = `Weird failure at table orders`;
    const e2 = `Totally different connector timeout after retries`;
    expect(sig("etl-glue", e1)).not.toBe(sig("etl-glue", e2));
  });

  it("兜底签名带引擎前缀 + h- hash 形态", () => {
    expect(sig("flink", `Some novel flink-only failure xyz`)).toMatch(/^flink::h-[0-9a-f]{8}$/);
  });

  it("空错误文本 → no-error-text 桶(按引擎)", () => {
    expect(sig("etl-glue", "")).toBe("glue::no-error-text");
    expect(computeSignature("flink", null as any).signature).toBe("flink::no-error-text");
  });
});

describe("normalizeEngine — taskType 归一到引擎族", () => {
  it("细粒度 taskType 映射到粗粒度引擎族", () => {
    expect(normalizeEngine("etl-glue")).toBe("glue");
    expect(normalizeEngine("etl-redshift")).toBe("redshift");
    expect(normalizeEngine("etl-redshift-dryrun")).toBe("redshift");
    expect(normalizeEngine("emr-serverless")).toBe("emr");
    expect(normalizeEngine("flink")).toBe("flink");
    expect(normalizeEngine("sync")).toBe("sync");
    expect(normalizeEngine("workflow")).toBe("workflow");
    expect(normalizeEngine("")).toBe("unknown");
    expect(normalizeEngine(undefined)).toBe("unknown");
    expect(normalizeEngine("unknown")).toBe("unknown");
  });
});

describe("normalizeErrorText — 归一化确定性", () => {
  it("相同结构不同可变量 → 归一化后完全相同", () => {
    const a = normalizeErrorText(`table "players" account ${ACC} on 2026-07-08 rows 99866`);
    const b = normalizeErrorText(`table "orders" account ${ACC2} on 2026-07-02 rows 12345`);
    expect(a).toBe(b);
  });

  it("保留判别性错误码 token(如 REQUIRES_SINGLE_PART_NAMESPACE 全大写不被抹)", () => {
    // 全大写错误码不含数字/引号,应原样保留(它是签名主键,不能被当可变量)
    const n = normalizeErrorText(`[REQUIRES_SINGLE_PART_NAMESPACE] failed for "dim_channel"`);
    expect(n).toContain("REQUIRES_SINGLE_PART_NAMESPACE");
    expect(n).not.toContain("dim_channel");
  });
});
