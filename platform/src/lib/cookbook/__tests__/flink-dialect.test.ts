import { describe, it, expect } from "vitest";
import { guard } from "@/lib/cookbook";
// 平台真跑验证过的样板(不能被误伤=假阳性)
import { defaultFlinkSql, mysqlSinkSql, s3TableSinkSql } from "@/lib/realtime/flink-service";

describe("Flink 方言规则 — 真实样板不误伤(假阳性防护)", () => {
  it("defaultFlinkSql(Kinesis→窗口→S3)不触发任何 error", () => {
    const g = guard("flink", defaultFlinkSql());
    expect(g.blocked, `误伤:${JSON.stringify(g.violations)}`).toBe(false);
  });
  it("mysqlSinkSql 不触发 error", () => {
    const g = guard("flink", mysqlSinkSql());
    expect(g.blocked, `误伤:${JSON.stringify(g.violations)}`).toBe(false);
  });
  it("s3TableSinkSql(多 CREATE + 1 INSERT)不触发 error", () => {
    const g = guard("flink", s3TableSinkSql());
    expect(g.blocked, `误伤:${JSON.stringify(g.violations)}`).toBe(false);
  });
});

describe("Flink ① 启动硬约束", () => {
  it("缺 INSERT INTO → blocked", () => {
    const g = guard("flink", "CREATE TABLE src (a INT) WITH ('connector'='kinesis');");
    expect(g.blocked).toBe(true);
    expect(g.violations.some(v => v.ruleId === "flink.insert-required-to-run")).toBe(true);
  });
  it("有 INSERT INTO → 该规则不命中", () => {
    const g = guard("flink", "CREATE TABLE s(a INT) WITH('connector'='kinesis');\nINSERT INTO s SELECT 1;");
    expect(g.violations.some(v => v.ruleId === "flink.insert-required-to-run")).toBe(false);
  });
  it("两条 INSERT INTO → blocked(single-insert)", () => {
    const sql = "INSERT INTO a SELECT 1;\nINSERT INTO b SELECT 2;";
    const g = guard("flink", sql);
    expect(g.blocked).toBe(true);
    expect(g.violations.some(v => v.ruleId === "flink.single-insert-into")).toBe(true);
  });
  it("一条 INSERT INTO → single-insert 不命中", () => {
    const g = guard("flink", "INSERT INTO a SELECT 1;");
    expect(g.violations.some(v => v.ruleId === "flink.single-insert-into")).toBe(false);
  });
  // keep-placeholders 是纯引导文案(无 antiPattern):真实 ARN 在单引号字符串里,guard 的 mask 词法保护
  // 会遮蔽字符串内容(防误伤合法数据),故此规则【不做生成后正则检测】,靠 retrieve 生成前引导。
  // 这里断言它不会误伤(不产生 error),检测职责交给生成前 retrieve。
  it("keep-placeholders 不做正则检测(不误伤含ARN字符串的合法SQL)", () => {
    const sql = "CREATE TABLE s(a INT) WITH ('connector'='kinesis','stream.arn'='arn:aws:kinesis:us-east-1:123:stream/x');\nINSERT INTO s SELECT 1;";
    const g = guard("flink", sql);
    expect(g.violations.some(v => v.ruleId === "flink.keep-placeholders")).toBe(false);
    expect(g.blocked).toBe(false);
  });
});

describe("Flink ② 窗口聚合方言", () => {
  it("窗口 TVF 但 GROUP BY 缺 window_start/end → blocked", () => {
    const sql = [
      "CREATE TABLE src(region STRING, amount DOUBLE, ts TIMESTAMP(3), WATERMARK FOR ts AS ts - INTERVAL '5' SECOND) WITH ('connector'='kinesis');",
      "INSERT INTO snk SELECT region, SUM(amount) FROM TABLE(TUMBLE(TABLE src, DESCRIPTOR(ts), INTERVAL '1' MINUTE)) GROUP BY region;",
    ].join("\n");
    const g = guard("flink", sql);
    expect(g.violations.some(v => v.ruleId === "flink.window-group-by")).toBe(true);
  });
  it("窗口 TVF + GROUP BY window_start,window_end → 不命中", () => {
    const sql = [
      "CREATE TABLE src(region STRING, amount DOUBLE, ts TIMESTAMP(3), WATERMARK FOR ts AS ts - INTERVAL '5' SECOND) WITH ('connector'='kinesis');",
      "INSERT INTO snk SELECT window_start, region, SUM(amount) FROM TABLE(TUMBLE(TABLE src, DESCRIPTOR(ts), INTERVAL '1' MINUTE)) GROUP BY window_start, window_end, region;",
    ].join("\n");
    const g = guard("flink", sql);
    expect(g.violations.some(v => v.ruleId === "flink.window-group-by")).toBe(false);
  });
  it("老式 TUMBLE(ts,...) → warn(window-tvf-syntax)", () => {
    const sql = "INSERT INTO snk SELECT a FROM src GROUP BY TUMBLE(ts, INTERVAL '1' MINUTE);";
    const g = guard("flink", sql);
    expect(g.violations.some(v => v.ruleId === "flink.window-tvf-syntax")).toBe(true);
  });
});

