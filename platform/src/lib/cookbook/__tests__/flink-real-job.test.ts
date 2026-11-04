import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { guard } from "@/lib/cookbook";

// 真实数据假阳性验证:临时环境正在 running 的 Flink 作业 GameFlink-channel-revenue-agg 的真实SQL,
// 它是真跑通的合法 Flink SQL(mysql-cdc源+s3table catalog+窗口聚合)。guard 绝不能误伤它。
describe("Flink guard — 真实running作业SQL不误伤(最强假阳性防护)", () => {
  const realSql = readFileSync("/tmp/real_flink_sql.txt", "utf8");
  it("真实running作业SQL过guard不blocked", () => {
    const g = guard("flink", realSql);
    expect(g.blocked, `误伤真实作业:${JSON.stringify(g.violations.filter(v=>v.severity==='error'))}`).toBe(false);
  });
  it("反引号标识符(s3t.`db`.`tbl`)原样保留", () => {
    const g = guard("flink", realSql);
    expect(g.code).toBe(realSql); // 合法SQL完全不变(该作业无需任何纠正)
  });
});
