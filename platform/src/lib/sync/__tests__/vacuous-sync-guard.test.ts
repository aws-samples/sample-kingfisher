// @kf-batch 50-WP24b-vacuous-sync
// 🔴🔴 **空转成功**:同步任务的表清单为空时,Glue 作业一张表都不处理(日志 `SYNC RESULTS: {}`)、
// 作业自身 SUCCEEDED、平台把任务标成 **succeeded** —— 而数仓里连表都没建。
// 真环境实测(2026-09-17):建任务时把表清单写进了 `tables`(契约是 `sourceTables`),
// 而 `POST /api/sync` 是 `{...body}` **原样落库、零校验** ⇒ 落了一个注定空转的任务。
// 看板全绿、审计全绿、什么都没发生 —— 这比失败更坏。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { syncWorkRejection, normalizeSourceTables } from "@/lib/sync/task-shape";

// 🔴 剥注释要**按行**剥,不要用跨行正则:`/* … */` 的非贪婪匹配会被文件里别处的 `/*`
//   (字符串/URL 里也有)带偏,把真代码一起吃掉 —— 我刚用它把自己的判据搞成了假红。
const strip = (s: string) =>
  s
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("*/"));
    })
    .join("\n");
const read = (rel: string) => readFileSync(resolve(process.cwd(), "src", rel), "utf8");

describe("同步任务「有没有活可干」的单一作者", () => {
  it("表清单为空 / 缺字段 / 全是空白 ⇒ 一律给人话拒因(且点名字段名 sourceTables)", () => {
    for (const t of [{}, { sourceTables: [] }, { sourceTables: ["", "  "] }, { sourceTables: "players" },
                     { tables: ["players"] } as Record<string, unknown>]) {
      const r = syncWorkRejection(t as never);
      expect(r, JSON.stringify(t)).toBeTruthy();
      expect(r).toContain("sourceTables");
    }
  });

  it("有表但缺源库名 ⇒ 也拒(缺了同步作业无从下手)", () => {
    expect(syncWorkRejection({ sourceTables: ["players"] })).toContain("sourceDatabase");
  });

  it("表清单非空 + 有库名 ⇒ 放行(null)", () => {
    expect(syncWorkRejection({ sourceDatabase: "gamedata", sourceTables: ["players", " payments "] })).toBeNull();
  });

  it("归一:去空白去空串,非数组回空", () => {
    expect(normalizeSourceTables([" a ", "", "b", 3 as never])).toEqual(["a", "b"]);
    expect(normalizeSourceTables("a")).toEqual([]);
    expect(normalizeSourceTables(undefined)).toEqual([]);
  });
});

// @kf-batch 41-B123-sync-source-locator-by-paradigm
// 🔴 B-123(2026-10-25 页面驱动段 scq A1-2 真撞):S3 对象存储源经向导建任务 ⇒ 400「缺少源库名」——
//   「从哪读」原来只认 JDBC 的源库名;S3 / DynamoDB 源没有库名概念,定位在数据源连接袋里。
describe("B-123「从哪读」按数据源范式判(S3 / DynamoDB 源没有库名)", () => {
  const tables = { sourceTables: ["ad_campaigns"] };

  it("S3 对象存储源:连接袋有 bucket ⇒ 放行(不再要「源库名」)", () => {
    expect(syncWorkRejection(tables, { type: "s3", connection: { bucket: "bgp-datalake-x", prefix: "gamedata/", format: "auto" } })).toBeNull();
  });

  it("S3 源连接袋缺 bucket ⇒ 拒,拒因来自 provider 自己的 validateConfig(单一作者),不再点名 sourceDatabase", () => {
    const r = syncWorkRejection(tables, { type: "s3", connection: { prefix: "gamedata/" } });
    expect(r).toBeTruthy();
    expect(r).toContain("bucket");
    expect(r).not.toContain("sourceDatabase");
  });

  it("DynamoDB 源:连接袋有 tableName ⇒ 放行", () => {
    expect(syncWorkRejection(tables, { type: "dynamodb", connection: { tableName: "orders", region: "us-east-1" } })).toBeNull();
  });

  it("JDBC 源仍要源库名(行为逐字不变)", () => {
    expect(syncWorkRejection(tables, { type: "mysql", connection: { host: "h", port: 3306 } })).toContain("sourceDatabase");
    expect(syncWorkRejection({ ...tables, sourceDatabase: "gamedata" }, { type: "mysql" })).toBeNull();
  });

  it("数据源未知(没传 / 类型不认识)⇒ 按 JDBC 判(保守 = 原行为)", () => {
    expect(syncWorkRejection(tables)).toContain("sourceDatabase");
    expect(syncWorkRejection(tables, { type: "ftp" })).toContain("sourceDatabase");
  });

  it("🔴 三个调用点都把数据源行交给它(写了 ≠ 接上了)", () => {
    for (const rel of ["app/api/sync/route.ts", "app/api/sync/[id]/start/route.ts", "lib/backfill/sync-task.ts"]) {
      const src = strip(read(rel));
      // 调用形如 syncWorkRejection(task as { sourceDatabase?: unknown; sourceTables?: unknown }, ds):类型字面量里有分号,
      // 所以用「不含括号」而不是「不含分号」来圈住实参
      expect(src, rel).toMatch(/syncWorkRejection\([^()]*,\s*(dsRow|ds)\)/);
    }
  });
});

describe("🔴 三处都必须接上(写了 ≠ 接上了)", () => {
  it("POST /api/sync 落库前判", () => {
    const src = strip(read("app/api/sync/route.ts"));
    expect(src).toContain("syncWorkRejection(");
  });

  it("start 路由启动前判(存量任务可能就是空的)", () => {
    const src = strip(read("app/api/sync/[id]/start/route.ts"));
    expect(src).toContain("syncWorkRejection(");
  });

  it("生成的 Glue 脚本里兜一层:零表 raise(不许静默成功)", () => {
    const src = read("lib/sync/glue-script-generator.ts");
    expect(src).toContain("if not tables:");
    expect(src).toMatch(/raise Exception\("同步任务没有可同步的表/);
  });
});
