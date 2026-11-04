import { describe, it, expect } from "vitest";
import { guard, guardCode } from "../guard";
import { maskSqlLiterals } from "../mask";

describe("cookbook guard — 方言纠正(基础行为,迁移等价)", () => {
  it("修正 CTAS + IF NOT EXISTS(Redshift)", () => {
    const bad = "CREATE TABLE IF NOT EXISTS public.ad_campaign_roi AS\nSELECT c.campaign_id FROM public.ad_campaigns c;";
    const r = guard("redshift", bad);
    expect(/IF\s+NOT\s+EXISTS\s+\S+\s+AS/i.test(r.code)).toBe(false);
    expect(/DROP TABLE IF EXISTS public\.ad_campaign_roi/i.test(r.code)).toBe(true);
    expect(r.fixed.length).toBeGreaterThan(0);
    expect(r.blocked).toBe(false);
  });

  it("MySQL 反引号 → 双引号", () => {
    const r = guard("redshift", "SELECT `col` FROM `tbl`;");
    expect(r.code.includes("`")).toBe(false);
    expect(r.code).toContain('"col"');
  });

  it("正常 Redshift SQL 不被误改", () => {
    const ok = "DROP TABLE IF EXISTS x; CREATE TABLE x AS SELECT 1;";
    expect(guard("redshift", ok).code).toBe(ok);
  });

  it("CREATE OR REPLACE TABLE → DROP + CREATE AS", () => {
    const r = guard("redshift", "CREATE OR REPLACE TABLE public.t AS SELECT 1 AS a;");
    expect(/CREATE\s+OR\s+REPLACE/i.test(r.code)).toBe(false);
    expect(/DROP TABLE IF EXISTS public\.t/i.test(r.code)).toBe(true);
  });
});

describe("cookbook guard — 🔴A 词法安全(修复:不误伤字符串/注释)", () => {
  it("字符串字面量里的 CTAS+IF NOT EXISTS 不被改坏", () => {
    // 合法 SQL:把一段 DDL 文本作为【数据】插入日志表,不是真的建表。
    const sql = "INSERT INTO audit_log(note) VALUES ('CREATE TABLE IF NOT EXISTS foo AS bar');";
    const r = guard("redshift", sql);
    // 字符串内容必须原样保留,绝不能被 fix 改成 DROP+CREATE。
    expect(r.code).toBe(sql);
    expect(r.code).toContain("'CREATE TABLE IF NOT EXISTS foo AS bar'");
    expect(r.fixed.length).toBe(0);
  });

  it("行注释里的 anti-pattern 不被改", () => {
    const sql = "-- 旧写法: CREATE TABLE IF NOT EXISTS foo AS ...(已废弃)\nSELECT 1;";
    const r = guard("redshift", sql);
    expect(r.code).toBe(sql);
    expect(r.fixed.length).toBe(0);
  });

  it("块注释里的反引号不被改成双引号", () => {
    const sql = "/* 示例: SELECT `x` FROM t */\nSELECT 1;";
    const r = guard("redshift", sql);
    expect(r.code).toBe(sql);
    expect(r.code).toContain("`x`"); // 注释内反引号保留
  });

  it("字符串里的反引号不被改", () => {
    const sql = "SELECT 'use `backtick` in mysql' AS tip;";
    const r = guard("redshift", sql);
    expect(r.code).toBe(sql);
  });

  it("真违规 + 字符串误报共存:只改真违规,字符串不动", () => {
    const sql = [
      "CREATE TABLE IF NOT EXISTS public.real_tbl AS SELECT 1 AS a;",
      "INSERT INTO log(note) VALUES ('CREATE TABLE IF NOT EXISTS fake AS x');",
    ].join("\n");
    const r = guard("redshift", sql);
    // 第一句真违规被纠正
    expect(/DROP TABLE IF EXISTS public\.real_tbl/i.test(r.code)).toBe(true);
    // 第二句字符串内容原样
    expect(r.code).toContain("'CREATE TABLE IF NOT EXISTS fake AS x'");
    expect(r.code).not.toContain("DROP TABLE IF EXISTS fake");
  });

  it("双引号标识符里的真违规仍被捕获(不因遮蔽而漏)", () => {
    // "my table" 是带空格的合法标识符;CTAS 对它仍是真违规,应被纠正。
    const sql = 'CREATE TABLE IF NOT EXISTS "my_schema"."my_tbl" AS SELECT 1 AS a;';
    const r = guard("redshift", sql);
    expect(/DROP TABLE IF EXISTS "my_schema"\."my_tbl"/i.test(r.code)).toBe(true);
    expect(/IF\s+NOT\s+EXISTS/i.test(r.code)).toBe(false);
  });
});

