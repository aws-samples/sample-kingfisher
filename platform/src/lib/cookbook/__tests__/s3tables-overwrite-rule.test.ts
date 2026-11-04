// @kf-batch 37-recipes-atomic-overwrite —— 「S3 Tables 结果表先 drop 再建 / 写 = 非原子覆盖」方言规则的判据。
//
// 三组:① 正例 = 系统配方自己的模板一个都不许命中(配方不能教自己禁的东西;老 EMR 配方那一行 DROP 就是这么溜进去的);
//       ② 反例 = 老配方的写法与它的变体必须被抓到(变异:把规则从 emr.ts / glue.ts / s3tables.ts 摘掉 ⇒ 这里转红);
//       ③ 不误伤 = Glue / EMR 脚本里经 redshift-data 发给**数仓**的 DROP+CTAS(Redshift 正解)绝不能被咬。
import { describe, it, expect } from "vitest";
import { guard, retrieve } from "@/lib/cookbook";
import { SYSTEM_RECIPES, SYSTEM_DIALECT_RULES } from "@/lib/cookbook/seed";
import { DROP_BEFORE_S3TABLES_WRITE_RULE_SUFFIX } from "@/lib/cookbook/seed/s3tables-overwrite-facts";
import type { CookbookEngine } from "@/lib/cookbook/types";

const ENGINES = ["emr", "glue", "s3tables"] as const;
const hit = (engine: CookbookEngine, code: string) =>
  guard(engine, code).violations.filter((v) => v.ruleId.endsWith(DROP_BEFORE_S3TABLES_WRITE_RULE_SUFFIX));

// 老配方(emr.spark-dynamodb-to-s3tables 2026-07-29 版)的原文片段 —— 事故形态本尊。
const OLD_EMR_FORM = [
  "TARGET = 's3tablescatalog.<namespace>.<table>'",
  "spark.sql('CREATE NAMESPACE IF NOT EXISTS s3tablescatalog.<namespace>')",
  "spark.sql(f'DROP TABLE IF EXISTS {TARGET}')",
  "df.writeTo(TARGET).using('iceberg').createOrReplace()",
].join("\n");

describe("① 系统配方模板自己不许命中(配方不能教自己禁的东西)", () => {
  for (const engine of ENGINES) {
    const recipes = SYSTEM_RECIPES.filter((r) => r.engine === engine);
    it(`${engine}:${recipes.length} 条配方模板全部过规则`, () => {
      expect(recipes.length).toBeGreaterThan(0);
      for (const r of recipes) {
        expect(hit(engine, r.template), `配方 ${r.id} 的模板命中了 ${DROP_BEFORE_S3TABLES_WRITE_RULE_SUFFIX}`).toEqual([]);
      }
    });
  }
  it("老配方的那一行 DROP 已从 emr.spark-dynamodb-to-s3tables 模板里去掉,且模板写明 0 行拒绝 + 写后对数", () => {
    const r = SYSTEM_RECIPES.find((x) => x.id === "emr.spark-dynamodb-to-s3tables")!;
    expect(r.template).not.toMatch(/DROP\s+TABLE/i);
    expect(r.template).toContain(".createOrReplace()");
    expect(r.template).toContain("REFUSED_EMPTY_SOURCE");
    expect(r.template).toContain("VERIFY_MISMATCH");
  });
});

