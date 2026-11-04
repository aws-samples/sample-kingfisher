// (2026-10-29 两个测试账号安装链 showcase 主控区同红、…4916 对照实验坐实)—— 实时「造数」示例事件的**唯一作者**。
//
// 缺陷原形:造数把 ~3 分钟跨度的事件时间按**随机顺序**写进流,而示例 SQL 的 watermark 只容忍 5 秒乱序
// (`WATERMARK FOR ts AS ts - INTERVAL '5' SECOND`)⇒ 第一批记录一到,watermark 就跳到 max(ts) − 5s,
// 其后到达的、比它更早的记录全被窗口算子按**迟到**丢弃 ⇒ 聚合产出成了抽签:同一字节 300 条随机序 ⇒ 9 行且整窗缺失
// (主控区两账号 0 行),同字段按时间升条 ⇒ 44 秒内 20 行、每窗 5 区齐全。页面却承诺「窗口关闭后约 30-60s 出聚合结果」。
//
// 根治 = 示例事件**按事件时间升序**写入:单分片内 Kinesis 保序 ⇒ watermark 随流单调推进 ⇒ 除最后一个窗口外每个窗口都确定性关闭并产出;
// 多分片时每个分片各自升序、Flink 取各分片 watermark 的最小值,结论不变。时间格式仍是 Flink JSON 默认的 SQL 时间戳 'yyyy-MM-dd HH:mm:ss.SSS'(UTC 墙钟,无时区)。

export const SAMPLE_EVENT_REGIONS = ["华东", "华北", "华南", "华中", "西南"] as const;

export interface SampleOrderEvent {
  region: (typeof SAMPLE_EVENT_REGIONS)[number];
  amount: number;
  /** 'yyyy-MM-dd HH:mm:ss.SSS'(UTC) */
  ts: string;
}

export interface SampleEventRecord {
  Data: Buffer;
  PartitionKey: string;
}

export interface BuildSampleEventsInput {
  count: number;
  /** 事件时间散布在 [now − spanMs, now] */
  spanMs: number;
  /** 毫秒时间戳;缺省 Date.now() */
  now?: number;
  /** [0,1) 随机源;缺省 Math.random(判据注入确定性序列) */
  random?: () => number;
}

/** Flink JSON 格式默认的 SQL 时间戳:'yyyy-MM-dd HH:mm:ss.SSS'(UTC 墙钟,无时区)。 */
export function flinkSqlTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").replace("Z", "");
}

/**
 * 生成 count 条示例订单事件,**按事件时间升序**(该缺陷的全部修法就在这一句 sort;判据钉它:随机序输入 ⇒ 输出单调不减)。
 * 事件时间 ∈ [now − spanMs, now],字段 region / amount / ts 与示例 SQL 的 orders_src 同形。
 */
export function buildSampleOrderEvents(input: BuildSampleEventsInput): SampleOrderEvent[] {
  const now = input.now ?? Date.now();
  const random = input.random ?? Math.random;
  const spanMs = Math.max(1, Math.floor(input.spanMs));
  const count = Math.max(0, Math.floor(input.count));
  const events: Array<{ at: number; region: SampleOrderEvent["region"]; amount: number }> = [];
  for (let i = 0; i < count; i++) {
    const at = now - Math.floor(random() * spanMs);
    const region = SAMPLE_EVENT_REGIONS[Math.min(SAMPLE_EVENT_REGIONS.length - 1, Math.floor(random() * SAMPLE_EVENT_REGIONS.length))];
    const amount = Math.round((random() * 900 + 100) * 100) / 100;
    events.push({ at, region, amount });
  }
  // 🔴 升序是修法本身,不是整理:乱序写入 ⇒ 5 秒 watermark 容忍之外的记录全按迟到丢弃(见文件头)
  events.sort((a, b) => a.at - b.at);
  return events.map((e) => ({ region: e.region, amount: e.amount, ts: flinkSqlTimestamp(e.at) }));
}

/** Kinesis PutRecords 的 Records(顺序 = 事件时间升序;PartitionKey = region,同区同分片 ⇒ 分片内仍升序)。 */
export function toKinesisRecords(events: readonly SampleOrderEvent[]): SampleEventRecord[] {
  return events.map((e) => ({ Data: Buffer.from(JSON.stringify(e), "utf-8"), PartitionKey: e.region }));
}
