// 序 53 —— Glue 6.0(Spark 4)下平台生成的同步脚本的兼容段:
//   · MySQL 源 + Glue ≥ 6.0 ⇒ 脚本带「FloatType 规整回 double」段(Spark 4.0 把 MySQL FLOAT 读成 FloatType,5.1 是 DoubleType,没有 legacy 开关);
//   · 记录没存版本(存量任务)/ 5.1 / 非 MySQL 源 ⇒ 这段不进脚本(存量脚本逐字节不变,golden-script.test 另钉);
//   · 6.0 脚本在离线替身(glue-harness.py)上原样跑通 —— 兼容段的 import / cast 在运行时都解析得到。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateGlueScript } from "@/lib/sync/glue-script-generator";
import { GOLDEN_BINDINGS, GOLDEN_SHAPES } from "./golden-shapes";
import type { DataSource } from "@/types/datasource";

const HARNESS = join(__dirname, "glue-harness.py");
const mysqlDs = GOLDEN_SHAPES[0].ds;
const pgDs = { ...mysqlDs, type: "postgresql", port: 5432 } as DataSource;
const base = { taskId: "t_s53_000000000001", sourceDatabase: "gamedb", s3Config: { namespace: "gamedb" }, redshiftConfig: { schema: "public" }, syncMode: "full", sourceTables: ["players"], targetType: "redshift", writeMode: "append" };
const COMPAT_LINE = "from pyspark.sql.types import FloatType as _FloatT";

function runScript(script: string, cfg: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "bgp-s53-"));
  const sp = join(dir, "job.py");
  writeFileSync(sp, script);
  const cp = join(dir, "cfg.json");
  writeFileSync(cp, JSON.stringify({ ...cfg, script: sp }));
  return JSON.parse(execFileSync("python3", [HARNESS, cp], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })) as { error: string | null; rs: Record<string, { rows: Record<string, unknown>[] }> };
}

describe("序 53 Glue 6.0 / Spark 4 兼容段", () => {
  it("MySQL 源 + glueVersion 6.0 ⇒ 脚本带 FloatType → double 规整段,且紧跟在 Byte/Short → int 规整之后", () => {
    const s = generateGlueScript({ ...base, glueConfig: { glueVersion: "6.0" } }, mysqlDs, GOLDEN_BINDINGS);
    expect(s).toContain(COMPAT_LINE);
    expect(s).toContain('.cast("double")');
    expect(s.indexOf(COMPAT_LINE)).toBeGreaterThan(s.indexOf('.cast("int")'));
  });
  it("记录没存版本(存量任务)/ 5.1 / 4.0 ⇒ 不带(存量脚本逐字节不变)", () => {
    for (const glueConfig of [undefined, {}, { glueVersion: "5.1" }, { glueVersion: "4.0" }]) {
      const s = generateGlueScript({ ...base, ...(glueConfig ? { glueConfig } : {}) }, mysqlDs, GOLDEN_BINDINGS);
      expect(s, JSON.stringify(glueConfig)).not.toContain(COMPAT_LINE);
    }
  });
  it("非 MySQL 源 + 6.0 ⇒ 不带(PostgreSQL REAL 在 3.5 / 4.0 都是 FloatType,规整反而会改它的类型)", () => {
    const s = generateGlueScript({ ...base, glueConfig: { glueVersion: "6.0" } }, pgDs, GOLDEN_BINDINGS);
    expect(s).not.toContain(COMPAT_LINE);
  });
  it("6.0 的 MySQL 脚本在离线替身上原样跑通:2 行落进数仓表,兼容段不改任何值", () => {
    const script = generateGlueScript({ ...base, glueConfig: { glueVersion: "6.0" } }, mysqlDs, GOLDEN_BINDINGS);
    const o = runScript(script, { source: { players: { cols: ["id", "name"], rows: [{ id: 1, name: "a" }, { id: 2, name: "b" }] } } });
    expect(o.error).toBeNull();
    expect(o.rs["public.players"].rows.map((r) => String(r.id))).toEqual(["1", "2"]);
  });
});
