// 序 38 B-69 / 序 53 —— Glue 版本守卫:单元判据 + 接线判据(新建 / 保存两条路由都在**调用位置**接上了,不是只 import;
//   序 53 起再钉:缺省 == 清单最高、全仓不许再写死「5.1」缺省、离线计算 / 发现作业 / 参数顾问 / 提示词都读同一个作者)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GLUE_VERSIONS, GLUE_VERSION_DEFAULT, S3_TABLES_MIN_GLUE_VERSION, GLUE_RUNTIME_FACTS,
  glueVersionSupportsS3Tables, validateSyncGlueVersion, syncWritesS3TablesViaGlue,
  compareGlueVersions, isGlueVersion, glueVersionLabel, glueRuntimeSummary, assertGlueVersion,
  GLUE_VERSION_FOR_UNVERSIONED_RECORDS, glueVersionOfRecord, glueVersionNeedsSpark4Compat, syncCompatSparkConf, GLUE_SYNC_SPARK4_COMPAT_CONF,
} from "@/lib/sync/glue-version";

const SRC = join(__dirname, "..", "..", "..");

describe("B-69 / 序 53 版本判定", () => {
  it("缺省值在闭合清单里,且本身支持 S3 Tables;写 S3 Tables 的最低版本仍是 5.1", () => {
    expect((GLUE_VERSIONS as readonly string[]).includes(GLUE_VERSION_DEFAULT)).toBe(true);
    expect(glueVersionSupportsS3Tables(GLUE_VERSION_DEFAULT)).toBe(true);
    expect(S3_TABLES_MIN_GLUE_VERSION).toBe("5.1");
  });
  it("🔴 序 53:缺省 == 清单里的最高版本(用户 2026-10-26 拍板「缺省最高、允许降版」),清单按升序排", () => {
    const sorted = [...GLUE_VERSIONS].sort(compareGlueVersions);
    expect(sorted).toEqual([...GLUE_VERSIONS]);
    expect(GLUE_VERSION_DEFAULT).toBe(sorted[sorted.length - 1]);
    expect(GLUE_VERSIONS).toContain("6.0");
  });
  it("每个清单版本都有运行时事实(Spark / Python / Iceberg 非空);6.0 带迁移说明;下拉文案与提示词摘要带这些事实", () => {
    for (const v of GLUE_VERSIONS) {
      const f = GLUE_RUNTIME_FACTS[v];
      expect(f.spark, v).toMatch(/^\d+\.\d+\.\d+$/);
      expect(f.python, v).toMatch(/^\d+\.\d+$/);
      expect(f.iceberg, v).toMatch(/^\d+\.\d+\.\d+$/);
      expect(glueVersionLabel(v)).toBe(`Glue ${v}(Spark ${f.spark} / Python ${f.python})`);
    }
    expect(GLUE_RUNTIME_FACTS["6.0"].migrationNotes).toMatch(/ANSI/);
    expect(GLUE_RUNTIME_FACTS["6.0"].spark).toBe("4.1.1");
    expect(glueRuntimeSummary()).toBe(`AWS Glue ${GLUE_VERSION_DEFAULT}(Spark 4.1.1 / Python 3.13 / Iceberg 1.11.0)`);
    expect(glueVersionLabel("9.9")).toBe("Glue 9.9");
  });
  it("compareGlueVersions:按主.次比较;乱值排最前", () => {
    expect(compareGlueVersions("5.1", "6.0")).toBeLessThan(0);
    expect(compareGlueVersions("6.0", "5.1")).toBeGreaterThan(0);
    expect(compareGlueVersions("5.1", "5.1")).toBe(0);
    expect(compareGlueVersions("10.0", "6.0")).toBeGreaterThan(0);
    expect(compareGlueVersions("abc", "4.0")).toBeLessThan(0);
    expect(compareGlueVersions("abc", "")).toBe(0);
  });
  it("5.1 / 5.2 / 6.0 支持 S3 Tables;5.0 / 4.0 / 3.0 / 乱值不支持", () => {
    for (const v of ["5.1", "5.2", "6.0", "10.0"]) expect(glueVersionSupportsS3Tables(v), v).toBe(true);
    for (const v of ["5.0", "4.0", "3.0", "", "abc", "5", "5.", "5.1.0"]) expect(glueVersionSupportsS3Tables(v), v).toBe(false);
  });
  it("assertGlueVersion:不填 ⇒ 缺省;清单内原样;清单外 / 类型不对 ⇒ 抛且说明带清单与缺省", () => {
    expect(assertGlueVersion(undefined)).toBe(GLUE_VERSION_DEFAULT);
    expect(assertGlueVersion("")).toBe(GLUE_VERSION_DEFAULT);
    expect(assertGlueVersion("5.0")).toBe("5.0");
    expect(() => assertGlueVersion("3.0")).toThrow(/不合法.*4\.0 \/ 5\.0 \/ 5\.1 \/ 6\.0.*缺省 6\.0/);
    expect(() => assertGlueVersion(5.1)).toThrow(/不合法/);
    expect(isGlueVersion("6.0")).toBe(true);
    expect(isGlueVersion(6)).toBe(false);
  });
  it("🔴 序 53:存量记录没存版本 ⇒ 按它被写下时的缺省 5.1(不是新缺省 6.0);存了就用;清单外抛 —— 升级不改任何已有任务 / 作业的 Glue 版本", () => {
    expect(GLUE_VERSION_FOR_UNVERSIONED_RECORDS).toBe("5.1");
    expect(GLUE_VERSION_FOR_UNVERSIONED_RECORDS).not.toBe(GLUE_VERSION_DEFAULT);
    expect(glueVersionOfRecord(undefined)).toBe("5.1");
    expect(glueVersionOfRecord("")).toBe("5.1");
    expect(glueVersionOfRecord("6.0")).toBe("6.0");
    expect(glueVersionOfRecord("4.0")).toBe("4.0");
    expect(() => glueVersionOfRecord("3.0")).toThrow(/不合法/);
  });
  it("🔴 序 53:Glue ≥ 6.0 的同步作业带 Spark 4 兼容开关(ANSI 关 + 六个 JDBC legacy 映射开关),< 6.0 为空(作业定义逐字节不变)", () => {
    expect(glueVersionNeedsSpark4Compat("6.0")).toBe(true);
    expect(glueVersionNeedsSpark4Compat("7.0")).toBe(true);
    expect(glueVersionNeedsSpark4Compat("5.1")).toBe(false);
    expect(syncCompatSparkConf("5.1")).toEqual([]);
    expect(syncCompatSparkConf("4.0")).toEqual([]);
    expect(syncCompatSparkConf("6.0")).toEqual([...GLUE_SYNC_SPARK4_COMPAT_CONF]);
    expect(GLUE_SYNC_SPARK4_COMPAT_CONF).toEqual([
      "spark.sql.ansi.enabled=false",
      "spark.sql.legacy.mysql.bitArrayMapping.enabled=true",
      "spark.sql.legacy.mysql.timestampNTZMapping.enabled=true",
      "spark.sql.legacy.postgres.datetimeMapping.enabled=true",
      "spark.sql.legacy.oracle.timestampMapping.enabled=true",
      "spark.sql.legacy.mssqlserver.numericMapping.enabled=true",
      "spark.sql.legacy.mssqlserver.datetimeoffsetMapping.enabled=true",
    ]);
    for (const kv of GLUE_SYNC_SPARK4_COMPAT_CONF) expect(kv).toMatch(/^spark\.sql\.[a-zA-Z.]+=(true|false)$/);
  });
  it("写 S3 Tables 的判定:s3-tables / both 为真;redshift 为假;实时 / dms / zero-etl 通道为假", () => {
    expect(syncWritesS3TablesViaGlue({ targetType: "s3-tables" })).toBe(true);
    expect(syncWritesS3TablesViaGlue({ targetType: "both", channel: "glue" })).toBe(true);
    expect(syncWritesS3TablesViaGlue({ targetType: "redshift" })).toBe(false);
    expect(syncWritesS3TablesViaGlue({ targetType: "s3-tables", syncMode: "realtime" })).toBe(false);
    expect(syncWritesS3TablesViaGlue({ targetType: "s3-tables", channel: "dms" })).toBe(false);
    expect(syncWritesS3TablesViaGlue({ targetType: "s3-tables", channel: "zero-etl" })).toBe(false);
  });
});

