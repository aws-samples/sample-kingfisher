// @kf-batch 37-sync-capability —— 序 37 第五路的契约判据(纯函数,零 mock):
//   B-61 合并键(必填、形态、大小写不敏感去重、非 Glue 通道不要求、非 merge 忽略)
//   B-60 确认清单收三段名 / S3 目标三段名 / merge 不清表 / 生成器对无键 merge 的拒绝 / 生成脚本 py_compile。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeKeysOf, usesGlueWriteMode, validateSyncCapabilityFields } from "@/lib/sync/run-vars";
import {
  clearsWholeTable, parseConfirmedTables, s3TargetTables, validateSyncWriteFields, unconfirmedForeignTables,
  S3_TABLE_MARKER_PROPERTY, PLATFORM_TABLE_MARKER,
} from "@/lib/sync/target-table-guard";
import { generateGlueScript } from "@/lib/sync/glue-script-generator";
import { GOLDEN_BINDINGS, GOLDEN_SHAPES } from "./golden-shapes";

const mysqlDs = GOLDEN_SHAPES[0].ds;
const legacy = { sourceTables: ["a", "b"], syncMode: "full", targetType: "both" };

describe("B-61 合并键契约", () => {
  it("mergeKeysOf:去空白、大小写不敏感去重、保留首次写法;非数组 ⇒ []", () => {
    expect(mergeKeysOf({ mergeKeys: [" id ", "ID", "Name", "name", "id"] })).toEqual(["id", "Name"]);
    expect(mergeKeysOf({ mergeKeys: "id" })).toEqual([]);
    expect(mergeKeysOf({})).toEqual([]);
    expect(mergeKeysOf({ mergeKeys: [1, null, ""] as never })).toEqual([]);
  });
  it("merge 没键 ⇒ 拒(中文,点名 mergeKeys);有键 ⇒ 放行", () => {
    expect(validateSyncCapabilityFields({ ...legacy, writeMode: "merge" })).toMatch(/合并写入.*mergeKeys/);
    expect(validateSyncCapabilityFields({ ...legacy, writeMode: "merge", mergeKeys: [] })).toMatch(/合并写入.*mergeKeys/);
    expect(validateSyncCapabilityFields({ ...legacy, writeMode: "merge", mergeKeys: ["id"] })).toBeNull();
    expect(validateSyncCapabilityFields({ ...legacy, writeMode: "merge", mergeKeys: ["id", "tenant_id"] })).toBeNull();
  });
  it("键的形态:非字符串 / 非法标识符 / 非数组 ⇒ 拒", () => {
    expect(validateSyncCapabilityFields({ ...legacy, writeMode: "merge", mergeKeys: ["id-1"] })).toMatch(/合并键不合法/);
    expect(validateSyncCapabilityFields({ ...legacy, writeMode: "merge", mergeKeys: ["id; drop"] })).toMatch(/合并键不合法/);
    expect(validateSyncCapabilityFields({ ...legacy, writeMode: "merge", mergeKeys: [1] as never })).toMatch(/合并键不合法/);
    expect(validateSyncCapabilityFields({ ...legacy, writeMode: "merge", mergeKeys: "id" as never })).toMatch(/列名数组/);
  });
  it("非 Glue 通道的 merge(实时 DMS / zero-etl)不要求合并键;非 merge 带了 mergeKeys 不报错", () => {
    expect(validateSyncCapabilityFields({ ...legacy, writeMode: "merge", syncMode: "realtime" })).toBeNull();
    expect(validateSyncCapabilityFields({ ...legacy, writeMode: "merge", channel: "dms" })).toBeNull();
    expect(validateSyncCapabilityFields({ ...legacy, writeMode: "merge", channel: "zero-etl" })).toBeNull();
    expect(validateSyncCapabilityFields({ ...legacy, writeMode: "append", mergeKeys: ["x-y"] })).toBeNull();
    expect(validateSyncCapabilityFields({ ...legacy, writeMode: "overwrite", mergeKeys: [] })).toBeNull();
  });
  it("usesGlueWriteMode 与 validateSyncWriteFields 同一口径", () => {
    expect(usesGlueWriteMode({ syncMode: "full", channel: "glue" })).toBe(true);
    expect(usesGlueWriteMode({ syncMode: "full" })).toBe(true);
    expect(usesGlueWriteMode({ syncMode: "realtime" })).toBe(false);
    expect(usesGlueWriteMode({ syncMode: "full", channel: "dms" })).toBe(false);
    expect(usesGlueWriteMode({ syncMode: "full", channel: "zero-etl" })).toBe(false);
    expect(validateSyncWriteFields({ syncMode: "full", channel: "glue" })).toMatch(/writeMode 必填/);
    expect(validateSyncWriteFields({ syncMode: "full", channel: "dms" })).toBeNull();
  });
  it("生成器:merge 没键 ⇒ 拒(即使绕过路由直接给任务行);增量 + merge 同样", () => {
    const t = { taskId: "t_s37_merge_000a", sourceDatabase: "gamedb", sourceTables: ["players"], s3Config: { namespace: "gamedb" }, redshiftConfig: { schema: "public" }, syncMode: "full", targetType: "both", writeMode: "merge" };
    expect(() => generateGlueScript(t, mysqlDs, GOLDEN_BINDINGS)).toThrow(/合并键|mergeKeys/);
    expect(() => generateGlueScript({ ...t, mergeKeys: ["ID", "id"], syncMode: "incremental", incrementalColumn: "id" }, mysqlDs, GOLDEN_BINDINGS)).not.toThrow();
  });
  it("生成的 merge 脚本 py_compile 通过(s3 / redshift / both / 增量 / 带守卫的覆盖)", () => {
    const t = { taskId: "t_s37_merge_000b", sourceDatabase: "gamedb", sourceTables: ["players"], s3Config: { namespace: "gamedb" }, redshiftConfig: { schema: "public" }, syncMode: "full", mergeKeys: ["id"] };
    const shapes = [
      { ...t, targetType: "s3-tables", writeMode: "merge" },
      { ...t, targetType: "redshift", writeMode: "merge" },
      { ...t, targetType: "both", writeMode: "merge" },
      { ...t, targetType: "both", writeMode: "merge", syncMode: "incremental", incrementalColumn: "id", incrementalValue: 3 },
      { ...t, targetType: "both", writeMode: "overwrite", overwriteConfirmedTables: ["s3tablescatalog.gamedb.players", "public.players"] },
      { ...t, targetType: "s3-tables", writeMode: "append", syncMode: "incremental", incrementalColumn: "id" },
    ];
    const dir = mkdtempSync(join(tmpdir(), "kf-s37-merge-"));
    for (const [i, s] of shapes.entries()) {
      const py = join(dir, `s${i}.py`);
      writeFileSync(py, generateGlueScript(s, mysqlDs, GOLDEN_BINDINGS), "utf8");
      execFileSync("python3", ["-m", "py_compile", py], { encoding: "utf8" });
    }
  });
});

