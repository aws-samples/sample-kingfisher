// 「不许静默清空客户已有的表」的判据(规则见 lib/sync/target-table-guard.ts 文件头)。
//
// 🔴 守卫的**本体在 Python 里**(Glue 脚本清表前那一段)⇒ 只比字符串证明不了它会拦。
//    这里从**真实生成**的脚本里切出守卫段,配一个按 SQL 内容作答的假 Redshift 客户端(不回自编值:
//    它查的是夹具里的「库中现有表 + 注释」),用 python3 真执行,逐情形看:拦没拦、拦之前有没有发过
//    任何 DELETE / CREATE、该打标记时打没打。另把整份脚本 py_compile 一遍(缩进 / 语法)。
import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateGlueScript, type GlueScriptBindings } from "@/lib/sync/glue-script-generator";
import { resolveGlueBinding } from "@/lib/exec-env/data-plane-target";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import type { DataSource } from "@/types/datasource";
import {
  clearsWholeTable, parseConfirmedTables, redshiftTargetTables, unconfirmedForeignTables,
  validateSyncWriteFields, PLATFORM_TABLE_MARKER,
} from "@/lib/sync/target-table-guard";
import { buildTargetDdl, TargetDdlRejected } from "@/lib/sync/target-ddl";

beforeEach(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCOUNT_ID = "123456789012";
});