describe("② 反例必须被抓到(三引擎各一份实例,同一正则)", () => {
  const cases: Array<[string, string]> = [
    ["老 EMR 配方:DROP {TARGET} + writeTo(TARGET).createOrReplace()", OLD_EMR_FORM],
    ["变量 + CREATE OR REPLACE TABLE {T}", "T = 's3tablescatalog.dws.r'\nspark.sql(f'DROP TABLE IF EXISTS {T}')\nspark.sql(f'CREATE OR REPLACE TABLE {T} USING iceberg AS SELECT * FROM v')"],
    ["变量 + CREATE TABLE {T} … USING iceberg(非原子 CTAS)", "T = 's3tablescatalog.dws.r'\nspark.sql(f'DROP TABLE {T}')\nspark.sql(f'CREATE TABLE {T} USING iceberg AS SELECT * FROM v')"],
    ["字面名 + writeTo('…').createOrReplace()", "spark.sql('DROP TABLE IF EXISTS s3tablescatalog.dws.r')\ndf.writeTo('s3tablescatalog.dws.r').using('iceberg').createOrReplace()"],
    ["自建 catalog 别名 s3t + writeTo(双引号字面)", 'spark.sql("DROP TABLE IF EXISTS s3t.dws.r")\ndf.writeTo("s3t.dws.r").createOrReplace()'],
    ["字面 s3tablescatalog + 普通 CTAS", "spark.sql('DROP TABLE IF EXISTS s3tablescatalog.dws.r')\nspark.sql('CREATE TABLE s3tablescatalog.dws.r AS SELECT * FROM v')"],
    ["字面 s3tablescatalog + DDL + INSERT INTO", "spark.sql('DROP TABLE IF EXISTS s3tablescatalog.dws.r')\nspark.sql('CREATE TABLE IF NOT EXISTS s3tablescatalog.dws.r (a INT) USING iceberg')\nspark.sql('INSERT INTO s3tablescatalog.dws.r SELECT a FROM v')"],
    ["大小写 / 多行缩进", '    spark.sql(f"drop table if exists {tgt}")\n\n    (df.writeTo(tgt)\n       .using("iceberg")\n       .createOrReplace())'],
  ];
  for (const engine of ENGINES) {
    for (const [name, code] of cases) {
      it(`[${engine}] ${name}`, () => {
        const v = hit(engine, code);
        expect(v, "应命中").toHaveLength(1);
        expect(v[0].ruleId).toBe(`${engine}.${DROP_BEFORE_S3TABLES_WRITE_RULE_SUFFIX}`);
        expect(v[0].rule).toContain("INSERT OVERWRITE");
      });
    }
  }
  it("warn 级:只标出来、不改写、不拦存量作业(要改成运行前硬拦 = facts 文件一处改 error)", () => {
    for (const engine of ENGINES) {
      const g = guard(engine, OLD_EMR_FORM);
      expect(g.code).toBe(OLD_EMR_FORM);
      expect(g.fixed).toEqual([]);
      expect(hit(engine, OLD_EMR_FORM)[0].severity).toBe("warn");
    }
    // emr / glue 引擎上这段代码**只**因为 <namespace> 占位符被拦(既有 error 规则),不是因为本规则
    for (const engine of ["emr", "glue"] as const) {
      const noPlaceholder = OLD_EMR_FORM.replace(/<namespace>/g, "ns").replace(/<table>/g, "t");
      expect(guard(engine, noPlaceholder).blocked).toBe(false);
    }
  });
});

