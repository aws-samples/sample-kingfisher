import { describe, it, expect } from "vitest";
import { buildRedshiftTableClause } from "../glue-script-generator";

// SYNC-FIX(sortkey) 回归锚点:Glue 执行脚本建 Redshift 表的 DISTKEY/DISTSTYLE/SORTKEY 子句。
// 此前执行侧漏拼(预览DDL有、实际建表无)。钉住:兼容 string/数组、规范化、空值不拼、零回归。
describe("buildRedshiftTableClause(执行侧 Redshift 建表尾缀)", () => {
  it("sortKeys 为字符串 'col1,col2' → SORTKEY(col1, col2)(前端真实存法)", () => {
    expect(buildRedshiftTableClause({ sortKeys: "created_at,region" }))
      .toBe(" SORTKEY(created_at, region)");
  });

  it("sortKeys 为单列字符串 → SORTKEY(单列)(不会像旧 .join 那样逐字符裂开)", () => {
    // 旧 bug:generateDDL 对字符串 "created_at".join(", ") 会逐字符 → "c, r, e,...";这里必须整列
    expect(buildRedshiftTableClause({ sortKeys: "created_at" }))
      .toBe(" SORTKEY(created_at)");
  });

  it("sortKeys 为数组 → SORTKEY(逗号连接)", () => {
    expect(buildRedshiftTableClause({ sortKeys: ["a", "b"] }))
      .toBe(" SORTKEY(a, b)");
  });

  it("distStyle=key + distKey → DISTKEY(列)", () => {
    expect(buildRedshiftTableClause({ distStyle: "key", distKey: "id" }))
      .toBe(" DISTKEY(id)");
  });

  it("distStyle=even → DISTSTYLE EVEN(非 key/auto)", () => {
    expect(buildRedshiftTableClause({ distStyle: "even" }))
      .toBe(" DISTSTYLE EVEN");
  });

  it("distStyle=auto → 不拼(Redshift 自动,零噪声)", () => {
    expect(buildRedshiftTableClause({ distStyle: "auto" })).toBe("");
  });

  it("distStyle=key 但无 distKey → 不拼 DISTKEY(避免语法错)", () => {
    expect(buildRedshiftTableClause({ distStyle: "key" })).toBe("");
  });

  it("DISTKEY + SORTKEY 组合 → 两者都拼", () => {
    expect(buildRedshiftTableClause({ distStyle: "key", distKey: "id", sortKeys: "ts" }))
      .toBe(" DISTKEY(id) SORTKEY(ts)");
  });

  it("空配置 → 空串(零回归:退回原裸建表行为)", () => {
    expect(buildRedshiftTableClause({})).toBe("");
    expect(buildRedshiftTableClause({ sortKeys: "", distKey: "", distStyle: "" })).toBe("");
  });

  it("字符串含多余空格/空项 → 规范化去空", () => {
    expect(buildRedshiftTableClause({ sortKeys: " a , , b " }))
      .toBe(" SORTKEY(a, b)");
  });

  // Bug#3 回归锚点:传入 availableColumns 后,引用不存在列的 SORTKEY/DISTKEY 被剔除(避免建表 column-not-exist)。
  describe("Bug#3 列校验(传 availableColumns)", () => {
    it("SORTKEY 含不存在的列 → 剔除该列,只保留存在的", () => {
      expect(buildRedshiftTableClause({ sortKeys: "ts,ghost" }, ["id", "ts", "region"]))
        .toBe(" SORTKEY(ts)");
    });

    it("SORTKEY 全部不存在 → 整个 SORTKEY 子句不拼", () => {
      expect(buildRedshiftTableClause({ sortKeys: "ghost1,ghost2" }, ["id", "ts"]))
        .toBe("");
    });

    it("DISTKEY 列不存在 → 不拼 DISTKEY(避免语法错/column-not-exist)", () => {
      expect(buildRedshiftTableClause({ distStyle: "key", distKey: "ghost" }, ["id", "ts"]))
        .toBe("");
    });

    it("大小写不敏感匹配(Redshift 折叠小写):TS 列 'TS' 命中 availableColumns 'ts'", () => {
      expect(buildRedshiftTableClause({ sortKeys: "TS", distStyle: "key", distKey: "ID" }, ["id", "ts"]))
        .toBe(" DISTKEY(ID) SORTKEY(TS)");
    });

    it("不传 availableColumns → 保持原行为(不校验,向后兼容)", () => {
      expect(buildRedshiftTableClause({ sortKeys: "ghost" }))
        .toBe(" SORTKEY(ghost)");
    });

    it("onDrop 回调收到被剔除的键", () => {
      const dropped: string[] = [];
      buildRedshiftTableClause(
        { sortKeys: "ts,ghost", distStyle: "key", distKey: "nope" },
        ["id", "ts"],
        (kind, col) => dropped.push(`${kind}:${col}`),
      );
      expect(dropped).toEqual(["sortkey:ghost", "distkey:nope"]);
    });
  });
});
