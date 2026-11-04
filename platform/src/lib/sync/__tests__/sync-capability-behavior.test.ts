// @kf-batch 37-sync-capability —— 序 37 的**行为**判据:生成的 Glue 脚本原样在假的 Spark / Redshift 上跑
// (glue-harness.py),断最终表状态与失败时是否原样。判别力:同一组断言喂改动前的脚本(__golden__ 里的覆盖形态)
// 必须红 —— 证明判据看得见 B-53(见最后一组)。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateGlueScript } from "@/lib/sync/glue-script-generator";
import { GOLDEN_BINDINGS, GOLDEN_SHAPES } from "./golden-shapes";
import type { DataSource } from "@/types/datasource";

const HARNESS = join(__dirname, "glue-harness.py");
const mysqlDs = GOLDEN_SHAPES[0].ds;
const ddbDs = GOLDEN_SHAPES.find((s) => s.name === "ddb-redshift-append")!.ds;

type Row = Record<string, unknown>;
interface HarnessOut {
  error: string | null; stdout: string; spark_sql: string[]; rs_sql: string[]; rs_batches: string[][];
  read_dbtables: string[]; commits: number; persisted?: boolean; conf_log?: [string, string][];
  s3: Record<string, { rows: Row[]; spec: string[]; cols: string[]; props: Record<string, string> }>; rs: Record<string, { rows: Row[]; marked: boolean }>;
}

