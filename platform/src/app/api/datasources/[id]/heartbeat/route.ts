export const dynamic = "force-dynamic";
// @kf-batch 52-P52.1-guards
// 🔴 **改动前零守卫**(52 SPEC §2 缺口B 第 7 面之二;台账 §11.2 第 5 项):探活会**回写该数据源的
//    `status`/`lastHeartbeatAt`** ⇒ 任一登录用户可跨项目把别人的数据源标成 unreachable。
// 🔴 守卫**按数据源的归属项目**判(`guardResourceAccess`),不是调用方 active project —— 否则是混淆代理。
//
// 序 38 B-70 —— 探测可以走数据源自己的 Glue 连接(见 lib/datasource/glue-reach.ts 顶部的缺陷原形):
//   POST:probeVia=auto(缺省)先控制面直连;**连不上且有 Glue 连接** ⇒ 不再把源刷成 unreachable,而是起(或复用在跑的)
//        一次发现作业当探测,状态置 testing、heartbeat.state=testing,顺带记下控制面那一下的结果(页面明示);
//        probeVia=glue-connection ⇒ 直接起。
//   GET:读发现作业的结论并落库(成功 ⇒ active + 表清单顺带缓存;失败 ⇒ unreachable + Glue 的 ErrorMessage;超预算 ⇒ unknown);
//        页面点完「检测」后轮询它。列表 / 单条读取也会做同一件事(lib/datasource/glue-probe-settle.ts)。
//   🔴 不用 Glue TestConnection:对平台建的传统 JDBC 连接它直接回「only supported for the Unified Connections」(2026-10-13 实测)。
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { probeDataSourceReachability } from "@/lib/datasource/reachability-probe";
import { settleGlueProbeRow } from "@/lib/datasource/glue-probe-settle";
import type { DataSource } from "@/types/datasource";

const USER_ID = "default-user";

// DS-05 — on-demand connectivity heartbeat. Probes the source and updates its status
// (active / unreachable), recording the latency and timestamp. Engines without a direct
// driver are reported as "skipped" and their status is left unchanged.
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const { Item: ds } = await docClient.send(
      new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: params.id } })
    );
    // 🔴 先授权再回答"存不存在":顺序反了就把"某 id 是否存在"泄露给非成员。
    const ctx = await guardResourceAccess(req, ds as { projectId?: string } | undefined, "editor");
    if (ctx instanceof NextResponse) return ctx;
    if (!ds) return apiError("数据源不存在", 404);
    const row = ds as unknown as DataSource;
    // 序 49 ② B-73:连通性检测本体搬到唯一作者 lib/datasource/reachability-probe.ts(建源收口也调它),响应形状逐字不变
    const out = await probeDataSourceReachability(row);
    if (out.kind === "settled") return apiOk({ status: out.status, ...out.cp });
    return apiOk({
      status: "testing", reachable: null, via: "glue-connection", state: "testing", startedAt: out.probe.startedAt, jobRunId: out.probe.jobRunId, reused: out.probe.reused,
      controlPlane: out.hb.controlPlane, message: out.message,
    });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

/** 读探测结论并落库(页面轮询)。不在 testing 态 ⇒ 原样回最近一次心跳。 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const { Item: ds } = await docClient.send(
      new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: params.id } })
    );
    const ctx = await guardResourceAccess(req, ds as { projectId?: string } | undefined, "viewer");
    if (ctx instanceof NextResponse) return ctx;
    if (!ds) return apiError("数据源不存在", 404);
    const row = await settleGlueProbeRow(ds as unknown as DataSource);
    return apiOk({ status: row.status, ...(row.heartbeat ?? { reachable: null }) });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