describe("Flink ③ WATERMARK", () => {
  it("窗口 TVF 但无 WATERMARK → warn", () => {
    const sql = "INSERT INTO snk SELECT window_start FROM TABLE(TUMBLE(TABLE src, DESCRIPTOR(ts), INTERVAL '1' MINUTE)) GROUP BY window_start, window_end;";
    const g = guard("flink", sql);
    expect(g.violations.some(v => v.ruleId === "flink.watermark-for-eventtime")).toBe(true);
  });
});

describe("Flink 反引号是合法的(不照搬 Redshift,不误伤)", () => {
  it("s3t.`db`.`table` 反引号不被改", () => {
    const sql = "INSERT INTO s3t.`mydb`.`tbl` SELECT 1;";
    const g = guard("flink", sql);
    expect(g.code).toContain("`mydb`");  // 反引号原样
    expect(g.code).toContain("`tbl`");
  });
});

describe("Flink 末尾孤立残留括号(编辑器自动补全产物)自动去除", () => {
  // 🔴 真机原文成因(2026-07-26):页面 Monaco 自动补全括号 → 末尾留孤立 ')' → runner 按 ; 切出
  //    独立语句 ')' → Calcite `Encountered ")" at line 1, column 1` → 作业启动即失败反复重启。
  const DIRTY = [
    "CREATE TABLE payments_cdc (payment_id BIGINT, PRIMARY KEY (payment_id) NOT ENFORCED) WITH ('connector'='mysql-cdc','table-name'='payments');",
    "INSERT INTO s3t.`realtime`.`rt_412_verify` SELECT payment_id FROM payments_cdc;",
    ")",
  ].join("\n");

  it("🔴 真机脏 SQL:末尾孤立 ) 被自动去除,且不 blocked(结构容错)", () => {
    const g = guard("flink", DIRTY);
    expect(g.fixed.some((f) => f.ruleId === "flink.trailing-stray-bracket")).toBe(true);
    expect(g.code.trim().endsWith(";")).toBe(true);          // 末尾干净
    expect(/;[\s)\]]*[)\]][\s)\]]*$/.test(g.code)).toBe(false); // 不再有孤立括号
    expect(g.blocked).toBe(false);                            // 修好了不阻断
  });

  it("多个孤立括号 / 方括号残留都清掉", () => {
    const g1 = guard("flink", "INSERT INTO t SELECT 1;\n))\n");
    expect(g1.code.trim()).toBe("INSERT INTO t SELECT 1;");
    const g2 = guard("flink", "INSERT INTO t SELECT 1;\n  ]");
    expect(g2.code.trim()).toBe("INSERT INTO t SELECT 1;");
  });

  it("幂等:已干净的 SQL 不被改、不命中", () => {
    const clean = "INSERT INTO t SELECT 1;";
    const g = guard("flink", clean);
    expect(g.code).toBe(clean);
    expect(g.fixed.some((f) => f.ruleId === "flink.trailing-stray-bracket")).toBe(false);
  });

  it("不误伤:最后一条语句未写分号的合法尾句", () => {
    // 不以 ';' 开头的尾巴不命中 → 合法无分号结尾不受影响。
    const g = guard("flink", "CREATE TABLE s(a INT) WITH('connector'='kinesis');\nINSERT INTO s SELECT 1");
    expect(g.fixed.some((f) => f.ruleId === "flink.trailing-stray-bracket")).toBe(false);
    expect(g.code.trim().endsWith("payments_cdc") || g.code.trim().endsWith("1")).toBe(true);
  });

  it("不误伤:字符串字面量内的 ) 不被当作残留(mask 保护)", () => {
    const sql = "INSERT INTO t SELECT 'a)b)c';";
    const g = guard("flink", sql);
    expect(g.code).toBe(sql); // 字面量里的 ) 原样保留
  });
});