describe("③ 不误伤:Redshift 数仓的 DROP+CTAS、不同表、只 drop 不建", () => {
  const safe: Array<[string, string]> = [
    ["glue.redshift-warehouse-access 配方模板(经 redshift-data 发给数仓的 DROP+CTAS)", SYSTEM_RECIPES.find((x) => x.id === "glue.redshift-warehouse-access")!.template],
    ["数仓字面表名 DROP+CTAS", "run_sql('''BEGIN;\nDROP TABLE IF EXISTS public.dws_roi;\nCREATE TABLE public.dws_roi AS SELECT 1;\nCOMMIT;''')"],
    ["数仓 f-string 变量 DROP+CTAS(没有 USING iceberg)", "T = 'public.dws_roi'\nrun_sql(f'BEGIN; DROP TABLE IF EXISTS {T}; CREATE TABLE {T} AS SELECT 1; COMMIT;')"],
    ["同一脚本既读湖又写数仓(读 s3tablescatalog + 数仓 DROP+CTAS)", "df = spark.table('s3tablescatalog.realtime.orders')\nrun_sql('BEGIN; DROP TABLE IF EXISTS public.r; CREATE TABLE public.r AS SELECT 1; COMMIT;')"],
    ["drop 的是别的表,写的是另一张", "spark.sql('DROP TABLE IF EXISTS s3tablescatalog.tmp.scratch')\ndf.writeTo('s3tablescatalog.dws.r').createOrReplace()"],
    ["只 drop 不建(清理)", "spark.sql('DROP TABLE IF EXISTS s3tablescatalog.tmp.scratch')\nprint('cleaned')"],
    ["正解:INSERT OVERWRITE 静态模式", "spark.conf.set('spark.sql.sources.partitionOverwriteMode', 'static')\nspark.sql(f'INSERT OVERWRITE {TARGET} SELECT a, b FROM src_view')"],
    ["正解:createOrReplace 不带 drop", "df.writeTo(TARGET).using('iceberg').createOrReplace()"],
  ];
  for (const engine of ENGINES) {
    for (const [name, code] of safe) {
      it(`[${engine}] ${name}`, () => {
        expect(hit(engine, code)).toEqual([]);
      });
    }
  }
});

describe("接入面:规则与配方真的进了检索层(AI 生成前能看到)", () => {
  it("三引擎的 retrieve().dialectRules 都含本规则(warn ⇒ 提示词里是【建议】)", async () => {
    for (const engine of ENGINES) {
      const slice = await retrieve(engine, { keywords: "overwrite", topK: 3 });
      const rule = slice.dialectRules.find((d) => d.title.includes("不要先 drop 再建"));
      expect(rule, `${engine} 的 dialectRules 缺本规则`).toBeTruthy();
      expect(rule!.severity).toBe("warn");
      expect(rule!.rule).toContain("partitionOverwriteMode");
    }
  });
  it("「全量覆盖 / 按分区覆盖 / 回刷」命中 s3tables.atomic-overwrite,且它排在 topK 首位", async () => {
    for (const kw of ["全量覆盖", "按分区覆盖 结果表", "overwrite partitions", "回刷 幂等"]) {
      const s = await retrieve("s3tables", { keywords: kw, topK: 3 });
      expect(s.recipes[0]?.id, `关键词「${kw}」`).toBe("s3tables.atomic-overwrite");
    }
  });
  it("s3tables.atomic-overwrite 模板本身:INSERT OVERWRITE 静态 / 动态、0 行拒绝、写后对数、按列名对齐都在;没有 drop", () => {
    const r = SYSTEM_RECIPES.find((x) => x.id === "s3tables.atomic-overwrite")!;
    expect(r.template).toContain("partitionOverwriteMode', 'static'");
    expect(r.template).toContain("partitionOverwriteMode', 'dynamic'");
    expect(r.template).toContain("INSERT OVERWRITE {TARGET}");
    expect(r.template).toContain("REFUSED_EMPTY_SOURCE");
    expect(r.template).toContain("VERIFY_MISMATCH");
    expect(r.template).toContain("spark.table(TARGET).columns");
    expect(r.template).not.toMatch(/DROP\s+TABLE/i);
    expect(r.verifiedAt, "模板作为独立脚本未真跑过,不许标 verifiedAt").toBeUndefined();
  });
  it("规则 id 三引擎各一份、同一正则(单一作者)", () => {
    const rules = SYSTEM_DIALECT_RULES.filter((r) => r.id.endsWith(DROP_BEFORE_S3TABLES_WRITE_RULE_SUFFIX));
    expect(rules.map((r) => r.engine).sort()).toEqual(["emr", "glue", "s3tables"]);
    expect(new Set(rules.map((r) => r.antiPattern!.source)).size).toBe(1);
    expect(rules.every((r) => r.target === "code" && !r.fix)).toBe(true);
  });
});
