// core-guard(容器入口)与 inprocess guard 的【双跑一致性】守卫。
//
// 决策3(抽 guard-core 纯核,零漂移)的机器铁证:core-guard 直取 seed、inprocess guard 经 registry,
// 二者共用同一纯核 runGuardWithRules → 必须【同输入同输出】。本单测遍历各引擎 × 各类 SQL(含方言易错、
// 词法安全边界、正常不误改),逐字节断言两入口 .code/.fixed/.violations/.blocked 完全一致。
// 若未来有人改坏任一入口的规则来源(如 core-guard 漏某引擎、registry filter 变),本测立即红。

import { describe, it, expect } from "vitest";
import { guard as inprocessGuard } from "../guard";
import { guard as coreGuard } from "../core-guard";
import type { CookbookEngine } from "../types";

// 覆盖:方言易错(反引号/CTAS IF NOT EXISTS/CREATE OR REPLACE)+ 词法安全(字符串内 DDL)+ 正常 SQL + 空/多引擎。
const CASES: Array<{ engine: CookbookEngine; sql: string; note: string }> = [
  { engine: "redshift", sql: "SELECT `col` FROM `tbl`;", note: "反引号" },
  { engine: "redshift", sql: "CREATE TABLE IF NOT EXISTS public.t AS SELECT 1 AS a;", note: "CTAS INE" },
  { engine: "redshift", sql: "CREATE OR REPLACE TABLE public.t AS SELECT 1 AS a;", note: "CREATE OR REPLACE" },
  { engine: "redshift", sql: "DROP TABLE IF EXISTS x; CREATE TABLE x AS SELECT 1;", note: "正常不改" },
  { engine: "redshift", sql: "INSERT INTO audit_log(note) VALUES ('CREATE TABLE IF NOT EXISTS foo AS bar');", note: "字符串内DDL(词法安全)" },
  { engine: "redshift", sql: "SELECT sum(amount) FROM orders WHERE region = 'East' GROUP BY channel;", note: "常规聚合" },
  { engine: "athena", sql: "SELECT `col` FROM db.tbl;", note: "athena反引号" },
  { engine: "athena", sql: "SELECT * FROM ecommerce.orders LIMIT 10;", note: "athena正常" },
  { engine: "flink", sql: "CREATE TABLE s3t.`db`.`tbl` (a INT) WITH ('connector'='filesystem');", note: "flink反引号合法(不该误改)" },
  { engine: "glue", sql: "df = spark.read.parquet('s3://b/k')  # CREATE TABLE IF NOT EXISTS", note: "glue命令式(no-op)" },
  // 先 drop 再 createOrReplace(warn 级 violation,两入口都要报、都不改写)
  { engine: "emr", sql: "spark.sql(f'DROP TABLE IF EXISTS {T}')\ndf.writeTo(T).using('iceberg').createOrReplace()", note: "emr 非原子覆盖(warn)" },
  { engine: "redshift", sql: "", note: "空串" },
];

describe("core-guard 与 inprocess guard 双跑逐字节一致(零漂移铁证)", () => {
  for (const c of CASES) {
    it(`[${c.engine}] ${c.note}`, () => {
      const a = inprocessGuard(c.engine, c.sql);
      const b = coreGuard(c.engine, c.sql);
      expect(b.code).toBe(a.code);
      expect(b.blocked).toBe(a.blocked);
      expect(b.fixed.map((f) => f.ruleId).sort()).toEqual(a.fixed.map((f) => f.ruleId).sort());
      expect(b.violations.map((v) => v.ruleId).sort()).toEqual(a.violations.map((v) => v.ruleId).sort());
    });
  }

  it("所有 CookbookEngine 两入口规则集等价(防 core-guard 漏引擎)", () => {
    // 对每个引擎跑一个通用 SQL,两入口 code 必一致(即便某引擎无规则也应都 no-op 返回原文)。
    const engines: CookbookEngine[] = ["redshift", "athena", "glue", "emr", "flink", "s3tables", "sync"];
    for (const e of engines) {
      const sql = "SELECT `x` FROM t;";
      expect(coreGuard(e, sql).code).toBe(inprocessGuard(e, sql).code);
    }
  });
});