describe("B-60 契约", () => {
  it("clearsWholeTable:merge 恒不清表(全量 / 增量空水位都不);其余口径不变", () => {
    expect(clearsWholeTable({ syncMode: "full", writeMode: "merge" })).toBe(false);
    expect(clearsWholeTable({ syncMode: "incremental", writeMode: "merge" })).toBe(false);
    expect(clearsWholeTable({ syncMode: "incremental", writeMode: "merge", incrementalColumn: "id" })).toBe(false);
    expect(clearsWholeTable({ syncMode: "full", writeMode: "overwrite" })).toBe(true);
    expect(clearsWholeTable({ syncMode: "incremental", writeMode: "append", incrementalColumn: "id" })).toBe(true);
    expect(clearsWholeTable({ syncMode: "incremental", writeMode: "append", incrementalColumn: "id", incrementalValue: 1 })).toBe(false);
  });
  it("parseConfirmedTables:收 schema.table 与 s3tablescatalog.ns.table;拒别的三段 / 大写 / 两段 catalog", () => {
    expect(parseConfirmedTables(["s3tablescatalog.gamedb.players", "public.players", "public.players"])).toEqual(["public.players", "s3tablescatalog.gamedb.players"]);
    for (const bad of [["S3tablescatalog.gamedb.players"], ["glue_catalog.gamedb.players"], ["s3tablescatalog.players"], ["s3tablescatalog.gamedb.Players"], ["a.b.c.d"], ["s3tablescatalog.gamedb.players;"]]) {
      expect(() => parseConfirmedTables(bad), JSON.stringify(bad)).toThrow(/schema\.table.*s3tablescatalog/);
    }
    expect(validateSyncWriteFields({ syncMode: "full", writeMode: "overwrite", overwriteConfirmedTables: ["s3tablescatalog.gamedb.players"] })).toBeNull();
  });
  it("s3TargetTables:namespace 取 s3Config.namespace → ds.database → default,三段名与脚本同规则(小写 + 安全化 + 前后缀)", () => {
    const base = { sourceTables: ["Orders", "a-b"], targetType: "s3-tables" };
    expect(s3TargetTables({ ...base, s3Config: { namespace: "Game-DB" } }, undefined)).toEqual(["s3tablescatalog.game_db.orders", "s3tablescatalog.game_db.a_b"]);
    expect(s3TargetTables(base, { database: "gamedb" })).toEqual(["s3tablescatalog.gamedb.orders", "s3tablescatalog.gamedb.a_b"]);
    expect(s3TargetTables(base, {})).toEqual(["s3tablescatalog.default.orders", "s3tablescatalog.default.a_b"]);
    expect(s3TargetTables({ ...base, targetTablePrefix: "ods_", targetTableNames: { Orders: "fact_orders" } }, { database: "g" })).toEqual(["s3tablescatalog.g.fact_orders", "s3tablescatalog.g.ods_a_b"]);
    expect(() => s3TargetTables(base, undefined)).toThrow(/namespace/);
  });
  it("unconfirmedForeignTables 对三段名同样生效", () => {
    const st = [
      { fq: "s3tablescatalog.g.a", exists: true, platformCreated: false },
      { fq: "s3tablescatalog.g.b", exists: true, platformCreated: true },
      { fq: "s3tablescatalog.g.c", exists: false, platformCreated: false },
      { fq: "public.a", exists: true, platformCreated: false },
    ];
    expect(unconfirmedForeignTables(st, ["public.a"])).toEqual(["s3tablescatalog.g.a"]);
  });
  it("生成器注入的是同一个标记键 / 值(Python 里没有第二份字面量)", () => {
    const t = { taskId: "t_s37_guard_000c", sourceDatabase: "gamedb", sourceTables: ["players"], s3Config: { namespace: "gamedb" }, syncMode: "full", targetType: "s3-tables", writeMode: "overwrite" };
    const script = generateGlueScript(t, mysqlDs, GOLDEN_BINDINGS);
    expect(script).toContain(`'${S3_TABLE_MARKER_PROPERTY}'='${PLATFORM_TABLE_MARKER}'`);
    expect(script).toContain(`_bgp_props.get(${JSON.stringify(S3_TABLE_MARKER_PROPERTY)}) != ${JSON.stringify(PLATFORM_TABLE_MARKER)}`);
    expect(script.split(PLATFORM_TABLE_MARKER).length - 1).toBe(2); // CREATE TABLE 一处 + 守卫一处(S3-only 任务没有 Redshift 块)
  });
});
