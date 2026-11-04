export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { PutRecordsCommand } from "@aws-sdk/client-kinesis";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { resolveKinesisStreamName, flinkJobTarget } from "@/lib/realtime/flink-service";
// @kf-batch 50-WP27-9cap-matrix
// 🔴🔴 **造数必须打到「作业自己那个区」的流**。这里原来是模块顶部一个**主控区** KinesisClient:
//    给非 home 的流作业点「造数」时,记录被 PutRecords 到主控区的同名流(或 ResourceNotFound),
//    页面照样回「已注入 150 条」,而那个区的作业永远等不到数据 —— 正是 `flink-place.ts` 头上写的
//    最坏形态:「应用跑在那个区、数据写回主控区」,一切看起来正常而驻留承诺已经破了。
//    落点一律经 `resolveFlinkPlace`(与启动侧同一个作者),客户端按 region 取。
import { resolveFlinkPlace } from "@/lib/realtime/flink-place";
import { kinesisClientFor } from "@/lib/exec-env/target-clients";
// B-135:示例事件的唯一作者 —— **按事件时间升序**写入(乱序 + 5 秒 watermark 容忍 ⇒ 大部分记录按迟到丢弃,聚合产出成抽签;详见该文件头)
import { buildSampleOrderEvents, toKinesisRecords } from "@/lib/realtime/sample-events";

const USER_ID = "default-user";

// POST /api/flink/jobs/[id]/produce — 造数:向源流注入示例订单事件(region/amount/ts)。
// ts 散布在最近 ~3 分钟且按升序写入,使较早的 1 分钟事件时间窗口随 watermark 推进而**确定性**关闭并产出聚合(便于无头核验)。
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item: job } = await docClient.send(new GetCommand({ TableName: TABLES.FLINK_JOBS, Key: { userId: USER_ID, jobId: params.id } }));
  if (!job) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const ctx = await guardResourceAccess(req, job, "editor");
  if (ctx instanceof NextResponse) return ctx;

  // Bug#4 修复:造数流名按【作业所选源数据源】解析(SSOT,与启动侧 resolveKinesisSource 共用
  // resolveKinesisStreamName),不再硬编码默认流 —— 默认流 bgp-flink-source 在成本改造后已删,
  // 硬编码会让所有用非默认流的 Kinesis 作业点"生成数据"必 500。
  const STREAM = await resolveKinesisStreamName(job.sourceDatasourceId);
  // 🔴 区:从**作业行上的章**解析(与启动侧 `resolveFlinkPlace` 同一个作者);解析不出来就拒,
  //    绝不静默回落主控区 —— 回落的后果是往错误的区写数据,而页面会说「成功」。
  const jobTarget = flinkJobTarget(job);
  let place;
  try {
    place = await resolveFlinkPlace(jobTarget);
  } catch (e: unknown) {
    return apiError(
      `这个作业的章是 ${jobTarget},但那个执行环境的 Flink 通道解析不出来:${String((e as Error)?.message || e)}。` +
        `🔴 平台刻意不把造数落到主控区去 —— 那会把记录写进另一个区的同名流`,
      409,
      { code: "TARGET_PUSHDOWN_UNAVAILABLE" }
    );
  }
  const kinesis = await kinesisClientFor(place.region);

  const body = await req.json().catch(() => ({}));
  const count = Math.min(Math.max(Number(body.count) || 150, 1), 500); // PutRecords 上限 500
  const spanMs = Math.max(Number(body.spanMinutes) || 3, 1) * 60000;

  // B-135:事件按事件时间升序(唯一作者 buildSampleOrderEvents;Flink JSON 默认 SQL 时间戳格式 'yyyy-MM-dd HH:mm:ss.SSS',UTC 墙钟)
  const records = toKinesisRecords(buildSampleOrderEvents({ count, spanMs }));
  try {
    const r = await kinesis.send(new PutRecordsCommand({ StreamName: STREAM, Records: records }));
    recordAudit(req, "flink.produce", { resourceType: "flink", resourceId: params.id, detail: { count, stream: STREAM, targetId: place.targetId, region: place.region } }).catch(() => {});
    // 🔴 响应把「打到哪个区的哪条流」复述出来(护栏 2:按钮/回执必须复述落点)——
    //    否则「造数成功」这句话在多区下没有信息量(它可能成功地打错了区)。
    return apiOk({
      produced: count, failed: r.FailedRecordCount || 0, stream: STREAM,
      targetId: place.targetId, region: place.region, spanMinutes: spanMs / 60000,
    });
  } catch (e: any) {
    return apiError(String(e?.message || e), 500);
  }
}