function runScript(script: string, cfg: Record<string, unknown>): HarnessOut {
  const dir = mkdtempSync(join(tmpdir(), "bgp-s37-"));
  const sp = join(dir, "job.py");
  writeFileSync(sp, script);
  const cp = join(dir, "cfg.json");
  writeFileSync(cp, JSON.stringify({ ...cfg, script: sp }));
  return JSON.parse(execFileSync("python3", [HARNESS, cp], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
}
function run(task: Record<string, unknown>, cfg: Record<string, unknown>, ds: DataSource = mysqlDs): HarnessOut {
  return runScript(generateGlueScript(task, ds, GOLDEN_BINDINGS), cfg);
}

const base = { taskId: "t_s37_000000000001", sourceDatabase: "gamedb", s3Config: { namespace: "gamedb" }, redshiftConfig: { schema: "public" }, syncMode: "full" };
const COLS = ["id", "name"];
const src2 = { players: { cols: COLS, rows: [{ id: 1, name: "a" }, { id: 2, name: "b" }] } };
const src0 = { players: { cols: COLS, rows: [] } };
const old3 = [{ id: 7, name: "x" }, { id: 8, name: "y" }, { id: 9, name: "z" }];
const S3T = "s3tablescatalog.gamedb.players";

describe("B-53 S3 Tables 整表覆盖:一次提交 · 空结果失败 · 写后对数", () => {
  const task = { ...base, sourceTables: ["players"], targetType: "s3-tables", writeMode: "overwrite" };
  it("正常:旧 3 行被替换成新 2 行,只有一次提交,不再发 DELETE", () => {
    const o = run(task, { source: src2, s3_tables: { [S3T]: { rows: old3 } } });
    expect(o.error).toBeNull();
    expect(o.s3[S3T].rows).toEqual(src2.players.rows);
    expect(o.commits).toBe(1);
    expect(o.spark_sql.some((q) => /^DELETE FROM/.test(q))).toBe(false);
    expect(o.stdout).toContain(`SYNC_VERIFY target=s3tables table=${S3T} scope=table source_rows=2 target_rows=2`);
    expect(o.persisted).toBe(true);
  });
  it("写入失败:目标表原样(旧 3 行一行不少)", () => {
    const o = run(task, { source: src2, s3_tables: { [S3T]: { rows: old3 } }, fail: { s3_write: true } });
    expect(o.error).toMatch(/injected S3 write failure/);
    expect(o.s3[S3T].rows).toEqual(old3);
  });
  it("读到 0 行:默认失败,任何写语句都没发,旧数据原样", () => {
    const o = run(task, { source: src0, s3_tables: { [S3T]: { rows: old3 } } });
    expect(o.error).toMatch(/SYNC_REFUSED_EMPTY_SOURCE/);
    expect(o.s3[S3T].rows).toEqual(old3);
    expect(o.commits).toBe(0);
  });
  it("读到 0 行 + 显式允许:目标被清空,不报错", () => {
    const o = run({ ...task, allowEmptyOverwrite: true }, { source: src0, s3_tables: { [S3T]: { rows: old3 } } });
    expect(o.error).toBeNull();
    expect(o.s3[S3T].rows).toEqual([]);
  });
  it("写后行数对不上:判失败", () => {
    const o = run(task, { source: src2, s3_tables: { [S3T]: { rows: old3 } }, s3_count_skew: 1 });
    expect(o.error).toMatch(/SYNC_VERIFY_MISMATCH target=s3tables/);
  });
  it("目标表不存在:建表 + 对数", () => {
    const o = run(task, { source: src2 });
    expect(o.error).toBeNull();
    expect(o.s3[S3T].rows).toEqual(src2.players.rows);
    expect(o.stdout).toContain("SYNC_VERIFY target=s3tables");
  });
});

describe("B-53 Redshift 整表覆盖:暂存表 + 一个事务换入 + 写后对数", () => {
  const task = { ...base, sourceTables: ["players"], targetType: "redshift", writeMode: "overwrite" };
  const RT = "public.players";
  const rsOld = { [RT]: { rows: old3, marked: true } };
  it("正常:目标 = 新 2 行;换入是一个批(DELETE + INSERT SELECT);暂存表已删", () => {
    const o = run(task, { source: src2, rs_tables: rsOld });
    expect(o.error).toBeNull();
    expect(o.rs[RT].rows.map((r) => String(r.id))).toEqual(["1", "2"]); // 夹具里列类型都按字符串报,Redshift 路径会转成字符串
    expect(o.rs_batches).toHaveLength(1);
    expect(o.rs_batches[0][0]).toBe(`DELETE FROM ${RT}`);
    expect(o.rs_batches[0][1]).toMatch(/^INSERT INTO public\.players \(.*\) SELECT .* FROM public\.players__bgp_stage$/);
    expect(Object.keys(o.rs)).not.toContain("public.players__bgp_stage");
    expect(o.rs_sql.some((q) => /^DELETE FROM public\.players$/.test(q))).toBe(false);
    expect(o.stdout).toContain("SYNC_VERIFY target=redshift table=public.players scope=table source_rows=2 target_rows=2");
  });
  it("COPY 失败:目标原样,暂存表不留", () => {
    const o = run(task, { source: src2, rs_tables: rsOld, fail: { copy: true } });
    expect(o.error).toMatch(/COPY|INSERT|injected/);
    expect(o.rs[RT].rows).toEqual(old3);
    expect(Object.keys(o.rs)).not.toContain("public.players__bgp_stage");
  });
  it("换入事务失败:目标原样", () => {
    const o = run(task, { source: src2, rs_tables: rsOld, fail: { swap: true } });
    expect(o.error).toMatch(/SWAP\(overwrite\) failed/);
    expect(o.rs[RT].rows).toEqual(old3);
    expect(Object.keys(o.rs)).not.toContain("public.players__bgp_stage");
  });
  it("读到 0 行:默认失败、目标原样;显式允许则清空", () => {
    const o = run(task, { source: src0, rs_tables: rsOld });
    expect(o.error).toMatch(/SYNC_REFUSED_EMPTY_SOURCE/);
    expect(o.rs[RT].rows).toEqual(old3);
    const o2 = run({ ...task, allowEmptyOverwrite: true }, { source: src0, rs_tables: rsOld });
    expect(o2.error).toBeNull();
    expect(o2.rs[RT].rows).toEqual([]);
  });
  it("写后行数对不上:判失败", () => {
    const o = run(task, { source: src2, rs_tables: rsOld, rs_count_skew: 1 });
    expect(o.error).toMatch(/SYNC_VERIFY_MISMATCH target=redshift/);
  });
  it("both:两个目标都对数", () => {
    const o = run({ ...task, targetType: "both" }, { source: src2, rs_tables: rsOld, s3_tables: { [S3T]: { rows: old3 } } });
    expect(o.error).toBeNull();
    expect(o.s3[S3T].rows).toHaveLength(2);
    expect(o.rs[RT].rows).toHaveLength(2);
  });
});

describe("B-52 过滤条件真下推 + ④⑥ 日期变量", () => {
  it("WHERE 带变量:按 --ds 渲染后下推成子查询", () => {
    const t = { ...base, sourceTables: ["players"], targetType: "redshift", writeMode: "append", whereClause: "status = 'done' AND d >= '${run_date}'" };
    const o = run(t, { source: src2, argv: ["--ds", "2026-07-03"] });
    expect(o.error).toBeNull();
    expect(o.read_dbtables).toEqual(["(SELECT * FROM players WHERE (status = 'done' AND d >= '2026-07-03')) AS bgpq"]);
    expect(o.stdout).toContain("SYNC_RUN_DATE ds=2026-07-03 tz=UTC");
  });
  it("WHERE 不带变量:原样下推,脚本里没有日期解析", () => {
    const t = { ...base, sourceTables: ["players"], targetType: "redshift", writeMode: "append", whereClause: "id > 1" };
    const script = generateGlueScript(t, mysqlDs, GOLDEN_BINDINGS);
    expect(script).not.toContain("bgp_sync_run_date");
    expect(runScript(script, { source: src2 }).read_dbtables).toEqual(["(SELECT * FROM players WHERE (id > 1)) AS bgpq"]);
  });
  it("WHERE + 增量:两个谓词 AND 合并", () => {
    const t = { ...base, sourceTables: ["players"], targetType: "redshift", writeMode: "append", syncMode: "incremental", incrementalColumn: "id", incrementalValue: 5, whereClause: "name <> 'x'" };
    const o = run(t, { source: src2, rs_tables: { "public.players": { rows: [], marked: true } } });
    expect(o.error).toBeNull();
    expect(o.read_dbtables).toEqual(["(SELECT * FROM players WHERE (name <> 'x') AND id > 5) AS bgpq"]);
  });
  it("源表名模板:bizmonth = 运行日上个月;写进显式给定的目标表", () => {
    const tpl = "cf_point_${bizmonth}";
    const t = { ...base, sourceTables: [tpl], targetTableNames: { [tpl]: "ods_point" }, targetType: "s3-tables", writeMode: "append" };
    const o = run(t, { source: { cf_point_202609: { cols: COLS, rows: [{ id: 1, name: "a" }] } }, argv: ["--ds", "2026-10-12"] });
    expect(o.error).toBeNull();
    expect(o.read_dbtables).toEqual(["cf_point_202609"]);
    expect(o.s3["s3tablescatalog.gamedb.ods_point"].rows).toHaveLength(1);
    expect(o.stdout).toContain("SYNC_SOURCE_TABLE template=cf_point_${bizmonth} resolved=cf_point_202609");
  });
  it("没带 --ds:按业务时区取今天", () => {
    const t = { ...base, sourceTables: ["players"], targetType: "redshift", writeMode: "append", whereClause: "d = '${ds}'", businessTimezone: "Asia/Singapore" };
    const o = run(t, { source: src2 });
    const sgToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    expect(o.stdout).toContain(`SYNC_RUN_DATE ds=${sgToday} tz=Asia/Singapore`);
  });
  it("非 JDBC 源填了过滤条件:生成期如实拒(不静默忽略)", () => {
    const t = { ...base, sourceTables: ["bgp-orders"], targetType: "redshift", writeMode: "append", whereClause: "x > 1" };
    expect(() => generateGlueScript(t, ddbDs, GOLDEN_BINDINGS)).toThrow(/只支持 JDBC/);
  });
});

describe("⑤ 派生分区列 + 按分区覆盖", () => {
  const rows09 = [
    { id: 1, create_date: "2026-09-01 10:00:00" }, { id: 2, create_date: "2026-09-15 00:00:01" }, { id: 3, create_date: "2026-09-30 23:59:59" },
  ];
  const src = { cf_point_202609: { cols: ["id", "create_date"], rows: rows09 } };
  const tpl = "cf_point_${bizmonth}";
  const t = {
    ...base, sourceTables: [tpl], targetTableNames: { [tpl]: "ods_point" }, writeMode: "overwrite",
    derivedColumns: [{ name: "month", sourceColumn: "create_date", format: "yyyyMM" }],
    overwriteScope: "partitions", partitionKeys: ["month"],
  };
  const ST = "s3tablescatalog.gamedb.ods_point";
  const existing = [
    { id: 80, create_date: "2026-08-02 00:00:00", month: "202608" }, { id: 81, create_date: "2026-08-03 00:00:00", month: "202608" },
    { id: 90, create_date: "2026-09-02 00:00:00", month: "202609" }, { id: 91, create_date: "2026-09-03 00:00:00", month: "202609" },
  ];
  it("S3 Tables:只替换 202609 分区,202608 原样;动态模式用完复位为静态", () => {
    const o = run({ ...t, targetType: "s3-tables", s3Config: { namespace: "gamedb", partitionFields: [{ field: "month", type: "identity" }] } },
      { source: src, argv: ["--ds", "2026-10-12"], s3_tables: { [ST]: { rows: existing, spec: ["month"] } } });
    expect(o.error).toBeNull();
    const byMonth = (m: string) => o.s3[ST].rows.filter((r) => r.month === m).map((r) => r.id);
    expect(byMonth("202608")).toEqual([80, 81]);
    expect(byMonth("202609")).toEqual([1, 2, 3]);
    expect(o.conf_log).toEqual([["spark.sql.sources.partitionOverwriteMode", "dynamic"], ["spark.sql.sources.partitionOverwriteMode", "static"]]);
    expect(o.stdout).toContain("scope=partitions source_rows=3 target_rows=3");
  });
  it("S3 Tables:目标表分区规格不一致 ⇒ 拒绝,一行未动", () => {
    const o = run({ ...t, targetType: "s3-tables", s3Config: { namespace: "gamedb", partitionFields: [{ field: "month", type: "identity" }] } },
      { source: src, argv: ["--ds", "2026-10-12"], s3_tables: { [ST]: { rows: existing, spec: [] } } });
    expect(o.error).toMatch(/SYNC_REFUSED_PARTITION_SPEC/);
    expect(o.s3[ST].rows).toEqual(existing);
  });
  it("S3 Tables:目标表不存在 ⇒ 按分区列建表", () => {
    const o = run({ ...t, targetType: "s3-tables", s3Config: { namespace: "gamedb", partitionFields: [{ field: "month", type: "identity" }] } },
      { source: src, argv: ["--ds", "2026-10-12"] });
    expect(o.error).toBeNull();
    expect(o.s3[ST].spec).toEqual(["month"]);
    expect(o.s3[ST].rows).toHaveLength(3);
  });
  it("Redshift:一个事务里删 202609 再插入,202608 原样", () => {
    const RT = "public.ods_point";
    const o = run({ ...t, targetType: "redshift" }, { source: src, argv: ["--ds", "2026-10-12"], rs_tables: { [RT]: { rows: existing, marked: true } } });
    expect(o.error).toBeNull();
    expect(o.rs_batches[0][0]).toBe("DELETE FROM public.ods_point WHERE month IN (SELECT DISTINCT month FROM public.ods_point__bgp_stage)");
    expect(o.rs[RT].rows.filter((r) => r.month === "202608").map((r) => r.id)).toEqual([80, 81]);
    expect(o.rs[RT].rows.filter((r) => r.month === "202609").map((r) => String(r.id))).toEqual(["1", "2", "3"]);
  });
  it("派生列取不到值(来源列为空)⇒ 失败,不写", () => {
    const bad = { cf_point_202609: { cols: ["id", "create_date"], rows: [...rows09, { id: 4, create_date: null }] } };
    const o = run({ ...t, targetType: "s3-tables", s3Config: { namespace: "gamedb", partitionFields: [{ field: "month", type: "identity" }] } },
      { source: bad, argv: ["--ds", "2026-10-12"], s3_tables: { [ST]: { rows: existing, spec: ["month"] } } });
    expect(o.error).toMatch(/SYNC_DERIVED_NULL/);
    expect(o.s3[ST].rows).toEqual(existing);
  });
});

describe("存量非覆盖形态在夹具上照常跑通(夹具保真 + 无回归)", () => {
  for (const name of ["jdbc-redshift-append", "jdbc-s3-append", "jdbc-both-incremental", "jdbc-both-append-renamed-targets"]) {
    it(name, () => {
      const s = GOLDEN_SHAPES.find((x) => x.name === name)!;
      const source = Object.fromEntries((s.task.sourceTables as string[]).map((tb) => [tb, { cols: ["id", "updated_at"], rows: [{ id: 1, updated_at: "2026-02-01" }] }]));
      const o = run(s.task, { source, rs_tables: {} });
      expect(o.error).toBeNull();
      expect(o.persisted).toBeUndefined();
    });
  }
});

describe("判别力:改动前的覆盖脚本过不了上面的判据(B-53 看得见)", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const golden = (n: string) => readFileSync(join(__dirname, "__golden__", `${n}.py`), "utf8");
  it("旧 S3 覆盖脚本:写入失败后目标表被清空", () => {
    const old = runScript(golden("jdbc-both-overwrite"), {
      source: { players: src2.players, orders: src2.players },
      s3_tables: { [S3T]: { rows: old3 }, "s3tablescatalog.gamedb.orders": { rows: old3 } },
      rs_tables: { "public.players": { rows: old3, marked: true }, "public.orders": { rows: old3, marked: true } },
      fail: { s3_write: true },
    });
    expect(old.error).toMatch(/injected/);
    expect(old.s3[S3T].rows).toEqual([]); // 旧行为:DELETE 已提交,INSERT 失败 ⇒ 空表
  });
  it("旧 Redshift 覆盖脚本:COPY 失败后目标表被清空;读到 0 行照删", () => {
    const old = runScript(golden("jdbc-redshift-overwrite-keys-confirmed"), {
      source: { players: src2.players, orders: src2.players },
      rs_tables: { "ods.players": { rows: old3, marked: true }, "ods.orders": { rows: old3, marked: true } },
      fail: { copy: true },
    });
    expect(old.rs["ods.players"].rows).toEqual([]);
    const empty = runScript(golden("jdbc-redshift-overwrite-keys-confirmed"), {
      source: { players: src0.players, orders: src0.players },
      rs_tables: { "ods.players": { rows: old3, marked: true }, "ods.orders": { rows: old3, marked: true } },
    });
    expect(empty.error).toBeNull();
    expect(empty.rs["ods.players"].rows).toEqual([]);
  });
});

describe("按列名写入 + sourceColumns(客户切换到已有表的同形)", () => {
  const srcCols = ["id", "name", "amount", "created_at", "note"];
  const srcTypes = { id: "int", name: "string", amount: "decimal(10,2)", created_at: "date", note: "string" };
  const srcRows = [
    { id: 1, name: "a", amount: "10.00", created_at: "2026-01-01", note: "x" },
    { id: 2, name: "b", amount: "20.00", created_at: "2026-01-02", note: "y" },
  ];
  const src = { players: { cols: srcCols, rows: srcRows, types: srcTypes } };
  const tgtCols = ["created_at", "amount", "id"]; // 客户表:列序与源表不同、且只是子集
  const tgtTypes = { created_at: "date", amount: "decimal(10,2)", id: "int" };
  const sentinel = [{ created_at: "2000-01-01", amount: "1.00", id: 999999 }];
  const existing = () => ({ [S3T]: { rows: sentinel.map((r) => ({ ...r })), cols: tgtCols, types: tgtTypes } });
  const task = { ...base, sourceTables: ["players"], targetType: "s3-tables", writeMode: "overwrite", sourceColumns: { players: ["id", "amount", "created_at"] } };
  it("读源只投影指定列(下推到源库)", () => {
    const o = run(task, { source: src, s3_tables: existing() });
    expect(o.read_dbtables).toEqual(["(SELECT id, amount, created_at FROM players) AS bgpq"]);
    expect(o.stdout).toContain("SYNC_SOURCE_COLUMNS table=players columns=['id', 'amount', 'created_at']");
  });
  it("列序不同的已有表:值按列名落位、哨兵被覆盖、表列序不变、一次提交", () => {
    const o = run(task, { source: src, s3_tables: existing() });
    expect(o.error).toBeNull();
    expect(o.s3[S3T].cols).toEqual(tgtCols);
    const byId = Object.fromEntries(o.s3[S3T].rows.map((r) => [String(r.id), r]));
    expect(Object.keys(byId).sort()).toEqual(["1", "2"]);
    expect(byId["1"].amount).toBe("10.00");
    expect(byId["1"].created_at).toBe("2026-01-01");
    expect(byId["2"].amount).toBe("20.00");
    expect(o.commits).toBe(1);
    expect(o.stdout).toContain(`SYNC_ALIGNED table=${S3T} columns=['created_at', 'amount', 'id']`);
    expect(o.stdout).toContain(`SYNC_VERIFY target=s3tables table=${S3T} scope=table source_rows=2 target_rows=2`);
  });
  it("再跑一次(目标已是对齐后的表):仍成功,不翻倍", () => {
    const o = run(task, { source: src, s3_tables: { [S3T]: { rows: [{ created_at: "2026-01-01", amount: "10.00", id: 1 }, { created_at: "2026-01-02", amount: "20.00", id: 2 }], cols: tgtCols, types: tgtTypes } } });
    expect(o.error).toBeNull();
    expect(o.s3[S3T].rows).toHaveLength(2);
  });
  it("多读了目标表没有的列 ⇒ SYNC_SCHEMA_MISMATCH 开头,一行不动,零提交", () => {
    const o = run({ ...task, sourceColumns: { players: ["id", "name", "amount", "created_at"] } }, { source: src, s3_tables: existing() });
    expect(o.error).toMatch(/^SYNC_SCHEMA_MISMATCH .*not_in_target=\['name'\]/);
    expect(o.s3[S3T].rows).toEqual(sentinel);
    expect(o.commits).toBe(0);
  });
  it("目标表有 df 没有的列 ⇒ 失败,零提交", () => {
    const o = run(task, { source: src, s3_tables: { [S3T]: { rows: [{ ...sentinel[0], extra_col: "e" }], cols: [...tgtCols, "extra_col"], types: { ...tgtTypes, extra_col: "string" } } } });
    expect(o.error).toMatch(/^SYNC_SCHEMA_MISMATCH .*missing_in_source=\['extra_col'\]/);
    expect(o.commits).toBe(0);
  });
  it("同名列类型不同 ⇒ 失败(列, 源, 目标),零提交", () => {
    const o = run(task, { source: src, s3_tables: { [S3T]: { rows: sentinel, cols: tgtCols, types: { ...tgtTypes, amount: "double" } } } });
    expect(o.error).toMatch(/^SYNC_SCHEMA_MISMATCH .*type_diff=\[\('amount', 'decimal\(10,2\)', 'double'\)\]/);
    expect(o.commits).toBe(0);
  });
  it("与派生列 + 按分区覆盖同用:只读指定列,按列名对齐后只替换本批分区", () => {
    const tpl = "cf_point_${bizmonth}";
    const t = {
      ...base, sourceTables: [tpl], targetTableNames: { [tpl]: "ods_point" }, targetType: "s3-tables", writeMode: "overwrite",
      sourceColumns: { [tpl]: ["id", "create_date"] },
      derivedColumns: [{ name: "month", sourceColumn: "create_date", format: "yyyyMM" }],
      overwriteScope: "partitions", partitionKeys: ["month"], s3Config: { namespace: "gamedb", partitionFields: [{ field: "month", type: "string" }] },
    };
    const ST = "s3tablescatalog.gamedb.ods_point";
    const source = { cf_point_202609: { cols: ["id", "create_date", "junk"], rows: [{ id: 1, create_date: "2026-09-01 10:00:00", junk: "j" }, { id: 2, create_date: "2026-09-02 10:00:00", junk: "j" }] } };
    const existingP = { [ST]: { rows: [{ month: "202608", id: 80, create_date: "2026-08-02 00:00:00" }, { month: "202609", id: 90, create_date: "2026-09-09 00:00:00" }], cols: ["month", "id", "create_date"], spec: ["month"] } };
    const o = run(t, { source, argv: ["--ds", "2026-10-12"], s3_tables: existingP });
    expect(o.error).toBeNull();
    expect(o.read_dbtables).toEqual(["(SELECT id, create_date FROM cf_point_202609) AS bgpq"]);
    const by = (m: string) => o.s3[ST].rows.filter((r) => r.month === m).map((r) => r.id);
    expect(by("202608")).toEqual([80]);
    expect(by("202609")).toEqual([1, 2]);
    expect(o.s3[ST].cols).toEqual(["month", "id", "create_date"]);
  });
  it("判别力:改动前的脚本按位置写,列序不同的已有表值会串位(id 列进了 name 值)", () => {
    const golden = readFileSync(join(__dirname, "__golden__", "jdbc-both-overwrite.py"), "utf8");
    const twoCols = { cols: ["id", "name"], rows: [{ id: 1, name: "a" }] };
    const old = runScript(golden, {
      source: { players: twoCols, orders: twoCols },
      s3_tables: { [S3T]: { rows: [{ name: "z", id: 9 }], cols: ["name", "id"] }, "s3tablescatalog.gamedb.orders": { rows: [], cols: ["id", "name"] } },
      rs_tables: { "public.players": { rows: [], marked: true }, "public.orders": { rows: [], marked: true } },
    });
    expect(old.error).toBeNull(); // 旧脚本不报错 —— 这正是问题
    expect(old.s3[S3T].rows).toEqual([{ name: 1, id: "a" }]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 序 37 第五路:B-61 merge 真做 · B-60 S3 Tables 外来表覆盖确认守卫
// ══════════════════════════════════════════════════════════════════════════════
const MARKER = "bgp-platform-created";
const MARKER_KEY = "bgp.created-by";
const RT = "public.players";
const S3T_ORDERS = "s3tablescatalog.gamedb.orders";
/** 已有表:id 1..3;本批 id=1 改值 + id=5 新增 ⇒ 合并后 4 行 */
const existing3 = () => [{ id: 1, name: "a" }, { id: 2, name: "b" }, { id: 3, name: "c" }];
const upsert2 = { players: { cols: COLS, rows: [{ id: 1, name: "A1" }, { id: 5, name: "e" }] } };
const byId = (rows: Row[]) => Object.fromEntries(rows.map((r) => [String(r.id), r]));

describe("B-61 S3 Tables 按键合并(merge 不再是 append)", () => {
  const task = { ...base, sourceTables: ["players"], targetType: "s3-tables", writeMode: "merge", mergeKeys: ["id"] };
  it("正常:旧 3 行 + 本批 2 行(id=1 改值、id=5 新增)⇒ 4 行、id=1 已更新、只一次提交、没有 DELETE / INSERT INTO", () => {
    const o = run(task, { source: upsert2, s3_tables: { [S3T]: { rows: existing3() } } });
    expect(o.error).toBeNull();
    const m = byId(o.s3[S3T].rows);
    expect(Object.keys(m).sort()).toEqual(["1", "2", "3", "5"]);
    expect(m["1"].name).toBe("A1");
    expect(m["2"].name).toBe("b");
    expect(m["5"].name).toBe("e");
    expect(o.commits).toBe(1);
    expect(o.spark_sql.some((q) => /^DELETE FROM|^INSERT INTO|^INSERT OVERWRITE/.test(q))).toBe(false);
    expect(o.spark_sql.some((q) => /^MERGE INTO s3tablescatalog\.gamedb\.players t USING temp_players s ON t\.id = s\.id WHEN MATCHED THEN UPDATE SET \* WHEN NOT MATCHED THEN INSERT \*$/.test(q))).toBe(true);
    expect(o.stdout).toContain(`SYNC_VERIFY target=s3tables table=${S3T} scope=merge source_rows=2 target_rows=2`);
    expect(o.stdout).toContain("SYNC_MERGE_KEYS table=players keys=['id'] rows=2");
    expect(o.persisted).toBe(true);
  });
  it("再跑一次同一批:幂等,仍 4 行、值不变", () => {
    const once = run(task, { source: upsert2, s3_tables: { [S3T]: { rows: existing3() } } });
    const twice = run(task, { source: upsert2, s3_tables: { [S3T]: { rows: once.s3[S3T].rows } } });
    expect(twice.error).toBeNull();
    expect(twice.s3[S3T].rows).toEqual(once.s3[S3T].rows);
  });
  it("列序不同的已有表(name, id):按列名合并不串位,表列序不变", () => {
    const o = run(task, { source: upsert2, s3_tables: { [S3T]: { rows: [{ name: "a", id: 1 }, { name: "b", id: 2 }], cols: ["name", "id"] } } });
    expect(o.error).toBeNull();
    expect(o.s3[S3T].cols).toEqual(["name", "id"]);
    const m = byId(o.s3[S3T].rows);
    expect(Object.keys(m).sort()).toEqual(["1", "2", "5"]);
    expect(m["1"].name).toBe("A1");
    expect(m["5"]).toEqual({ name: "e", id: 5 });
    expect(o.stdout).toContain(`SYNC_ALIGNED table=${S3T} columns=['name', 'id']`);
  });
  it("合并键大小写不敏感(任务写 ID,数据列是 id)", () => {
    const o = run({ ...task, mergeKeys: ["ID"] }, { source: upsert2, s3_tables: { [S3T]: { rows: existing3() } } });
    expect(o.error).toBeNull();
    expect(Object.keys(byId(o.s3[S3T].rows)).sort()).toEqual(["1", "2", "3", "5"]);
  });
  it("合并键不在列里 ⇒ SYNC_MERGE_KEY_MISSING,目标原样,零提交", () => {
    const o = run({ ...task, mergeKeys: ["pk"] }, { source: upsert2, s3_tables: { [S3T]: { rows: existing3() } } });
    expect(o.error).toMatch(/^SYNC_MERGE_KEY_MISSING table=players column=pk/);
    expect(o.s3[S3T].rows).toEqual(existing3());
    expect(o.commits).toBe(0);
  });
  it("合并键有 NULL ⇒ SYNC_MERGE_KEY_NULL,目标原样,零提交", () => {
    const o = run(task, { source: { players: { cols: COLS, rows: [{ id: 1, name: "A1" }, { id: null, name: "n" }] } }, s3_tables: { [S3T]: { rows: existing3() } } });
    expect(o.error).toMatch(/^SYNC_MERGE_KEY_NULL table=players column=id rows=1/);
    expect(o.s3[S3T].rows).toEqual(existing3());
    expect(o.commits).toBe(0);
  });
  it("源内键重复 ⇒ SYNC_MERGE_DUP_SOURCE_KEYS,目标原样,零提交", () => {
    const o = run(task, { source: { players: { cols: COLS, rows: [{ id: 1, name: "A1" }, { id: 1, name: "A2" }] } }, s3_tables: { [S3T]: { rows: existing3() } } });
    expect(o.error).toMatch(/^SYNC_MERGE_DUP_SOURCE_KEYS table=players keys=\['id'\] rows=2 distinct=1/);
    expect(o.s3[S3T].rows).toEqual(existing3());
    expect(o.commits).toBe(0);
  });
  it("写入失败 ⇒ 目标原样", () => {
    const o = run(task, { source: upsert2, s3_tables: { [S3T]: { rows: existing3() } }, fail: { s3_write: true } });
    expect(o.error).toMatch(/injected S3 write failure/);
    expect(o.s3[S3T].rows).toEqual(existing3());
    expect(o.commits).toBe(0);
  });
  it("写后对数不符 ⇒ SYNC_VERIFY_MISMATCH", () => {
    const o = run(task, { source: upsert2, s3_tables: { [S3T]: { rows: existing3() } }, s3_count_skew: 1 });
    expect(o.error).toMatch(/^SYNC_VERIFY_MISMATCH target=s3tables/);
  });
  it("目标表不存在 ⇒ 建表(带平台标记)+ 按键对数", () => {
    const o = run(task, { source: upsert2 });
    expect(o.error).toBeNull();
    expect(o.s3[S3T].rows).toEqual(upsert2.players.rows);
    expect(o.s3[S3T].props[MARKER_KEY]).toBe(MARKER);
    expect(o.stdout).toContain(`SYNC_VERIFY target=s3tables table=${S3T} scope=merge source_rows=2 target_rows=2`);
  });
  it("外来表(无平台标记)+ merge ⇒ 照常合并(merge 不清表,不需要确认)", () => {
    const o = run(task, { source: upsert2, s3_tables: { [S3T]: { rows: existing3(), marked: false } } });
    expect(o.error).toBeNull();
    expect(Object.keys(byId(o.s3[S3T].rows)).sort()).toEqual(["1", "2", "3", "5"]);
    expect(o.spark_sql.some((q) => /^SHOW TBLPROPERTIES/.test(q))).toBe(false);
  });
  it("没有合并键的 merge 任务 ⇒ 生成期就拒(中文),不许静默退化成追加", () => {
    expect(() => generateGlueScript({ ...task, mergeKeys: [] }, mysqlDs, GOLDEN_BINDINGS)).toThrow(/合并键/);
    expect(() => generateGlueScript({ ...task, mergeKeys: undefined }, mysqlDs, GOLDEN_BINDINGS)).toThrow(/合并键/);
  });
});

describe("B-61 Redshift 按键合并:暂存表 + 一个事务(DELETE USING + INSERT SELECT)+ 按键对数", () => {
  const task = { ...base, sourceTables: ["players"], targetType: "redshift", writeMode: "merge", mergeKeys: ["id"] };
  const rsOld = () => ({ [RT]: { rows: [{ id: "1", name: "a" }, { id: "2", name: "b" }, { id: "3", name: "c" }], marked: true } });
  it("正常:目标 4 行、id=1 已更新;单批 = DELETE USING + INSERT SELECT;暂存表不留;没有整表 DELETE", () => {
    const o = run(task, { source: upsert2, rs_tables: rsOld() });
    expect(o.error).toBeNull();
    const m = byId(o.rs[RT].rows);
    expect(Object.keys(m).sort()).toEqual(["1", "2", "3", "5"]);
    expect(m["1"].name).toBe("A1");
    expect(o.rs_batches).toHaveLength(1);
    expect(o.rs_batches[0][0]).toBe("DELETE FROM public.players USING public.players__bgp_stage WHERE public.players.id = public.players__bgp_stage.id");
    expect(o.rs_batches[0][1]).toMatch(/^INSERT INTO public\.players \(id,name\) SELECT id,name FROM public\.players__bgp_stage$/);
    expect(Object.keys(o.rs)).not.toContain("public.players__bgp_stage");
    expect(o.rs_sql.some((q) => /^DELETE FROM public\.players/.test(q))).toBe(false);
    expect(o.stdout).toContain("SYNC_VERIFY target=redshift table=public.players scope=merge source_rows=2 target_rows=2");
    expect(o.stdout).toContain("REDSHIFT_ROWS_WRITTEN table=public.players rows=2");
  });
  it("换入事务失败 ⇒ 目标原样、暂存表不留", () => {
    const o = run(task, { source: upsert2, rs_tables: rsOld(), fail: { swap: true } });
    expect(o.error).toMatch(/MERGE\(upsert\) failed/);
    expect(o.rs[RT].rows).toEqual(rsOld()[RT].rows);
    expect(Object.keys(o.rs)).not.toContain("public.players__bgp_stage");
  });
  it("写后对数不符 ⇒ SYNC_VERIFY_MISMATCH", () => {
    const o = run(task, { source: upsert2, rs_tables: rsOld(), rs_count_skew: 1 });
    expect(o.error).toMatch(/^SYNC_VERIFY_MISMATCH target=redshift/);
  });
  it("外来表(无平台标记)+ merge ⇒ 照常合并(不整表清空,不需要确认)", () => {
    const o = run(task, { source: upsert2, rs_tables: { [RT]: { ...rsOld()[RT], marked: false } } });
    expect(o.error).toBeNull();
    expect(Object.keys(byId(o.rs[RT].rows)).sort()).toEqual(["1", "2", "3", "5"]);
  });
  it("前检不过(源内键重复)⇒ 任何 Redshift 写语句都没发", () => {
    const o = run(task, { source: { players: { cols: COLS, rows: [{ id: 1, name: "x" }, { id: 1, name: "y" }] } }, rs_tables: rsOld() });
    expect(o.error).toMatch(/^SYNC_MERGE_DUP_SOURCE_KEYS/);
    expect(o.rs_sql).toEqual([]);
    expect(o.rs[RT].rows).toEqual(rsOld()[RT].rows);
  });
  it("both:两个目标都按键合并、都对数", () => {
    const o = run({ ...task, targetType: "both" }, { source: upsert2, rs_tables: rsOld(), s3_tables: { [S3T]: { rows: existing3() } } });
    expect(o.error).toBeNull();
    expect(Object.keys(byId(o.s3[S3T].rows)).sort()).toEqual(["1", "2", "3", "5"]);
    expect(Object.keys(byId(o.rs[RT].rows)).sort()).toEqual(["1", "2", "3", "5"]);
    expect(o.stdout).toContain("SYNC_VERIFY target=s3tables");
    expect(o.stdout).toContain("SYNC_VERIFY target=redshift");
  });
  it("增量 + merge:只读水位之后的行、按键合并、**不走**按水位预删;空水位也不整表清空", () => {
    const inc = { ...task, targetType: "both", syncMode: "incremental", incrementalColumn: "id", incrementalValue: 0 };
    const o = run(inc, { source: upsert2, rs_tables: rsOld(), s3_tables: { [S3T]: { rows: existing3() } } });
    expect(o.error).toBeNull();
    expect(o.read_dbtables).toEqual(["(SELECT * FROM players WHERE id > 0) AS incq"]);
    expect(o.spark_sql.some((q) => /^DELETE FROM/.test(q))).toBe(false);
    expect(o.rs_sql.some((q) => /^DELETE FROM/.test(q))).toBe(false);
    expect(Object.keys(byId(o.s3[S3T].rows)).sort()).toEqual(["1", "2", "3", "5"]);
    expect(Object.keys(byId(o.rs[RT].rows)).sort()).toEqual(["1", "2", "3", "5"]);
    const empty = run({ ...inc, incrementalValue: undefined }, { source: upsert2, rs_tables: { [RT]: { ...rsOld()[RT], marked: false } }, s3_tables: { [S3T]: { rows: existing3(), marked: false } } });
    expect(empty.error).toBeNull();
    expect(empty.spark_sql.some((q) => /^DELETE FROM/.test(q))).toBe(false);
    expect(empty.rs_sql.some((q) => /^DELETE FROM/.test(q))).toBe(false);
    expect(Object.keys(byId(empty.s3[S3T].rows)).sort()).toEqual(["1", "2", "3", "5"]);
  });
  it("判别力:B-61 改动前的 merge 脚本(保留为 jdbc-both-merge.pre-b61.py)在同一夹具上跑出**重复行**", () => {
    const old = runScript(readFileSync(join(__dirname, "__golden__", "jdbc-both-merge.pre-b61.py"), "utf8"), {
      source: { players: upsert2.players, orders: upsert2.players },
      s3_tables: { [S3T]: { rows: existing3() }, [S3T_ORDERS]: { rows: existing3() } },
      rs_tables: { [RT]: rsOld()[RT], "public.orders": rsOld()[RT] },
    });
    expect(old.error).toBeNull(); // 旧脚本不报错 —— 这正是问题
    expect(old.s3[S3T].rows.filter((r) => r.id === 1)).toHaveLength(2);
    expect(old.rs[RT].rows.filter((r) => String(r.id) === "1")).toHaveLength(2);
    expect(old.spark_sql.some((q) => /^MERGE INTO/.test(q))).toBe(false);
  });
});

describe("B-60 S3 Tables 外来表覆盖确认守卫(与 Redshift 规则逐字对齐)", () => {
  const task = { ...base, sourceTables: ["players"], targetType: "s3-tables", writeMode: "overwrite" };
  const foreign = () => ({ [S3T]: { rows: existing3(), marked: false } });
  it("外来表(无标记)+ overwrite ⇒ SYNC_REFUSED_CLEAR_FOREIGN_TABLE,行原样,零提交,没发任何写语句", () => {
    const o = run(task, { source: upsert2, s3_tables: foreign() });
    expect(o.error).toMatch(/^SYNC_REFUSED_CLEAR_FOREIGN_TABLE table=s3tablescatalog\.gamedb\.players: 目标表已存在且不是平台建的/);
    expect(o.s3[S3T].rows).toEqual(existing3());
    expect(o.commits).toBe(0);
    expect(o.spark_sql.filter((q) => !/^(SELECT 1 FROM|SHOW TBLPROPERTIES)/.test(q))).toEqual([]);
  });
  it("客户自己的别的属性不算平台标记 ⇒ 照样拒", () => {
    const o = run(task, { source: upsert2, s3_tables: { [S3T]: { rows: existing3(), props: { "format-version": "2", "bgp.created-by": "someone-else" } } } });
    expect(o.error).toMatch(/SYNC_REFUSED_CLEAR_FOREIGN_TABLE/);
    expect(o.s3[S3T].rows).toEqual(existing3());
  });
  it("正控制①:平台建的表(属性带标记)⇒ 正常覆盖", () => {
    const o = run(task, { source: upsert2, s3_tables: { [S3T]: { rows: existing3() } } });
    expect(o.error).toBeNull();
    expect(o.s3[S3T].rows).toEqual(upsert2.players.rows);
  });
  it("正控制②:外来表 + 确认清单含三段名 ⇒ 正常覆盖;确认的是别的表 ⇒ 不放行这一张", () => {
    const ok = run({ ...task, overwriteConfirmedTables: [S3T] }, { source: upsert2, s3_tables: foreign() });
    expect(ok.error).toBeNull();
    expect(ok.s3[S3T].rows).toEqual(upsert2.players.rows);
    const other = run({ ...task, overwriteConfirmedTables: [S3T_ORDERS] }, { source: upsert2, s3_tables: foreign() });
    expect(other.error).toMatch(/SYNC_REFUSED_CLEAR_FOREIGN_TABLE/);
  });
  it("按分区覆盖也是 overwrite ⇒ 外来表同样要确认(与 Redshift 一致)", () => {
    const p = { ...task, overwriteScope: "partitions", partitionKeys: ["name"], s3Config: { namespace: "gamedb", partitionFields: [{ field: "name", type: "identity" }] } };
    const o = run(p, { source: upsert2, s3_tables: { [S3T]: { rows: existing3(), marked: false, spec: ["name"] } } });
    expect(o.error).toMatch(/SYNC_REFUSED_CLEAR_FOREIGN_TABLE/);
    expect(o.s3[S3T].rows).toEqual(existing3());
  });
  it("增量 + 空水位(整表预删那条路)⇒ 外来表同样拦,一行不删;有水位(只删区间)⇒ 放行", () => {
    const inc = { ...task, writeMode: "append", syncMode: "incremental", incrementalColumn: "id" };
    const o = run(inc, { source: upsert2, s3_tables: foreign() });
    expect(o.error).toMatch(/SYNC_REFUSED_CLEAR_FOREIGN_TABLE/);
    expect(o.s3[S3T].rows).toEqual(existing3());
    expect(o.spark_sql.some((q) => /^DELETE FROM/.test(q))).toBe(false);
    const marked = run(inc, { source: upsert2, s3_tables: { [S3T]: { rows: existing3() } } });
    expect(marked.error).toBeNull();
    expect(marked.s3[S3T].rows).toEqual(upsert2.players.rows); // 全量回填:整表重载
    const withWm = run({ ...inc, incrementalValue: 0 }, { source: upsert2, s3_tables: foreign() });
    expect(withWm.error).toBeNull();
    expect(withWm.spark_sql.some((q) => /^SHOW TBLPROPERTIES/.test(q))).toBe(false);
  });
  it("append(不清表)⇒ 外来表照常追加,脚本里根本没有守卫", () => {
    const o = run({ ...task, writeMode: "append" }, { source: upsert2, s3_tables: foreign() });
    expect(o.error).toBeNull();
    expect(o.s3[S3T].rows).toHaveLength(5);
    expect(o.spark_sql.some((q) => /^SHOW TBLPROPERTIES/.test(q))).toBe(false);
    expect(generateGlueScript({ ...task, writeMode: "append" }, mysqlDs, GOLDEN_BINDINGS)).not.toContain("SYNC_REFUSED_CLEAR_FOREIGN_TABLE");
  });
  it("新建表带标记(TBLPROPERTIES 里 bgp.created-by);再跑 overwrite 不需要确认", () => {
    const first = run(task, { source: upsert2 });
    expect(first.error).toBeNull();
    expect(first.s3[S3T].props).toMatchObject({ "format-version": "2", [MARKER_KEY]: MARKER });
    const again = run(task, { source: src2, s3_tables: { [S3T]: { rows: first.s3[S3T].rows, props: first.s3[S3T].props } } });
    expect(again.error).toBeNull();
    expect(again.s3[S3T].rows).toEqual(src2.players.rows);
  });
  it("both:S3 外来表被拒时 Redshift 目标也一行未动(S3 先写,拒在任何写入之前)", () => {
    const o = run({ ...task, targetType: "both" }, { source: upsert2, s3_tables: foreign(), rs_tables: { [RT]: { rows: existing3(), marked: true } } });
    expect(o.error).toMatch(/SYNC_REFUSED_CLEAR_FOREIGN_TABLE table=s3tablescatalog/);
    expect(o.rs[RT].rows).toEqual(existing3());
    expect(o.rs_sql).toEqual([]);
  });
  it("判别力:改动前的覆盖脚本对外来表直接替换(不看属性、不要确认)", () => {
    const old = runScript(readFileSync(join(__dirname, "__golden__", "jdbc-both-overwrite.py"), "utf8"), {
      source: { players: upsert2.players, orders: upsert2.players },
      s3_tables: { [S3T]: { rows: existing3(), marked: false }, [S3T_ORDERS]: { rows: existing3(), marked: false } },
      rs_tables: { [RT]: { rows: [], marked: true }, "public.orders": { rows: [], marked: true } },
    });
    expect(old.error).toBeNull();
    expect(old.s3[S3T].rows).toEqual(upsert2.players.rows); // 旧行为:客户的 3 行没了
    expect(old.spark_sql.some((q) => /^SHOW TBLPROPERTIES/.test(q))).toBe(false);
  });
});
