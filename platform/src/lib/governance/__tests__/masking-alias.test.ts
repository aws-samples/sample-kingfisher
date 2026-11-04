// 结果列有别名 / 是表达式时,脱敏仍要按物理列的分级生效。
// 只 mock 真外部(DynamoDB 文档客户端);分级读取 classification.ts 与 SQL 解析 sql-lineage.ts 都走真实现。
// 判据钉事实:哪些值被遮、maskedColumns 报的是**结果列名**(前端据此提示「可申请访问」)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = {
  classifications: [] as Array<{ fqn: string; column: string; level: string; maskStrategy: string }>,
  grants: [] as Array<{ username: string; fqn: string }>,
  queries: [] as Array<{ table: string; values: Record<string, unknown> }>,
};

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { DATA_CLASSIFICATION: "bgp-data-classification", DATA_GRANTS: "bgp-data-grants" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const input = cmd.input || {};
      state.queries.push({ table: input.TableName, values: input.ExpressionAttributeValues || {} });
      if (input.TableName === "bgp-data-classification") {
        // 与真 DDB 同形:分级只存在**一个** fqn 键下(maskRows 会用带 / 不带 bgp- 两种形态各问一次,只有存的那种有行)
        const fqn = String(input.ExpressionAttributeValues?.[":f"] ?? "");
        return { Items: state.classifications.filter((c) => c.fqn === fqn) };
      }
      if (input.TableName === "bgp-data-grants") {
        const u = String(input.ExpressionAttributeValues?.[":u"] ?? "");
        return { Items: state.grants.filter((g) => g.username === u) };
      }
      return { Items: [] };
    }),
  },
}));

import { maskRows } from "../masking";

const PLAYERS = "bgp-redshift.dev.public.players";
const userB: any = { sub: "sub-b", username: "biz-tester", groups: [], isPlatformAdmin: false, isManager: false, isDeveloper: false, demo: false };
const admin: any = { ...userB, username: "admin", isPlatformAdmin: true };

beforeEach(() => {
  state.classifications = [{ fqn: "redshift.dev.public.players", column: "country", level: "L3", maskStrategy: "full" }];
  state.grants = [];
  state.queries = [];
});

describe("maskRows × 别名 / 表达式", () => {
  it("🔴🔴 `country AS 地区`:结果列叫「地区」,分级落在 country ⇒ 「地区」整列 *** 且 maskedColumns 报「地区」(修前明文)", async () => {
    const out = await maskRows({
      columns: [{ name: "地区" }, { name: "客户数" }],
      rows: [["DE", "1204"], ["US", "882"]],
      sql: "SELECT country AS 地区, COUNT(*) AS 客户数 FROM public.players GROUP BY country ORDER BY 2 DESC LIMIT 3",
      database: "dev",
      identity: userB,
    });
    expect(out.rows).toEqual([["***", "1204"], ["***", "882"]]);
    expect(out.maskedColumns).toEqual(["地区"]);
  });

  it("表达式引用了敏感列(upper(country) AS c)⇒ 也脱敏;没碰敏感列的列原样", async () => {
    const out = await maskRows({
      columns: [{ name: "c" }, { name: "n" }],
      rows: [["de", "3"]],
      sql: "select upper(country) as c, count(*) as n from public.players group by 1",
      database: "dev",
      identity: userB,
    });
    expect(out.rows).toEqual([["***", "3"]]);
    expect(out.maskedColumns).toEqual(["c"]);
  });

  it("CTE 里先改名、外层再用别名 ⇒ 仍对得上 country", async () => {
    const out = await maskRows({
      columns: [{ name: "地区" }],
      rows: [["DE"]],
      sql: "with x as (select country as 地区 from public.players) select 地区 from x",
      database: "dev",
      identity: userB,
    });
    expect(out.rows).toEqual([["***"]]);
  });

  it("带 ColumnMetadata.tableName 的直查结果列(别名)也脱敏(精确分支同样认物理列)", async () => {
    const out = await maskRows({
      columns: [{ name: "地区", tableName: "players", schemaName: "public" }, { name: "os", tableName: "players", schemaName: "public" }],
      rows: [["DE", "ios"]],
      sql: "select country as 地区, os from public.players",
      database: "dev",
      identity: userB,
    });
    expect(out.rows).toEqual([["***", "ios"]]);
    expect(out.maskedColumns).toEqual(["地区"]);
  });

  it("回归:不带别名的直选列照旧脱敏;未分级列原样", async () => {
    const out = await maskRows({
      columns: [{ name: "country" }, { name: "os" }],
      rows: [["DE", "ios"]],
      sql: "select country, os from public.players",
      database: "dev",
      identity: userB,
    });
    expect(out.rows).toEqual([["***", "ios"]]);
    expect(out.maskedColumns).toEqual(["country"]);
  });

  it("豁免不变:平台管理员 / 对该表已授权的用户看明文(别名也不例外)", async () => {
    const input = {
      columns: [{ name: "地区" }],
      rows: [["DE"]],
      sql: "select country as 地区 from public.players",
      database: "dev",
    };
    expect((await maskRows({ ...input, identity: admin })).rows).toEqual([["DE"]]);
    state.grants = [{ username: "biz-tester", fqn: "redshift.dev.public.players" }];
    expect((await maskRows({ ...input, identity: userB })).rows).toEqual([["DE"]]);
  });

  it("🔴 别名撞上另一张被引用表里碰巧同名的物理列 ⇒ 取最强策略(宁严勿漏)", async () => {
    state.classifications.push({ fqn: "redshift.dev.public.regions", column: "地区", level: "L2", maskStrategy: "partial" });
    const out = await maskRows({
      columns: [{ name: "地区" }],
      rows: [["Germany"]],
      sql: "select p.country as 地区 from public.players p join public.regions r on r.code = p.country",
      database: "dev",
      identity: userB,
    });
    expect(out.rows).toEqual([["***"]]); // full(country) 强于 partial(地区)
  });

  it("没有 SQL、列名也对不上 ⇒ 没有引用表 ⇒ 原样(调用点必须把 sql 传进来 —— 卡片 2026-09-13 的真缺口就是漏传)", async () => {
    const out = await maskRows({ columns: [{ name: "地区" }], rows: [["DE"]], identity: userB });
    expect(out.rows).toEqual([["DE"]]);
    expect(out.maskedColumns).toEqual([]);
  });

  it("结构性:masking.ts 必须经 parseSelectOutputs 解析结果列(接缝判据 —— 「写了」≠「接上了」)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../masking.ts", import.meta.url), "utf8");
    expect(src).toMatch(/parseSelectOutputs\(input\.sql\)/);
    expect((src.match(/candidatesOf\(idx, cname\)/g) || []).length).toBeGreaterThanOrEqual(1);
  });
});
