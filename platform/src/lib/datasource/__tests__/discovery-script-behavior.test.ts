// 数据源表发现脚本的**行为**判据:平台生成的 PySpark 脚本原样丢进离线替身(discovery-harness.py,
//   假 awsglue / pyspark / boto3)真跑,断**结果 JSON**(表 / 列顺序 / 可空 / 缺省 schema 去前缀 / 结果落点 / 用了哪份 secret),
//   以及库名护栏真拒。它是 infra/prod-only-layers.json 里 `codegen:platform/src/lib/datasource/glue-reach.ts` 那一层的替身。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDiscoveryScript } from "@/lib/datasource/glue-reach";

const HARNESS = join(__dirname, "discovery-harness.py");
const SECRET_ARN = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:bgp-ds-x-AbCdEf";
const RESULT_URI = "s3://bgp-glue-scripts-123456789012/discover/01DS/gamedb.json";

type Row = { tbl_schema: string; tbl_name: string; col_name: string; col_type: string; col_nullable: string; col_key: string; col_comment: string; col_pos: number };
function run(dbType: string, rows: Row[], over: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kf-discovery-"));
  const script = buildDiscoveryScript({ dbType, jdbcUrl: `jdbc:${dbType}://db.cust.internal:3306/gamedb`, driverClass: "com.example.Driver", secretArn: SECRET_ARN, region: "ap-southeast-1" });
  writeFileSync(join(dir, "script.py"), script);
  const cfg = {
    script: join(dir, "script.py"),
    args: { JOB_NAME: "bgp-ds-discover-x", result_uri: RESULT_URI, database: "gamedb" },
    secret: { username: "svc_user", password: "p@ss" },
    rows,
    ...over,
  };
  const cp = join(dir, "cfg.json");
  writeFileSync(cp, JSON.stringify(cfg));
  return JSON.parse(execFileSync("python3", [HARNESS, cp], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
}
const row = (p: Partial<Row>): Row => ({ tbl_schema: "", tbl_name: "t", col_name: "c", col_type: "int", col_nullable: "NO", col_key: "", col_comment: "", col_pos: 1, ...p });

describe("发现脚本(替身真跑)", () => {
  it("MySQL:两张表、列按 ordinal 排序、可空 YES/NO → 布尔、主键 / 备注透传;结果写到 --result_uri 指的桶 / 键;secret 与 JDBC 三样来自平台生成期", () => {
    const r = run("mysql", [
      row({ tbl_schema: "gamedb", tbl_name: "players", col_name: "name", col_type: "varchar(32)", col_nullable: "YES", col_pos: 2, col_comment: "昵称" }),
      row({ tbl_schema: "gamedb", tbl_name: "players", col_name: "id", col_type: "int", col_nullable: "NO", col_key: "PRI", col_pos: 1 }),
      row({ tbl_schema: "gamedb", tbl_name: "ad_channels", col_name: "ch", col_type: "varchar(8)", col_nullable: "YES", col_pos: 1 }),
    ]);
    expect(r.exit, r.error).toBe(0);
    expect(r.secret_ids).toEqual([SECRET_ARN]);
    expect(r.jdbc).toMatchObject({ url: "jdbc:mysql://db.cust.internal:3306/gamedb", driver: "com.example.Driver", user: "svc_user", password: "p@ss" });
    expect(String(r.jdbc.dbtable)).toContain("INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'gamedb'");
    expect(String(r.jdbc.dbtable)).not.toContain("__DB__");
    expect(r.puts).toHaveLength(1);
    expect(r.puts[0]).toMatchObject({ Bucket: "bgp-glue-scripts-123456789012", Key: "discover/01DS/gamedb.json", ContentType: "application/json" });
    const body = r.puts[0].Body;
    expect(body.database).toBe("gamedb");
    expect(body.via).toBe("glue-discovery");
    expect(body.tables.map((t: any) => t.name)).toEqual(["ad_channels", "players"]);
    const players = body.tables.find((t: any) => t.name === "players");
    expect(players.columns).toEqual([
      { name: "id", type: "int", nullable: false, key: "PRI", comment: "" },
      { name: "name", type: "varchar(32)", nullable: true, key: "", comment: "昵称" },
    ]);
    expect(r.client_regions).toEqual({ secretsmanager: "ap-southeast-1", s3: "ap-southeast-1" });
    expect(r.stdout).toContain("DISCOVERY_DONE tables=2");
  });
  it("PostgreSQL:public 的表不带前缀,别的 schema 带 schema. 前缀(与 SPI introspect 同一口径)", () => {
    const r = run("postgresql", [
      row({ tbl_schema: "public", tbl_name: "orders", col_name: "id", col_type: "integer", col_nullable: "NO" }),
      row({ tbl_schema: "sales", tbl_name: "orders", col_name: "id", col_type: "integer", col_nullable: "NO" }),
    ]);
    expect(r.exit, r.error).toBe(0);
    expect(r.puts[0].Body.tables.map((t: any) => t.name)).toEqual(["orders", "sales.orders"]);
    expect(String(r.jdbc.dbtable)).toContain("table_schema NOT IN ('pg_catalog','information_schema')");
  });
  it("SQL Server:dbo 不带前缀,hr.emp 带;Oracle:NULLABLE Y/N → 布尔", () => {
    const s = run("sqlserver", [
      row({ tbl_schema: "dbo", tbl_name: "t1", col_name: "a", col_nullable: "YES" }),
      row({ tbl_schema: "hr", tbl_name: "emp", col_name: "a", col_nullable: "NO" }),
    ]);
    expect(s.exit, s.error).toBe(0);
    expect(s.puts[0].Body.tables.map((t: any) => t.name)).toEqual(["hr.emp", "t1"]);
    const o = run("oracle", [row({ tbl_schema: "APP", tbl_name: "T", col_name: "A", col_nullable: "Y" }), row({ tbl_schema: "APP", tbl_name: "T", col_name: "B", col_nullable: "N", col_pos: 2 })]);
    expect(o.exit, o.error).toBe(0);
    expect(o.puts[0].Body.tables[0].columns.map((c: any) => c.nullable)).toEqual([true, false]);
    // Oracle 只读登录用户自己的 schema(WHERE OWNER = USER,与 SPI introspect 同口径)⇒ 表名不带 schema 前缀
    expect(o.puts[0].Body.tables[0].name).toBe("T");
  });
  it("库名护栏:带分号 / 引号的 --database 在脚本里被拒(非零退出),不发 JDBC、不写结果", () => {
    const r = run("mysql", [], { args: { JOB_NAME: "j", result_uri: RESULT_URI, database: "x'; DROP TABLE t; --" } });
    expect(r.exit).not.toBe(0);
    expect(r.error).toContain("illegal database name");
    expect(r.jdbc).toEqual({});
    expect(r.puts).toEqual([]);
  });
  it("JDBC 读失败 ⇒ 非零退出且不写结果(不留一份空表清单冒充成功)", () => {
    const r = run("mysql", [], { fail_jdbc: "Communications link failure" });
    expect(r.exit).not.toBe(0);
    expect(r.error).toContain("Communications link failure");
    expect(r.puts).toEqual([]);
  });
  it("源库真的一张表都没有 ⇒ 成功写出 tables=[](空是真话,交由平台页面说明)", () => {
    const r = run("mysql", []);
    expect(r.exit, r.error).toBe(0);
    expect(r.puts[0].Body.tables).toEqual([]);
  });
});
