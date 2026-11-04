export const dynamic = "force-dynamic";

// @kf-batch 50-WP5-rungroup
// GET /api/run-groups/[id] —— 一次多区联动运行的整组视图(50 SPEC v3.44 §2.7)。
//
// 🔴 `derivedStatus` 是**唯一可显示的状态**:表里的 `status` 只是物化投影(§3.17.1 第 2 条)。
// 🔴 读不到子 run **绝不**回空组 —— 空组在前端与「这次什么都没跑」一模一样(最坏的一种静默)。
//    `listRunsByTask` 读失败会抛,由下面的 500 如实带出原文。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { loadRunGroupForRequest } from "@/lib/monitor/run-group-http";
import { publicChild } from "@/lib/monitor/run-groups";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let loaded;
  try {
    loaded = await loadRunGroupForRequest(req, params.id, "viewer");
  } catch (e) {
    return apiError(`读取联动运行失败:${e instanceof Error ? e.message : String(e)}`, 500, { code: "UPSTREAM_ERROR" });
  }
  if (loaded instanceof NextResponse) return loaded;
  const { view } = loaded;
  return apiOk({
    group: view.group,
    // 🔴 投影掉后端原生标识(statementId / JobRunId 等只在服务端取消时用)
    children: view.children.map(publicChild),
    derivedStatus: view.derivedStatus,
    // 平台不认识的子状态如实带出来(绝不静默:那意味着有 run 的死活没人知道)
    ...(view.unknownChildStatuses.length ? { unknownChildStatuses: view.unknownChildStatuses } : {}),
  });
}