describe("cookbook guard — 🟠D 幂等/不动点", () => {
  it("已纠正的脚本再过 guard 不变(幂等)", () => {
    const bad = "CREATE TABLE IF NOT EXISTS x AS SELECT 1;";
    const once = guard("redshift", bad).code;
    const twice = guard("redshift", once).code;
    expect(twice).toBe(once); // 二次无改动
  });

  it("多处同规则命中一次性全纠正", () => {
    const bad = "CREATE TABLE IF NOT EXISTS a AS SELECT 1; CREATE TABLE IF NOT EXISTS b AS SELECT 2;";
    const r = guard("redshift", bad);
    expect(/IF\s+NOT\s+EXISTS/i.test(r.code)).toBe(false);
    expect(/DROP TABLE IF EXISTS a/i.test(r.code)).toBe(true);
    expect(/DROP TABLE IF EXISTS b/i.test(r.code)).toBe(true);
  });

  it("多规则共存(CTAS + 反引号)都纠正", () => {
    const bad = "CREATE TABLE IF NOT EXISTS `t` AS SELECT `c` FROM src;";
    const r = guard("redshift", bad);
    expect(r.code.includes("`")).toBe(false);
    expect(/DROP TABLE IF EXISTS/i.test(r.code)).toBe(true);
  });
});

describe("cookbook guard — 🔴 跨规则改长错位(对抗性复核反例,防静默数据损坏)", () => {
  // 根因:CTAS fix 插入 DROP 使文本变长,若 backtick 规则复用旧 masked 区间会切进字符串改坏数据。
  it("CTAS + 字符串内含反引号 + 末尾真反引号标识符:只改真违规,字符串原样", () => {
    const sql = "CREATE TABLE IF NOT EXISTS mart AS SELECT x FROM t WHERE note='a `b` c' AND y=`col`;";
    const r = guard("redshift", sql);
    // CTAS 被纠正
    expect(/DROP TABLE IF EXISTS mart/i.test(r.code)).toBe(true);
    expect(/IF\s+NOT\s+EXISTS/i.test(r.code)).toBe(false);
    // 末尾真标识符 `col` → "col"
    expect(r.code).toContain('y="col"');
    // 字符串里的 `b` 【绝不能】被改成 "b"(核心断言:不损坏数据)
    expect(r.code).toContain("note='a `b` c'");
    expect(r.code).not.toContain('a "b" c');
  });

  it("CTAS + 块注释内含反引号:注释原样不被改", () => {
    const sql = "CREATE TABLE IF NOT EXISTS foo AS /* `bt` */ SELECT `realcol` FROM t;";
    const r = guard("redshift", sql);
    expect(/DROP TABLE IF EXISTS foo/i.test(r.code)).toBe(true);
    expect(r.code).toContain("/* `bt` */"); // 注释内反引号保留
    expect(r.code).toContain('"realcol"'); // 真标识符纠正
  });

  it("CREATE OR REPLACE(也改长)+ 字符串内反引号:字符串不被改", () => {
    const sql = "CREATE OR REPLACE TABLE t AS SELECT 1 WHERE s='x `y` z';";
    const r = guard("redshift", sql);
    expect(/DROP TABLE IF EXISTS t/i.test(r.code)).toBe(true);
    expect(r.code).toContain("s='x `y` z'"); // 字符串原样
  });
});

