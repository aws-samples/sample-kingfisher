// 结果列 → 物理列解析(字段脱敏按物理列对分级的前提)。
// 纯函数,不碰外部。判据钉的是「事实」:每个结果列叫什么、引用了哪些物理列;不钉实现细节。
import { describe, it, expect } from "vitest";
import { parseSelectOutputs } from "../sql-lineage";

const top = (sql: string) => parseSelectOutputs(sql).top;

describe("parseSelectOutputs —— 结果列 → 物理列", () => {
  it("🔴 问数模型的典型 SQL:中文别名 + 聚合 ⇒ 「地区」引用 country、「客户数」不引用任何列", () => {
    const t = top("SELECT country AS 地区, COUNT(*) AS 客户数 FROM public.players GROUP BY country ORDER BY 2 DESC LIMIT 3");
    expect(t).toEqual([
      { name: "地区", sources: ["country"] },
      { name: "客户数", sources: [] },
    ]);
  });

  it("裸列 / 带表前缀 / 引号列名:结果列名 = 最后一段,引用自己", () => {
    const t = top('select p.country, "Os", is_paying from public.players p');
    expect(t).toEqual([
      { name: "country", sources: ["country"] },
      { name: "os", sources: ["os"] },
      { name: "is_paying", sources: ["is_paying"] },
    ]);
  });

  it("不写 AS 的裸别名 + 表达式 / 聚合里的列也算引用(保守:表达式碰了敏感列就要脱敏)", () => {
    const t = top("select upper(email) e, phone, count(distinct user_id) n, email || '@' || domain full_mail from t");
    expect(t).toEqual([
      { name: "e", sources: ["email"] },
      { name: "phone", sources: ["phone"] },
      { name: "n", sources: ["user_id"] },
      { name: "full_mail", sources: ["email", "domain"] },
    ]);
  });

  it("🔴 CTE / 子查询里起的别名要逐层展开到物理列(模型常先在 CTE 里改名)", () => {
    const t = top("WITH x AS (SELECT country AS 地区, player_id FROM players) SELECT 地区, count(player_id) AS n FROM x GROUP BY 1");
    expect(t[0].name).toBe("地区");
    expect(t[0].sources).toContain("country");
    expect(t[1]).toEqual({ name: "n", sources: ["player_id"] });
    const t2 = top("select a.r from (select country r from players) a");
    expect(t2[0].name).toBe("r");
    expect(t2[0].sources).toContain("country");
  });

  it("关键字 / 类型 / 字面量 / 函数名不算列:case-when、::cast、extract(… from …)、字符串里的逗号与 from", () => {
    const t = top(
      "select created_at::date as d, case when is_paying = 1 then 'y' else 'n' end as paying, " +
        "extract(year from install_time) as y, 'a, from b' as s, cast(amount as decimal(10,2)) as amt from players",
    );
    expect(t).toEqual([
      { name: "d", sources: ["created_at"] },
      { name: "paying", sources: ["is_paying"] },
      { name: "y", sources: ["install_time"] },
      { name: "s", sources: [] },
      { name: "amt", sources: ["amount"] },
    ]);
  });

  it("`*` / `t.*` 解析不出列 ⇒ name null、sources 空(调用方回落到按结果列名匹配,不会更松)", () => {
    expect(top("select * from players")).toEqual([{ name: null, sources: [] }]);
    expect(top("select p.*, 1 as one from players p")).toEqual([
      { name: null, sources: [] },
      { name: "one", sources: [] },
    ]);
  });

  it("非 select / 空串 / 畸形 SQL ⇒ 空结果,永不抛", () => {
    expect(top("")).toEqual([]);
    expect(top("insert into t values (1)")).toEqual([]);
    expect(() => parseSelectOutputs("select ((( from")).not.toThrow();
  });

  it("union 取第一段 select 的列(结果集列名由它决定)", () => {
    const t = top("select country as c from a union all select region from b");
    expect(t).toEqual([{ name: "c", sources: ["country"] }]);
  });
});
