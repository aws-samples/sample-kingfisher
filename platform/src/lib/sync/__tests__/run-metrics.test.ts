// @kf-batch 37-sync-capability —— 序 37 B-62:运行行数指标从日志标记取真值(纯函数,零 mock)+ 接线判据。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSyncRunMetrics } from "@/lib/sync/run-metrics";

const S3 = "s3tablescatalog.gamedb";

describe("B-62 rowsWritten 取真值", () => {
  it("只 S3 覆盖(两张表):rowsWritten = 各表 SYNC_VERIFY target_rows 之和,不再抄 rowsRead", () => {
    const logs = [
      "Read 2 rows, 2 columns from players",
      `SYNC_VERIFY target=s3tables table=${S3}.players scope=table source_rows=2 target_rows=2`,
      "ROWS_READ table=players rows=2",
      `SYNC_VERIFY target=s3tables table=${S3}.orders scope=table source_rows=5 target_rows=5`,
      "ROWS_READ table=orders rows=5",
    ];
    expect(parseSyncRunMetrics(logs, "succeeded")).toEqual({ rowsRead: 7, rowsWritten: 7 });
  });
  it("S3 合并:读 2 行 upsert ⇒ target_rows 是键命中的行数(= 2),而不是目标总行数;判别力:target_rows 与 rowsRead 不同时取的是 target_rows", () => {
    const logs = [
      `SYNC_VERIFY target=s3tables table=${S3}.players scope=merge source_rows=2 target_rows=2`,
      "ROWS_READ table=players rows=2",
    ];
    expect(parseSyncRunMetrics(logs, "succeeded")).toEqual({ rowsRead: 2, rowsWritten: 2 });
    // 对数标记里 target_rows 与读数不同(真环境只会在 SYNC_VERIFY_MISMATCH 失败时出现,但量具必须看得见这个差别)
    const skew = [`SYNC_VERIFY target=s3tables table=${S3}.players scope=merge source_rows=2 target_rows=3`, "ROWS_READ table=players rows=2"];
    expect(parseSyncRunMetrics(skew, "succeeded").rowsWritten).toBe(3);
  });
  it("both:有 REDSHIFT_ROWS_WRITTEN 照旧取它(不把 S3 的对数再加一遍)", () => {
    const logs = [
      `SYNC_VERIFY target=s3tables table=${S3}.players scope=table source_rows=4 target_rows=4`,
      "REDSHIFT_ROWS_WRITTEN table=public.players rows=4",
      "SYNC_VERIFY target=redshift table=public.players scope=table source_rows=4 target_rows=4",
      "ROWS_READ table=players rows=4",
    ];
    expect(parseSyncRunMetrics(logs, "succeeded")).toEqual({ rowsRead: 4, rowsWritten: 4 });
  });
  it("纯 append 的 S3 任务(没有任何写标记)+ 成功 ⇒ 维持 rowsRead 兜底(INSERT INTO 整份 df,写入在定义上等于读到)", () => {
    const logs = ["ROWS_READ table=players rows=9", "APPEND s3tablescatalog.gamedb.players: inserted 9 rows"];
    expect(parseSyncRunMetrics(logs, "succeeded")).toEqual({ rowsRead: 9, rowsWritten: 9 });
  });
  it("失败的运行没有写标记 ⇒ rowsWritten = 0(不许把读数冒充成写数)", () => {
    expect(parseSyncRunMetrics(["ROWS_READ table=players rows=9"], "error")).toEqual({ rowsRead: 9, rowsWritten: 0 });
  });
  it("redshift 的 SYNC_VERIFY 单独出现(没有 REDSHIFT_ROWS_WRITTEN,理论上不会)⇒ 不当成 S3 的对数", () => {
    const logs = ["SYNC_VERIFY target=redshift table=public.players scope=table source_rows=4 target_rows=4", "ROWS_READ table=players rows=4"];
    expect(parseSyncRunMetrics(logs, "succeeded")).toEqual({ rowsRead: 4, rowsWritten: 4 });
  });
  it("空日志 ⇒ 0/0", () => {
    expect(parseSyncRunMetrics([], "succeeded")).toEqual({ rowsRead: 0, rowsWritten: 0 });
  });
});

describe("接线:start-run.ts 的轮询真的用它(剥掉 import 行后在调用位置出现;旧的内联正则已退役)", () => {
  const src = readFileSync(join(__dirname, "..", "start-run.ts"), "utf8");
  const body = src.split("\n").filter((l) => !/^\s*import\s/.test(l) && !/^\s*\/\//.test(l)).join("\n");
  it("调用位置", () => {
    expect(body).toMatch(/parseSyncRunMetrics\(allLogs, status\)/);
  });
  it("不再有第二份解析规则", () => {
    expect(body).not.toContain("REDSHIFT_ROWS_WRITTEN\\s+table");
    expect(body).not.toContain("rowsWritten = rowsRead");
  });
});
