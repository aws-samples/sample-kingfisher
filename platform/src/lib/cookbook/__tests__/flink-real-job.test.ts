import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { guard } from "@/lib/cookbook";

// 真实数据假阳性验证:测试环境里真跑通的 Flink 作业(mysql-cdc 源 + S3 Tables catalog + 聚合写回)的 SQL 原文,
// 连接参数全是 ${...} 占位、不含任何账号信息。guard 绝不能误伤它。
// 🔴 夹具随仓库走(fixtures/),不读本机临时文件 —— 否则只在抓过那份 SQL 的机器上能跑,CI 直接 ENOENT(2026-11-05 真撞)。
describe("Flink guard — 真实running作业SQL不误伤(最强假阳性防护)", () => {
  const realSql = readFileSync(join(__dirname, "fixtures", "flink-channel-revenue-agg.sql"), "utf8");
  it("真实running作业SQL过guard不blocked", () => {
    const g = guard("flink", realSql);
    expect(g.blocked, `误伤真实作业:${JSON.stringify(g.violations.filter(v=>v.severity==='error'))}`).toBe(false);
  });
  it("反引号标识符(s3t.`db`.`tbl`)原样保留", () => {
    const g = guard("flink", realSql);
    expect(g.code).toBe(realSql); // 合法SQL完全不变(该作业无需任何纠正)
  });
});