describe("B-69 validateSyncGlueVersion", () => {
  it("不带 glueConfig / 不带 glueVersion / 空串 ⇒ null(缺省合法)", () => {
    expect(validateSyncGlueVersion({ targetType: "s3-tables" })).toBeNull();
    expect(validateSyncGlueVersion({ targetType: "s3-tables", glueConfig: {} })).toBeNull();
    expect(validateSyncGlueVersion({ targetType: "s3-tables", glueConfig: { glueVersion: "" } })).toBeNull();
  });
  it("s3-tables + 5.0 ⇒ 拒,说明含 5.1 与 Invalid S3 URI 的提示;both 同样;redshift + 5.0 放行;s3-tables + 6.0 放行", () => {
    const m = validateSyncGlueVersion({ targetType: "s3-tables", glueConfig: { glueVersion: "5.0" } });
    expect(m).toContain("5.1");
    expect(m).toContain("Invalid S3 URI");
    expect(validateSyncGlueVersion({ targetType: "both", glueConfig: { glueVersion: "4.0" } })).toContain("5.1");
    expect(validateSyncGlueVersion({ targetType: "redshift", glueConfig: { glueVersion: "5.0" } })).toBeNull();
    expect(validateSyncGlueVersion({ targetType: "s3-tables", glueConfig: { glueVersion: "6.0" } })).toBeNull();
  });
  it("不在闭合清单里的值 ⇒ 拒(含类型不对)", () => {
    expect(validateSyncGlueVersion({ targetType: "redshift", glueConfig: { glueVersion: "7.3" } })).toContain("不合法");
    expect(validateSyncGlueVersion({ targetType: "redshift", glueConfig: { glueVersion: 5.1 } })).toContain("不合法");
  });
});

