export const dynamic = "force-dynamic";

import { requireProject } from "@/lib/projects/guard";
import { NextRequest, NextResponse } from "next/server";
// @kf-batch 50-WP31-place-first-class
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { apiOk, apiError } from "@/lib/api-response";
import { GENBI } from "@/lib/genbi/config";
import { executeGenBiAsk, persistGenBiSideEffects } from "@/lib/genbi/execute";
import { createTask } from "@/lib/genbi/tasks";
// @kf-batch 50-W5-seg2-WP8 — 模块 51 `_meta` 回显(同步分支经 apiOk 第三参;异步分支终态在任务项 result._meta)。
import { getCorrelationId } from "@/lib/observability/logger";
import { AgentCoreModelMismatch } from "@/lib/ai/agentcore-contract";

// POST /api/genbi/ask
// Body: { question, workgroupName?, database?, engine?, conversationId?, targetId? }
// @kf-batch 50-WP2-directquery —— `targetId` 从 **body** 来(写/执行路由不读 `?scope=`,SPEC §2.6.3):
// 页面把当前执行范围显式放进 body,并在提问框旁复述「在哪个区问」(护栏 2)。
// 后端由 GENBI_BACKEND 选择：`agentcore`(AgentCore Runtime + Gateway MCP) | 默认进程内。
//
// 模块 38 — 异步化(GENBI_ASYNC):
//  · 关(默认/回退):**同步**跑完 executeGenBiAsk 后 apiOk(result) —— 与改造前逐字段一致,零回归。
//  · 开:仅 createTask 建 pending 任务,秒回 { taskId, status:"pending" }(202)。真正执行由前端轮询
//    GET /api/genbi/tasks/[taskId] 时抢占驱动(见该端点)。请求 <1s 返回,CloudFront 60s 墙不再触发。
export async function POST(req: NextRequest) {
  let body: { question?: string; workgroupName?: string; database?: string; engine?: string; conversationId?: string; targetId?: string };
  try { body = await req.json(); } catch { return apiError("请求体无效"); }
  // 🔴 生产上线批次 A:问数会以平台身份在该项目的数仓里真执行查询 ⇒ 调用方必须是**该项目成员**(≥ viewer)。
  //   原来项目号直接取请求头、身份 `.catch(() => null)` ⇒ 任何登录用户改一下请求头就能查别的项目。
  const pctx = await requireProject(req, "viewer");
  if (pctx instanceof NextResponse) return pctx;

  const question = (body.question || "").trim();
  if (!question) return apiError("问题不能为空");

  const engine: "redshift" | "athena" = body.engine === "athena" ? "athena" : "redshift";
  // @kf-batch 50-WP31-place-first-class —— 🔴 落点只认点名(缺 ⇒ 400 PLACE_UNDECIDABLE),不再「没给 = 主控区」
  let targetIdRaw: string;
  try {
    targetIdRaw = requestedTargetId(body.targetId, "问数");
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    throw e;
  }
  // @kf-batch 50-WP2-directquery
  // 🔴 **指定了 target 就不许拿主控区的默认 workgroup 兜底**:那个默认值是 `bgp-workgroup`(home 的),
  //    而绑定解析对「显式给的 workgroup 与该 target 描述符不一致」是**直接拒**(warehouse-conflict)——
  //    于是「切到 us-west-2 提问」会得到一句莫名其妙的落点冲突。留空 ⇒ 由该 target 的描述符填。
  //    (那条冲突检查本身是对的:界面预填主控区的值、真跑在别处,正是本模块要消灭的「看起来正常」。)
  // 工作组未给 ⇒ 空串,由落点作者解析(主控区解析出的就是 GENBI.workgroup —— 同源 homeWorkgroup)
  const workgroup = body.workgroupName || "";
  const database = body.database || GENBI.database;
  // @kf-batch 50-WP2-directquery
  // 🔴 **改走 `getActiveProjectId(req)`(全站单一作者,缺头时回落默认工作区)**,而不是裸读头:
  //    非 home 的取数要 project-context 凭证(§3.9b),缺 projectId 会被绑定解析**直接拒**
  //    ——真环境 dq 段当场撞到:「在非 home 目标 tgt_usw2_a 上执行必须带 projectId」。
  //    平台其余每一条路由都走 `requireProject` / `getActiveProjectId`(它们都会回落默认工作区),
  //    只有这里裸读头 ⇒ 任何没带头的调用方(脚本 / 集成 / 老客户端)在非 home 上必失败。
  //    home 侧行为不变:flag=off 时 `project` 只参与凭证缓存键。
  const projectId = pctx.projectId;
  const conversationId = (body.conversationId || "").trim();
  const targetId = targetIdRaw;
  const userId = pctx.identity.sub;

  const asyncMode = (process.env.GENBI_ASYNC || "").toLowerCase() === "1"
    || (process.env.GENBI_ASYNC || "").toLowerCase() === "true";

  // ── 异步:建任务秒回 taskId,执行推迟到轮询端点 ──
  if (asyncMode) {
    try {
      const taskId = await createTask({ question, engine, workgroup, database, targetId, projectId, conversationId, userId });
      return apiOk({ taskId, status: "pending", async: true }, 202);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return apiError(`GenBI 建立任务失败: ${msg}`, 500);
    }
  }

  // ── 同步(默认/回退):原样跑完再返回,行为零回归 ──
  try {
    // identity 在纯函数外解析(纯函数不依赖 req)。
    const identity = pctx.identity;
    const { result, usedBackend, targetId: ranInTarget } = await executeGenBiAsk({ question, engine, workgroup, database, targetId, projectId, conversationId, userId, identity, correlationId: getCorrelationId(req) });
    // 副作用(历史/记忆)由调用方在拿到结果后记——时机/产出与改造前一致(零回归)。
    // @kf-batch 50-WP4ter-coverage —— 历史行盖上「真跑在哪个区」
    persistGenBiSideEffects({ userId, question, answer: result.answer, sql: result.sql, engine, backend: usedBackend, projectId, conversationId, result, targetId: ranInTarget });
    // @kf-batch 50-W5-seg2-WP8:信封顶层 `_meta` 与 data._meta 同一对象(SPEC §3.3a 同步 route 落点①)。
    return apiOk(result, 200, result._meta);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // @kf-batch 50-W5-seg2-WP8:AgentCore 模型回执不匹配 ⇒ 503(接线故障,fail-closed;/settings「AI 接线健康」同步红)。
    if (err instanceof AgentCoreModelMismatch) return apiError(msg, 503, { code: "UPSTREAM_ERROR" });
    return apiError(`GenBI 处理失败: ${msg}`, 500);
  }
}
