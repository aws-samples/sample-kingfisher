// 数据湖表桶路由(设计稿 §6.5.3)—— 同步任务 Glue 脚本里 S3 Tables 目录段用**任务写的那条路由的别名**(提交前门禁,不是验收)。
//
// 【缺陷原形】脚本写死 `s3tablescatalog.<ns>.<表>`,客户自有表桶只能靠「把那只桶当平台桶」;路由起每桶一个目录,脚本必须按别名写三段名。
// 【判什么】① 别名 agg ⇒ `S3T_CATALOG = "agg"` 与 `s3t_table = f"agg.{S3T_NAMESPACE}.{target_name}"`;② 与平台别名脚本的差异**只有**含别名的那两行(别名是唯一变量);
//   ③ 非法别名 ⇒ 抛(不猜);④ 接线:start-run 把 effectiveLakeRoute 的别名传进生成器。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateGlueScript, type GlueScriptBindings } from "@/lib/sync/glue-script-generator";
import type { DataSource } from "@/types/datasource";

const jdbcDs = { datasourceId: "ds_jdbc", name: "src", type: "x-fixture", secretArn: "arn:aws:secretsmanager:us-west-2:123456789012:secret:src-AbC", database: "gamedb" } as unknown as DataSource;
const task = { taskId: "t_fixture_0001", targetType: "s3-tables", sourceDatabase: "gamedb", sourceTables: ["players"], s3Config: { namespace: "gamedb", tableBucket: "cust-agg" }, syncMode: "full", writeMode: "overwrite" };
const bind = (lakeCatalogAlias: string): GlueScriptBindings => ({
  landing: { targetId: "tgt_usw2_a", region: "us-west-2", datalakeBucket: "bgp-datalake-123456789012-usw2a", tableBucket: "bgp-table-bucket-usw2a" },
  rsb: null,
  lakeCatalogAlias,
});
const codeOnly = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("#"));

describe("同步脚本的目录别名", () => {
  it("🔴 别名 agg ⇒ S3T_CATALOG 与三段名目录段都是 agg;代码行里不再出现 s3tablescatalog 目录段", () => {
    const s = generateGlueScript(task, jdbcDs, bind("agg"));
    expect(s).toContain('S3T_CATALOG = "agg"');
    expect(s).toContain('s3t_table = f"agg.{S3T_NAMESPACE}.{target_name}"');
    expect(codeOnly(s).join("\n")).not.toContain('S3T_CATALOG = "s3tablescatalog"');
    expect(codeOnly(s).join("\n")).not.toMatch(/f"s3tablescatalog\./);
  });
  it("与平台别名脚本逐行 diff:只差含别名的那 2 行(别名是脚本里唯一跟着路由变的东西)", () => {
    const a = generateGlueScript(task, jdbcDs, bind("agg")).split("\n");
    const b = generateGlueScript(task, jdbcDs, bind("s3tablescatalog")).split("\n");
    expect(a.length).toBe(b.length);
    const diff = a.map((l, i) => [l, b[i]] as const).filter(([x, y]) => x !== y);
    expect(diff.map(([x]) => x.trim())).toEqual(['S3T_CATALOG = "agg"', 's3t_table = f"agg.{S3T_NAMESPACE}.{target_name}"']);
    for (const [x, y] of diff) expect(y).toBe(x.replace(/"agg/g, '"s3tablescatalog'));
  });
  it("非法别名(大写 / 空 / 带点)⇒ 抛「lakeCatalogAlias 不合法」,不生成半截脚本", () => {
    for (const bad of ["Agg", "", "a.b", "1abc"]) expect(() => generateGlueScript(task, jdbcDs, bind(bad)), bad).toThrow(/lakeCatalogAlias 不合法/);
  });
  it("接线:start-run 调生成器时传 lakeRoute.alias(effectiveLakeRoute 给出的路由),不传字面", () => {
    const src = readFileSync(resolve(__dirname, "..", "start-run.ts"), "utf8");
    expect(src).toContain("generateGlueScript(task, ds as DataSource, { landing, rsb, lakeCatalogAlias: lakeRoute.alias })");
    expect(src).not.toMatch(/lakeCatalogAlias:\s*"/);
  });
});