/** 剥 TS 整行注释与 import 行(本仓红线:接线判据要看调用位置,不许被 import 行放行)。 */
function callSitesOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !/^\s*import\b/.test(l))
    .join("\n");
}
const read = (...rel: string[]) => callSitesOnly(readFileSync(join(SRC, ...rel), "utf8"));

describe("B-69 接线:新建(POST)与保存(PUT)路由都在调用位置接上了 validateSyncGlueVersion,且启动核心用的是同一份常量", () => {
  it("POST /api/sync", () => {
    const code = read("app", "api", "sync", "route.ts");
    expect((code.match(/validateSyncGlueVersion\(/g) || []).length).toBe(1);
    expect(code).toContain("glueVersionReject");
  });
  it("PUT /api/sync/[id](按 merged 判)", () => {
    const code = read("app", "api", "sync", "[id]", "route.ts");
    expect((code.match(/validateSyncGlueVersion\(merged\)/g) || []).length).toBe(1);
  });
  it("start-run.ts 不写死版本字面量作缺省:记录版本经 glueVersionOfRecord(存量无版本 ⇒ 5.1)、6.0 兼容 --conf 经 syncCompatSparkConf,写 S3 Tables 时 fail-closed", () => {
    const code = read("lib", "sync", "start-run.ts");
    expect(code).toContain("glueVersionOfRecord(gcfg.glueVersion)");
    expect(code).toContain("...syncCompatSparkConf(glueVersion)");
    expect(code).not.toContain("GLUE_VERSION_DEFAULT");
    expect(code).not.toMatch(/glueVersion \|\| "\d\.\d"/);
    expect(code).toContain("glueVersionSupportsS3Tables(glueVersion)");
  });
  it("同步向导的版本下拉取同一份清单 + 带 Spark / Python 的文案(不再手写清单)", () => {
    const code = read("app", "sync", "SyncTaskModal.tsx");
    expect(code).toContain("GLUE_VERSIONS.map(");
    expect(code).toContain("glueVersionLabel(x)");
    expect(code).toContain("initialValue={GLUE_VERSION_DEFAULT}");
    expect(code).not.toMatch(/\["4\.0", "5\.0", "5\.1"/);
    // 序 53:编辑存量任务回填时,没版本的补成 5.1(不让 initialValue 6.0 顶上去)
    expect(code).toContain("withRecordGlueVersion(editing)");
    expect(code).toContain("glueVersion: GLUE_VERSION_FOR_UNVERSIONED_RECORDS");
  });
});

describe("🔴 序 53 接线:离线计算 / 发现作业 / 参数顾问 / 提示词 / 诊断证据都从单一作者取版本,全仓不再写死「5.1」缺省", () => {
  it("离线计算页:表单缺省 + 下拉清单都取单一作者", () => {
    const code = read("app", "etl-jobs", "page.tsx");
    expect(code).toContain("glueVersion: GLUE_VERSION_DEFAULT");
    expect(code).toContain("GLUE_VERSIONS.map(");
    expect(code).toContain("glueVersionLabel(x)");
    expect(code).not.toMatch(/\["4\.0", "5\.0", "5\.1"/);
    expect(code).not.toMatch(/glueVersion \|\| "5\.1"/);
  });
  it("离线作业定义:GlueVersion 经 glueVersionOfRecord(存量无版本 ⇒ 5.1、清单外当场拒);离线计算页选中存量作业时无版本的回填 5.1", () => {
    const code = read("lib", "etl", "job-service.ts");
    expect(code).toContain("GlueVersion: glueVersionOfRecord(cfg.glueVersion)");
    expect(code).not.toMatch(/glueVersion \|\| "5\.1"/);
    const page = read("app", "etl-jobs", "page.tsx");
    expect(page).toContain("glueVersion: j.glueConfig?.glueVersion || GLUE_VERSION_FOR_UNVERSIONED_RECORDS");
  });
  it("数据源发现作业:版本 = GLUE_VERSION_DEFAULT", () => {
    const code = read("lib", "datasource", "glue-reach.ts");
    expect(code).toMatch(/GLUE_DISCOVERY_JOB = \{ glueVersion: GLUE_VERSION_DEFAULT/);
  });
  it("参数顾问启发式:推荐值与 prefill 回落都取 GLUE_VERSION_DEFAULT", () => {
    const code = read("lib", "param-advisor", "heuristics.ts");
    expect(code).toContain('key: "glueConfig.glueVersion", value: GLUE_VERSION_DEFAULT');
    expect(code).toContain('glueVersion: String(val("glueConfig.glueVersion") ?? GLUE_VERSION_DEFAULT)');
    expect(code).not.toContain('value: "5.1"');
  });
  it("需求代码生成提示词与诊断证据:运行环境句子来自 glueRuntimeSummary(),不再手写「Glue 5.1」", () => {
    const codegen = read("lib", "requirements", "codegen.ts");
    expect(codegen).toContain("glueRuntimeSummary()");
    expect(codegen).not.toContain("AWS Glue 5.1");
    const evidence = read("lib", "diagnostics", "evidence.ts");
    expect(evidence).toContain("glueRuntimeSummary()");
    expect(evidence).toContain("JobRun?.GlueVersion");
    expect(evidence).not.toContain("Glue 5.1 PySpark");
  });
  it("全仓产品代码(含 infra 构建)不再有「5.1」作 Glue 版本缺省的写法", () => {
    // 只扫产品 .ts/.tsx(排除测试与本单测);允许 S3_TABLES_MIN_GLUE_VERSION = "5.1" 与清单里的 "5.1" 枚举项。
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name === "__tests__" || name === "node_modules") continue;
          walk(full);
        } else if (/\.(ts|tsx)$/.test(name)) {
          const code = callSitesOnly(readFileSync(full, "utf8"));
          if (/(glueVersion|GlueVersion)[^\n]*\|\|\s*"5\.1"/.test(code) || /\?\?\s*"5\.1"/.test(code) || /platformDefault: "5\.1"/.test(code)) hits.push(full);
        }
      }
    };
    walk(join(SRC, "lib"));
    walk(join(SRC, "app"));
    expect(hits).toEqual([]);
  });
});
