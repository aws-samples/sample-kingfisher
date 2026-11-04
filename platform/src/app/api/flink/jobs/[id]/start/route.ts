export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { flinkReady, flinkJobTarget } from "@/lib/realtime/flink-service";
// 落点从**行上的章**取,并在启动前真解析一遍。
import { resolveFlinkPlace } from "@/lib/realtime/flink-place";
import { getCorrelationId } from "@/lib/observability/logger";
// 启动主体(startFlinkJob 等 MSAF 过渡态 1–3 分钟 → 写 starting → 审计)在 lib/realtime/long-ops.ts(flink-start)。
//   超 45 秒由统一框架转 202,页面右下「正在后台执行:启动实时作业」;对象租约 `flink:<jobId>`:启动中再点停 / 删 / 改 ⇒ 409。
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";

const USER_ID = "default-user";

// POST /api/flink/jobs/[id]/start — 启动 MSAF 应用(每作业一个;从 S3 JAR + 注入 SQL)。
//
// 🔴 启动可能因【需要用户决策】而中止(HTTP 409 + code=DECISION_REQUIRED):
//    典型为 CDC 快照位点已被源库清理,唯一出路是"丢弃进度从头重读"(会重算历史/可能重复写入)。
//    平台绝不代劳该决策——返回诊断与后果说明,由用户在页面上确认后带
//    `{ confirm: "discard-state" }` 重新调用本端点。见 flink-service.ts FlinkDecisionRequired(执行体装进 LongOpHttpError 409)。
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item: job } = await docClient.send(new GetCommand({ TableName: TABLES.FLINK_JOBS, Key: { userId: USER_ID, jobId: params.id } }));
  if (!job) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const ctx = await guardResourceAccess(req, job, "editor");
  if (ctx instanceof NextResponse) return ctx;

  // 🔴 **执行侧反向卡**:落点来自作业行上的章,
  // 解析不出来就**拒跑**,绝不静默回落主控区。回落的后果是「章说 usw2、其实跑在主控区」——
  // 界面上一切正常,而数据驻留承诺已经破了(与离线侧 `assertDefinitionRunsHere` 同一条纪律)。
  const jobTarget = flinkJobTarget(job);
  let place;
  try {
    place = await resolveFlinkPlace(jobTarget);
  } catch (e: any) {
    return apiError(
      `这个作业的章是 ${jobTarget},但那个执行环境的 Flink 通道解析不出来:${String(e?.message || e)}。` +
        `🔴 平台刻意不把它落到主控区去跑 —— 那会让「章」与「真跑的区」分叉`,
      409,
      { code: "TARGET_PUSHDOWN_UNAVAILABLE" }
    );
  }
  const ready = flinkReady(place);
  if (!ready.ok) return apiError(`${ready.reason!}(执行落点 ${place.targetId} / ${place.region})`, 503, { code: "UPSTREAM_ERROR" });

  // 用户显式确认令牌(仅 "discard-state" 有效;缺省 = 未确认,平台不做任何有损动作)。
  let confirm = "";
  try { confirm = String(((await req.json()) as any)?.confirm || ""); } catch { /* 无 body:未确认 */ }

  try {
    const result = await submitLongOp(
      { kind: "flink-start", params: { jobId: params.id, targetId: jobTarget, discardStateConfirmed: confirm === "discard-state" }, correlationId: getCorrelationId(req) },
      { req, identity: ctx.identity },
    );
    return longOpResponse(req, result);
  } catch (e: any) {
    const lo = longOpErrorResponse(e);
    if (lo) return lo;
    return apiError(String(e?.message || e), 500);
  }
}