describe("cookbook guard — §4.3 命令式代码不做正则改写(但可纯检测)", () => {
  it("glue(PySpark)普通脚本无命中 → no-op(不改代码、不拦)", () => {
    const py = "df = spark.read.load('x')\ndf.write.save('y')";
    const r = guard("glue", py);
    expect(r.code).toBe(py);
    expect(r.fixed.length).toBe(0);
    expect(r.blocked).toBe(false);
  });

  // 根治·裂缝B:code 引擎可带 antiPattern 纯检测(拦硬错),但【绝不改写代码】(target=code 禁 fix)。
  it("glue/emr 用 jdbc:redshift 占位符连数仓 → blocked 拦执行,但代码原样不改写", () => {
    const py =
      "df = spark.read.format('jdbc').option('url','jdbc:redshift://ep:5439/dev').load()";
    for (const eng of ["glue", "emr"] as const) {
      const r = guard(eng, py);
      expect(r.blocked).toBe(true); // 命中 error 级 antiPattern → 拦执行
      expect(r.code).toBe(py); // 🔴 code 引擎:只报违规,绝不改写代码(不误伤语义)
      expect(r.fixed.length).toBe(0); // 没有任何机械纠正
      expect(r.violations.some((v) => /no-jdbc-redshift/.test(v.ruleId))).toBe(true);
    }
  });

  it("glue 读 MySQL 源库 jdbc:mysql → 不受限(正当用法,不拦)", () => {
    const py =
      "df = spark.read.format('jdbc').option('url','jdbc:mysql://h:3306/db').load()";
    const r = guard("glue", py);
    expect(r.blocked).toBe(false); // jdbc:mysql 是源库读取的正当用法,不匹配 jdbc:redshift
    expect(r.code).toBe(py);
  });

  // 根治·裂缝B(完整版·占位符类):glue/emr 生成代码留 <尖括号占位符> → blocked 拦(不改写)。
  it("glue/emr 留 <your-workgroup> 尖括号占位符 → blocked 拦执行", () => {
    for (const [eng, py] of [
      ["glue", "rs.execute_statement(WorkgroupName='<your-redshift-serverless-workgroup>', Database='dev')"],
      ["emr", "spark.read.option('path','s3://<temp-bucket>/x').load()"],
    ] as const) {
      const r = guard(eng, py);
      expect(r.blocked).toBe(true); // 命中 no-unfilled-placeholder
      expect(r.code).toBe(py); // 只拦不改写
      expect(r.violations.some((v) => /no-unfilled-placeholder/.test(v.ruleId))).toBe(true);
    }
  });

  it("占位符规则不误伤:平台真实值 bgp-workgroup + ${ds} 花括号 + 比较运算 → 不拦", () => {
    const py = [
      "WORKGROUP='bgp-workgroup'; DATABASE='dev'",     // ✓ 真实值,无尖括号
      "ds=args['ds']; sql=f\"WHERE dt='{ds}'\"",         // ✓ ${ds}/花括号,非尖括号
      "df=spark.table('s3tablescatalog.dws.orders')",    // ✓ 平台注入目录
      "if cnt < 5 and a > b: pass",                       // ✓ 比较运算(尖括号后跟空格/数字)
    ].join("\n");
    for (const eng of ["glue", "emr"] as const) {
      const r = guard(eng, py);
      expect(r.blocked).toBe(false); // 全部合法,不拦
      expect(r.code).toBe(py);
    }
  });
});

describe("cookbook mask — 词法遮蔽正确性", () => {
  it("masked 与原文等长", () => {
    const sql = "SELECT 'abc' -- x\nFROM t;";
    const { masked } = maskSqlLiterals(sql);
    expect(masked.length).toBe(sql.length);
  });
  it("单引号字符串被置空,双引号标识符保留", () => {
    const sql = `SELECT 'hidden', "kept" FROM t;`;
    const { masked } = maskSqlLiterals(sql);
    expect(masked).not.toContain("hidden");
    expect(masked).toContain("kept");
  });
  it("guardCode 便捷函数返回纠正后串", () => {
    expect(guardCode("redshift", "SELECT `c`;")).toContain('"c"');
  });
});