const ds = { datasourceId: "ds1", name: "src", type: "x-fixture", secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:s-AbC", database: "gamedb" } as unknown as DataSource;
async function bindings(): Promise<GlueScriptBindings> {
  const landing = await resolveGlueBinding({ targetId: HOME_TARGET_ID });
  // 凭证 ARN 用真实形态(数仓落点以 PlaceWire 进脚本,生成期按 schema 自校验)
  return { landing, lakeCatalogAlias: "s3tablescatalog", rsb: { region: "us-east-1", workgroup: "wg", database: "dev", secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:wg-admin-AbC" } };
}
const task = (over: Record<string, unknown> = {}) => ({
  taskId: "t1", targetType: "redshift", sourceDatabase: "gamedb", sourceTables: ["Orders"],
  redshiftConfig: { schema: "public" }, syncMode: "full", writeMode: "overwrite", ...over,
});

describe("纯判定:与脚本里两条整表 DELETE 的条件逐字对齐", () => {
  it.each([
    [{ syncMode: "full", writeMode: "overwrite" }, true],
    [{ syncMode: "full", writeMode: "append" }, false],
    [{ syncMode: "full", writeMode: "merge" }, false],
    [{ syncMode: "incremental", writeMode: "merge" }, false], // 增量 + merge 走 merge 分支,不预删不清表
    [{ syncMode: "incremental", writeMode: "merge", incrementalColumn: "id" }, false],
    [{ syncMode: "incremental", writeMode: "append" }, true], // 没有增量列 ⇒ inc_where 空 ⇒ 整表清空
    [{ syncMode: "incremental", incrementalColumn: "id" }, true], // 有列无水位 ⇒ 整表清空
    [{ syncMode: "incremental", incrementalColumn: "id", incrementalValue: 0 }, false],
    [{ syncMode: "incremental", incrementalColumn: "id", incrementalValue: "2026-01-01" }, false],
  ])("%j ⇒ 整表清空=%s", (t, want) => {
    expect(clearsWholeTable(t as never)).toBe(want);
  });

  it("目标表名与脚本同规则(小写 + 安全化 + 前后缀)", () => {
    expect(redshiftTargetTables(task() as never)).toEqual(["public.orders"]);
    expect(redshiftTargetTables(task({ targetTablePrefix: "ods_", sourceTables: ["a-b"] }) as never)).toEqual(["public.ods_a_b"]);
    expect(() => redshiftTargetTables(task({ redshiftConfig: { schema: "x;drop" } }) as never)).toThrow();
  });

  it("确认清单只收 schema.table 形态;其余 400", () => {
    expect(parseConfirmedTables(undefined)).toEqual([]);
    expect(parseConfirmedTables(["public.b", "public.a", "public.a"])).toEqual(["public.a", "public.b"]);
    for (const bad of ["public.a", ["Public.A"], ["a"], ["public.a'; drop"], [1]]) {
      expect(() => parseConfirmedTables(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("只有「已存在 ∧ 非平台建 ∧ 未确认」的表要确认", () => {
    const st = [
      { fq: "public.a", exists: true, platformCreated: false },
      { fq: "public.b", exists: true, platformCreated: true },
      { fq: "public.c", exists: false, platformCreated: false },
      { fq: "public.d", exists: true, platformCreated: false },
    ];
    expect(unconfirmedForeignTables(st, ["public.d"])).toEqual(["public.a"]);
  });

  it("writeMode 没有缺省:非实时缺它 ⇒ 拒;实时(DMS 不用它)放行;非法确认清单 ⇒ 拒", () => {
    expect(validateSyncWriteFields({ syncMode: "full" })).toMatch(/writeMode 必填/);
    expect(validateSyncWriteFields({ syncMode: "full", writeMode: "overwrite " })).toMatch(/writeMode 必填/);
    expect(validateSyncWriteFields({ syncMode: "realtime" })).toBeNull();
    expect(validateSyncWriteFields({ syncMode: "incremental", channel: "dms" })).toBeNull();
    expect(validateSyncWriteFields({ syncMode: "full", channel: "zero-etl" })).toBeNull();
    expect(validateSyncWriteFields({ syncMode: "full", channel: "glue" })).toMatch(/writeMode 必填/);
    expect(validateSyncWriteFields({ syncMode: "full", writeMode: "append" })).toBeNull();
    expect(validateSyncWriteFields({ syncMode: "full", writeMode: "append", overwriteConfirmedTables: ["x"] })).toMatch(/schema\.table/);
  });
});

describe("生成器:不再替用户选 overwrite", () => {
  it("缺 writeMode / 非法 writeMode ⇒ 拒绝生成(不缺省成整表清空)", async () => {
    const b = await bindings();
    expect(() => generateGlueScript(task({ writeMode: undefined }), ds, b)).toThrow(/writeMode/);
    expect(() => generateGlueScript(task({ writeMode: "replace" }), ds, b)).toThrow(/writeMode/);
  });
  it("非法 schema 进不了脚本(原来原样拼进 Python 字符串)", async () => {
    const b = await bindings();
    expect(() => generateGlueScript(task({ redshiftConfig: { schema: 'p"; import os; "' } }), ds, b)).toThrow();
  });
  it("整份脚本 py_compile 通过(守卫段的缩进 / 语法)", async () => {
    const b = await bindings();
    for (const t of [task(), task({ writeMode: "append" }), task({ syncMode: "incremental", incrementalColumn: "id" })]) {
      const dir = mkdtempSync(join(tmpdir(), "kf-ttg-"));
      const py = join(dir, "s.py");
      writeFileSync(py, generateGlueScript(t, ds, b), "utf8");
      execFileSync("python3", ["-m", "py_compile", py], { encoding: "utf8" });
    }
  });
});

// ── 守卫段真执行 ─────────────────────────────────────────────────────────────
const BEGIN = "# 🔴 生产上线批次 A:**不许静默清空客户已有的表**";
const END = 'print(f"SYNC_TABLE_MARKED table={_rs_fq}")';
function guardBlock(script: string): string {
  const i = script.indexOf(BEGIN);
  const j = script.indexOf(END, i);
  if (i < 0 || j < 0) throw new Error("脚本里找不到守卫段(格式变了要改这里,不许静默跳过)");
  const lines = script.slice(i, j + END.length).split("\n");
  const indent = (lines[0].match(/^\s*/) || [""])[0].length || (script.slice(0, i).split("\n").pop() || "").length;
  return lines.map((l) => l.slice(Math.min(indent, l.length - l.trimStart().length))).join("\n");
}

// 守卫段现在经真实的 run_stmt / run_batch / _query_rows(含瞬态重试)打 Data API ⇒ 把脚本里那一段助手也切出来一起真执行,
//   假客户端只扮 Data API(execute / batch_execute / describe / get_statement_result),不再在夹具里另写一份 run_stmt。
const HELPERS_BEGIN = '_last_err = {"msg": ""}';
const HELPERS_END = "def _is_concurrent_schema_create(err):";
function helpersBlock(script: string): string {
  const i = script.indexOf(HELPERS_BEGIN);
  const j = script.indexOf(HELPERS_END, i);
  if (i < 0 || j < 0) throw new Error("脚本里找不到 Data API 助手段(格式变了要改这里,不许静默跳过)");
  const lines = script.slice(i, j).split("\n");
  const indent = (lines[0].match(/^\s*/) || [""])[0].length || (script.slice(0, i).split("\n").pop() || "").length;
  return lines.map((l) => l.slice(Math.min(indent, l.length - l.trimStart().length))).join("\n");
}

type Case = { existing: Record<string, string>; incremental?: boolean; incWhere?: string };
function runGuard(script: string, c: Case): { raised: string | null; stmts: string[]; batches: string[][] } {
  const dir = mkdtempSync(join(tmpdir(), "kf-ttg-run-"));
  const py = join(dir, "g.py");
  const harness = `
import json, re, sys, time
time.sleep = lambda _s: None
EXISTING = json.loads(sys.argv[1])   # {"schema.table": "注释"} —— 夹具里「库中现有表」
STMTS = []
BATCHES = []   # 每次 batch_execute_statement(一个事务)里的语句清单
class FakeRs:
    def __init__(self): self._q = {}
    def execute_statement(self, **kw):
        sql = kw["Sql"]; STMTS.append(sql); sid = str(len(STMTS)); self._q[sid] = sql
        return {"Id": sid}
    def batch_execute_statement(self, **kw):
        sqls = list(kw["Sqls"]); STMTS.extend(sqls); BATCHES.append(sqls); sid = "b" + str(len(BATCHES)); self._q[sid] = sqls[0]
        return {"Id": sid}
    def describe_statement(self, Id):
        return {"Status": "FINISHED", "HasResultSet": self._q[Id].lstrip().upper().startswith("SELECT")}
    def get_statement_result(self, Id):
        sql = self._q[Id]
        m = re.search(r"n\\.nspname = '([^']+)' AND c\\.relname = '([^']+)'", sql)
        fq = f"{m.group(1)}.{m.group(2)}" if m else None
        if fq in EXISTING: return {"Records": [[{"stringValue": EXISTING[fq]}]]}
        return {"Records": []}
rs_client = FakeRs()
rs_workgroup = "wg"; rs_database = "dev"; RS_ADMIN_SECRET_ARN = "arn:secret"
rs_schema = "public"; target_name = "orders"; rs_table = "public.orders"
col_defs = "id INTEGER"; _rs_clause = ""
INCREMENTAL = ${c.incremental ? "True" : "False"}; inc_where = ${JSON.stringify(c.incWhere || "")}
raised = None
try:
${helpersBlock(script).split("\n").map((l) => "    " + l).join("\n")}
${guardBlock(script).split("\n").map((l) => "    " + l).join("\n")}
except Exception as e:
    raised = str(e)
print(json.dumps({"raised": raised, "stmts": STMTS, "batches": BATCHES}))
`;
  writeFileSync(py, harness, "utf8");
  return JSON.parse(execFileSync("python3", [py, JSON.stringify(c.existing)], { encoding: "utf8" }).trim().split("\n").pop()!);
}

/** 瞬态重试判据:outcomes = 每次提交(execute / batch_execute)后 describe 回什么 —— "ok" / "io"(连接层瞬态)/ "perm"(权限)。 */
function runHelpers(script: string, outcomes: string[], mode: "stmt" | "batch"): { raised: string | null; executes: number } {
  const dir = mkdtempSync(join(tmpdir(), "kf-ttg-helpers-"));
  const py = join(dir, "h.py");
  const harness = `
import json, sys, time
time.sleep = lambda _s: None
OUTCOMES = json.loads(sys.argv[1]); MODE = sys.argv[2]
CALLS = {"n": 0}
class FakeRs:
    def _next(self):
        o = OUTCOMES[min(CALLS["n"], len(OUTCOMES) - 1)]; CALLS["n"] += 1; return o
    def execute_statement(self, **kw): return {"Id": self._next()}
    def batch_execute_statement(self, **kw): return {"Id": self._next()}
    def describe_statement(self, Id):
        if Id == "ok": return {"Status": "FINISHED"}
        if Id == "io": return {"Status": "FAILED", "Error": "An I/O error occurred while sending to the backend."}
        return {"Status": "FAILED", "Error": "ERROR: permission denied for schema showcase"}
rs_client = FakeRs()
rs_workgroup = "wg"; rs_database = "dev"; RS_ADMIN_SECRET_ARN = "arn:secret"
raised = None
${helpersBlock(script)}
try:
    if MODE == "stmt":
        run_stmt("COMMENT ON TABLE public.orders IS 'x'", "COMMENT(platform marker)")
    else:
        run_batch(["CREATE TABLE IF NOT EXISTS public.orders (id INTEGER)", "COMMENT ON TABLE public.orders IS 'x'"], "DDL+COMMENT(platform marker)")
except Exception as e:
    raised = str(e)
print(json.dumps({"raised": raised, "executes": CALLS["n"]}))
`;
  writeFileSync(py, harness, "utf8");
  return JSON.parse(execFileSync("python3", [py, JSON.stringify(outcomes), mode], { encoding: "utf8" }).trim().split("\n").pop()!);
}
const mutating = (stmts: string[]) => stmts.filter((s) => /^\s*(DELETE|CREATE|DROP|TRUNCATE|COMMENT|INSERT)/i.test(s));

describe("🔴🔴 守卫段真执行(python3):清空客户已有的表之前拦下", () => {
  it("overwrite + 已存在且**无平台标记**的表 + 未确认 ⇒ 拒绝,且拒绝前**零写语句**", async () => {
    const s = generateGlueScript(task(), ds, await bindings());
    const r = runGuard(s, { existing: { "public.orders": "" } });
    expect(r.raised).toMatch(/SYNC_REFUSED_CLEAR_FOREIGN_TABLE table=public\.orders/);
    expect(mutating(r.stmts)).toEqual([]);
  });
  it("别的注释(客户自己写的)不算平台标记 ⇒ 照样拒", async () => {
    const s = generateGlueScript(task(), ds, await bindings());
    expect(runGuard(s, { existing: { "public.orders": "客户订单表" } }).raised).toMatch(/SYNC_REFUSED/);
  });
  it("正控制①:平台建的表(带标记)⇒ 放行,且**不重复打标记**(建表语句走单条,不开事务)", async () => {
    const s = generateGlueScript(task(), ds, await bindings());
    const r = runGuard(s, { existing: { "public.orders": PLATFORM_TABLE_MARKER } });
    expect(r.raised).toBeNull();
    expect(mutating(r.stmts).some((x) => /^COMMENT/i.test(x))).toBe(false);
    expect(mutating(r.stmts).some((x) => /^CREATE TABLE IF NOT EXISTS public\.orders/.test(x))).toBe(true);
    expect(r.batches).toEqual([]);
  });
  it("正控制②:用户已逐表确认 ⇒ 放行(确认清单真进了脚本)", async () => {
    const s = generateGlueScript(task({ overwriteConfirmedTables: ["public.orders"] }), ds, await bindings());
    expect(runGuard(s, { existing: { "public.orders": "" } }).raised).toBeNull();
  });
  it("确认的是**别的**表 ⇒ 不放行这一张", async () => {
    const s = generateGlueScript(task({ overwriteConfirmedTables: ["public.other"] }), ds, await bindings());
    expect(runGuard(s, { existing: { "public.orders": "" } }).raised).toMatch(/SYNC_REFUSED/);
  });
  it("表不存在 ⇒ 建表 + 打平台标记在**同一个事务**里(标记打不上就连表也不留,不再先建后标两条语句)", async () => {
    const s = generateGlueScript(task(), ds, await bindings());
    const r = runGuard(s, { existing: {} });
    expect(r.raised).toBeNull();
    const m = mutating(r.stmts);
    expect(m[0]).toMatch(/^CREATE TABLE IF NOT EXISTS public\.orders/);
    expect(m[1]).toBe(`COMMENT ON TABLE public.orders IS '${PLATFORM_TABLE_MARKER}'`);
    expect(r.batches).toEqual([[m[0], m[1]]]);
  });
  it("append(不整表清空)⇒ 已有的客户表也放行(只追加,不删)", async () => {
    const s = generateGlueScript(task({ writeMode: "append" }), ds, await bindings());
    expect(runGuard(s, { existing: { "public.orders": "" } }).raised).toBeNull();
  });
  it("增量但水位为空(整表清空那条路)⇒ 同样拦;有水位(只删区间)⇒ 放行", async () => {
    const s = generateGlueScript(task({ syncMode: "incremental", writeMode: "append", incrementalColumn: "id" }), ds, await bindings());
    expect(runGuard(s, { existing: { "public.orders": "" }, incremental: true, incWhere: "" }).raised).toMatch(/SYNC_REFUSED/);
    expect(runGuard(s, { existing: { "public.orders": "" }, incremental: true, incWhere: "id > 5" }).raised).toBeNull();
  });
});

describe("建表唯一作者 buildTargetDdl:服务端现生成,不信客户端", () => {
  it("表名与脚本同规则(Orders ⇒ public.orders),DDL 用同一个全名", () => {
    const d = buildTargetDdl({ tableName: "Orders", columns: [{ name: "id", type: "int" }] });
    expect(d.fq).toBe("public.orders");
    expect(d.ddl).toMatch(/^CREATE TABLE IF NOT EXISTS public\.orders \(/);
  });
  it("列名注入 ⇒ 拒;中文列名 ⇒ 放行", () => {
    expect(() => buildTargetDdl({ tableName: "t", columns: [{ name: "a int); DROP TABLE x; --", type: "int" }] })).toThrow(TargetDdlRejected);
    expect(() => buildTargetDdl({ tableName: "t", columns: [{ name: "金额", type: "int" }] })).not.toThrow();
  });
  it("非法 schema ⇒ 拒", () => {
    expect(() => buildTargetDdl({ tableName: "t", columns: [{ name: "a", type: "int" }], redshiftConfig: { schema: "a.b" } })).toThrow(TargetDdlRejected);
  });
});

// ──:Data API 连接层瞬态错**有界**重试,且只认连接层签名(真执行脚本里的 run_stmt / run_batch;假客户端只扮 Data API)──
describe("🔴 Redshift Data API 瞬态错重试有界、只认连接层签名", () => {
  it("COMMENT 第一次撞「I/O error occurred while sending to the backend」⇒ 重试一次成功(两次提交、不抛)", async () => {
    const s = generateGlueScript(task(), ds, await bindings());
    expect(runHelpers(s, ["io", "ok"], "stmt")).toEqual({ raised: null, executes: 2 });
  });
  it("连续瞬态错 ⇒ 最多 3 次提交后如实抛(不无限重试、不吞)", async () => {
    const s = generateGlueScript(task(), ds, await bindings());
    const r = runHelpers(s, ["io", "io", "io", "ok"], "stmt");
    expect(r.raised).toMatch(/COMMENT\(platform marker\) failed: .*I\/O error/);
    expect(r.executes).toBe(3);
  });
  it("权限被拒不是瞬态 ⇒ 一次提交即抛(不回到「每批都重试」的老病)", async () => {
    const s = generateGlueScript(task(), ds, await bindings());
    const r = runHelpers(s, ["perm", "ok"], "stmt");
    expect(r.raised).toMatch(/permission denied/);
    expect(r.executes).toBe(1);
  });
  it("建表 + 打标记的事务(batch)同样只在瞬态签名上重试", async () => {
    const s = generateGlueScript(task(), ds, await bindings());
    expect(runHelpers(s, ["io", "ok"], "batch")).toEqual({ raised: null, executes: 2 });
    const perm = runHelpers(s, ["perm"], "batch");
    expect(perm.raised).toMatch(/DDL\+COMMENT\(platform marker\) failed: .*permission denied/);
    expect(perm.executes).toBe(1);
  });
});
