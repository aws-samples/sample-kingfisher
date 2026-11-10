// 2026-11-09 公开仓代码扫描抓到 7 处「用户可控文本上的多项式回溯正则」。这里钉两件事:
//   ① 改后的扫描在恶意长输入上线性(预算内返回;改前的正则在同样输入上要跑分钟级,等于 DoS 面);
//   ② 语义与改前逐字一致(把改前的正则原样留在判据里当对照,合法样本两边必须等价)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stripSqlComments } from "@/lib/genbi/core/sql-comments";
import { splitGlueConfValue } from "@/lib/lake/routes";
import { mapColumnType } from "@/lib/sync/sync-service";
import { templateVarNames, renderSyncTemplate } from "@/lib/sync/run-vars";
import { normalizeRoleName } from "@/lib/role-advisor/policy-builder";
import { escapeRegExp } from "@/lib/text/escape-regexp";
import { engineBaseline, type RoleEngine } from "@/lib/role-advisor/engine-baseline";

const BUDGET_MS = 1500;
function timed<T>(fn: () => T): { out: T; ms: number } {
  const t = performance.now();
  const out = fn();
  return { out, ms: performance.now() - t };
}
const SRC = (p: string) => readFileSync(resolve(process.cwd(), "src", p), "utf8");

describe("SQL 注释剥除(问数只读闸与血缘共用的唯一作者)", () => {
  const legacy = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n\r]*/g, " ");
  const samples = [
    "SELECT 1 /* c */ FROM t",
    "/* a */ SELECT /* b */ 2",
    "SELECT 1 -- tail\nFROM t",
    "SELECT 1 /* open",
    "/* x */ -- y\r\nSELECT 3",
    "SELECT '/*' FROM t */",
    "",
    "/**/",
    "SELECT 1 /* a /* b */ c */",
    "-- only a comment",
    "SELECT 1 /* a */ /* b */ FROM t -- z",
  ];
  it("合法样本与改前正则逐字等价", () => {
    for (const s of samples) expect(stripSqlComments(s), JSON.stringify(s)).toBe(legacy(s));
  });
  it("恶意输入(反复 `/*` 不闭合)线性返回", () => {
    const evil = "/*a".repeat(60000);
    const { out, ms } = timed(() => stripSqlComments(evil));
    expect(out).toBe(evil); // 没闭合 ⇒ 原样保留(与改前一致)
    expect(ms).toBeLessThan(BUDGET_MS);
  });
  it("两处调用点都只用这一份(源码里不再各自写块注释正则)", () => {
    for (const f of ["lib/genbi/core/sql-guard.ts", "lib/lineage/sql-lineage.ts"]) {
      const src = SRC(f);
      expect(src, f).toContain("stripSqlComments");
      expect(src, `${f} 仍有自己的块注释正则`).not.toMatch(/\\\/\\\*\[\\s\\S\]\*\?/);
    }
  });
});

describe("Glue --conf 参数值切分", () => {
  const legacy = (v: string) => v.split(/\s+--conf\s+/).map((s) => s.trim()).filter(Boolean);
  it("合法样本与改前逐字等价", () => {
    for (const s of ["a=1 --conf b=2   --conf   c=3 ", "a=1", "", "   ", "x=--conf", "a=1\n--conf\tb=2", "k=v --conf spark.x=1 --conf spark.y=2"]) {
      expect(splitGlueConfValue(s), JSON.stringify(s)).toEqual(legacy(s));
    }
  });
  it("边角(改前靠空白两侧匹配,句首 / 句尾的 `--conf` 现在也当分隔符)", () => {
    expect(splitGlueConfValue("--conf a=1")).toEqual(["a=1"]);
    expect(splitGlueConfValue("a=1 --conf")).toEqual(["a=1"]);
  });
  it("恶意输入(二十万个空格)线性返回", () => {
    const { out, ms } = timed(() => splitGlueConfValue(" ".repeat(200000) + "x=1"));
    expect(out).toEqual(["x=1"]);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});

describe("源列类型映射里的括号段剥除", () => {
  it("长度 / 精度照旧保留", () => {
    expect(mapColumnType("mysql", "decimal(10,2)")).toEqual({ targetType: "DECIMAL(10,2)", compatibility: "compatible" });
    expect(mapColumnType("mysql", "VARCHAR(255)")).toEqual({ targetType: "VARCHAR(255)", compatibility: "compatible" });
    expect(mapColumnType("mysql", "int(11)").targetType).toBe("INTEGER");
    expect(mapColumnType("mysql", "decimal (10, 2)").targetType).toBe("DECIMAL");
  });
  it("恶意输入(十万个左括号)线性返回", () => {
    const { ms } = timed(() => mapColumnType("mysql", "(".repeat(100000) + "int"));
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});

describe("同步运行变量 ${…} 文法", () => {
  it("合法变量照旧解析 / 渲染", () => {
    expect(templateVarNames("d >= '${ds}' and m = '${ds_nodash}'")).toEqual(["ds", "ds_nodash"]);
    expect(renderSyncTemplate("d = '${ds}'", "2026-01-15")).toBe("d = '2026-01-15'");
  });
  it("变量名里夹 `{` / `$` 不再被当成变量名,而是按「写法不完整」拒绝", () => {
    expect(templateVarNames("x ${a{b}")).toEqual([]);
    expect(() => renderSyncTemplate("x ${a{b}", "2026-01-15")).toThrow(/不完整/);
    expect(() => renderSyncTemplate("x ${ds", "2026-01-15")).toThrow(/不完整/);
  });
  it("恶意输入(十万个 `${`)线性返回", () => {
    const { out, ms } = timed(() => templateVarNames("${".repeat(100000)));
    expect(out).toEqual([]);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});

describe("角色名规范化的首尾 `-` 剥除", () => {
  it("语义不变:去首尾横线、受控前缀、空则用引擎名", () => {
    expect(normalizeRoleName("--my-role--", "glue")).toBe("bgp-job-role-my-role");
    expect(normalizeRoleName("", "emr")).toBe("bgp-job-role-emr");
    expect(normalizeRoleName("bgp-job-role-x", "glue")).toBe("bgp-job-role-x");
    expect(normalizeRoleName("a b/c", "dms")).toBe("bgp-job-role-abc");
  });
  it("恶意输入(二十万个横线)线性返回", () => {
    const { out, ms } = timed(() => normalizeRoleName("-".repeat(200000) + "x", "glue"));
    expect(out).toBe("bgp-job-role-x");
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});

describe("正则字面量转义唯一作者", () => {
  it("全部元字符与反斜杠都转义:转义后的式子只匹配它自己", () => {
    const s = ".*+?^${}()|[]\\/-ab$c";
    expect(new RegExp(`^${escapeRegExp(s)}$`).test(s)).toBe(true);
    expect(new RegExp(escapeRegExp("a.b")).test("axb")).toBe(false);
    expect(new RegExp(escapeRegExp("set$Foo(")).test("x set$Foo( y")).toBe(true);
  });
});

describe("引擎基线 CloudWatch 探针资源", () => {
  it("日志组通配段全部替换(不是只换第一个 `*`)", () => {
    const ctx = { region: "us-east-1", accountId: "123456789012", logBucket: "bgp-datalake-123456789012", scriptBucket: "bgp-glue-scripts-123456789012" };
    for (const engine of ["glue", "emr", "flink", "dms"] as RoleEngine[]) {
      const need = engineBaseline(engine, ctx).find((n) => n.sid === "BaselineCloudWatchLogs");
      expect(need?.probe?.resource, engine).toMatch(/:log-group:[^*]+:\*$/);
    }
  });
});
