export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { resolveIdentity } from "@/lib/auth/identity";
import { apiOk, apiError } from "@/lib/api-response";
import { getCorrelationId } from "@/lib/observability/logger";
import { readSchemaSyncRun, schemaSyncMessage } from "@/lib/governance/schema-sync-run";
// 模块 55 / 序 50 第二批(B-74 根治的第二刀):同步列信息是长操作(kind governance-schema-sync,执行体 lib/governance/long-ops.ts,
//   工作体 lib/governance/schema-sync-work.ts)。进程内等 45s 未终态 ⇒ 202(协议 long-op/1),全局 fetch 拦截器轮询到终态再交回同形响应。
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";

// 将 Redshift + S3 Tables 真实列信息回填到 OpenMetadata(修复治理目录「字段数」恒为 1,并为列级血缘提供真实列名来源)。
// 幂等、只读 information_schema + 写 OM 元数据。限平台管理员。
//
// 序 38(2026-10-13 s38 复跑 71d):回填本身会超 ALB 60s 墙 ⇒ 当时做了一套治理专用的「45s 内 200 / 否则 202 带 runId + GET 轮询 / 并入」协议。
// 模块 55 第二批把它退役:等待 / 转后台 / 并发互斥由统一框架承担(第二个人同时点 ⇒ 409「『同步列信息到数据目录』正在进行中」),
//   运行记录仍落 settings 表,GET 读「最近一次同步」不变。成功 / 失败响应体与 序 38 的 200 / 500 逐字一致。

export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效，请重新登录", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可同步列信息", 403);
  try {
    const result = await submitLongOp(
      { kind: "governance-schema-sync", params: {}, correlationId: getCorrelationId(req) },
      { req, identity },
    );
    return longOpResponse(req, result);
  } catch (e: any) {
    const lo = longOpErrorResponse(e);
    if (lo) return lo;
    return apiError(`同步失败: ${e.message || String(e)}`, 500);
  }
}

/** 最近一次同步的运行记录(登录即可读)。 */
export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效，请重新登录", 401);
  try {
    const run = await readSchemaSyncRun();
    if (!run) return apiOk({ state: "none" });
    return apiOk(run.state === "succeeded" && run.result ? { ...run, message: schemaSyncMessage(run.result) } : run);
  } catch (e: any) {
    return apiError(`读取同步状态失败: ${e.message || String(e)}`, 500);
  }
}
