// 实时「造数」示例事件按事件时间升序(唯一作者 lib/realtime/sample-events.ts)。
// 判据钉事实:随机序输入 ⇒ 输出 ts 单调不减;落在 [now − span, now];字段 / 时间格式与示例 SQL 同形;Kinesis 记录顺序 = 事件顺序。
// 变异(去掉 sort)⇒ 第一条必红(确定性随机序列保证输入乱序)。
import { describe, it, expect } from "vitest";
import { buildSampleOrderEvents, toKinesisRecords, flinkSqlTimestamp, SAMPLE_EVENT_REGIONS } from "@/lib/realtime/sample-events";

/** 确定性 LCG:同一种子同一序列;首项故意让「时间」项乱序(不依赖 Math.random 的运气)。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const NOW = Date.UTC(2026, 9, 29, 9, 14, 39, 123);
const SPAN = 3 * 60_000;

describe("buildSampleOrderEvents —— 事件时间升序", () => {
  it("随机序输入 ⇒ 输出 ts 单调不减(乱序写入会让 5 秒 watermark 容忍之外的记录全被按迟到丢弃)", () => {
    const events = buildSampleOrderEvents({ count: 300, spanMs: SPAN, now: NOW, random: lcg(7) });
    expect(events).toHaveLength(300);
    // 负向控制:同一随机源**不排序**时确实乱序(否则「升序」判据是空断言)
    const raw: number[] = [];
    const r = lcg(7);
    for (let i = 0; i < 300; i++) { raw.push(NOW - Math.floor(r() * SPAN)); r(); r(); }
    expect(raw.some((v, i) => i > 0 && v < raw[i - 1]), "随机序列本身不乱序 ⇒ 判据无判别力").toBe(true);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].ts >= events[i - 1].ts, `第 ${i} 条 ${events[i].ts} 早于前一条 ${events[i - 1].ts}`).toBe(true);
    }
  });

  it("事件时间落在 [now − span, now];格式 'yyyy-MM-dd HH:mm:ss.SSS'(UTC,无时区);字段与示例 SQL orders_src 同形", () => {
    const events = buildSampleOrderEvents({ count: 50, spanMs: SPAN, now: NOW, random: lcg(11) });
    const lo = flinkSqlTimestamp(NOW - SPAN), hi = flinkSqlTimestamp(NOW);
    for (const e of events) {
      expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
      expect(e.ts >= lo && e.ts <= hi, `${e.ts} 不在 [${lo}, ${hi}]`).toBe(true);
      expect(SAMPLE_EVENT_REGIONS as readonly string[]).toContain(e.region);
      expect(e.amount).toBeGreaterThanOrEqual(100);
      expect(e.amount).toBeLessThanOrEqual(1000);
      expect(Object.keys(e).sort()).toEqual(["amount", "region", "ts"]);
    }
    expect(flinkSqlTimestamp(Date.UTC(2026, 9, 29, 8, 27, 48, 5))).toBe("2026-10-29 08:27:48.005");
  });

  it("Kinesis 记录顺序 = 事件顺序;Data 是该事件的 JSON;PartitionKey = region(同区同分片 ⇒ 分片内仍升序)", () => {
    const events = buildSampleOrderEvents({ count: 20, spanMs: SPAN, now: NOW, random: lcg(3) });
    const recs = toKinesisRecords(events);
    expect(recs).toHaveLength(20);
    recs.forEach((r, i) => {
      expect(JSON.parse(r.Data.toString("utf-8"))).toEqual(events[i]);
      expect(r.PartitionKey).toBe(events[i].region);
    });
  });

  it("count / span 边界:count 0 ⇒ 空;span < 1ms 按 1ms;count 取整", () => {
    expect(buildSampleOrderEvents({ count: 0, spanMs: SPAN, now: NOW, random: lcg(1) })).toEqual([]);
    const one = buildSampleOrderEvents({ count: 2.9, spanMs: 0, now: NOW, random: lcg(1) });
    expect(one).toHaveLength(2);
    for (const e of one) expect(e.ts).toBe(flinkSqlTimestamp(NOW));
  });
});
