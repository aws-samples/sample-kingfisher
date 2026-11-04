// 模块 26 — Observability 看板后端聚合：AgentCore Runtime/Gateway 状态 + 工具、GenBI 用量分析、
// 技能 Lambda CloudWatch 指标、每工具/每注册技能调用计数(EMF)。全部 best-effort（单点失败不影响整体）。
// @kf-batch 50-WP31-place-first-class —— 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { homeRegion } from "@/lib/place/home-region";
import { sdkClient } from "@/lib/aws/clients";
import {
  BedrockAgentCoreControlClient, ListAgentRuntimesCommand, ListGatewaysCommand, ListGatewayTargetsCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { CloudWatchClient, GetMetricStatisticsCommand, ListMetricsCommand } from "@aws-sdk/client-cloudwatch";
import { scanGenBiHistory } from "@/lib/genbi/history";
// @kf-batch 50-WP4ter-coverage —— 按执行范围过滤(工单 SC-6)
import { filterRowsByScalar, type TargetScope } from "@/lib/exec-env/scope";

const REGION = homeRegion();
const control = sdkClient("central:agentcore", BedrockAgentCoreControlClient, { region: REGION });
const cw = sdkClient("central:agentcore", CloudWatchClient, { region: REGION });
const GENBI_METRIC_NS = "BGP/GenBI";
const TOOLS = ["run_redshift_sql", "run_athena_sql", "introspect_redshift_schema", "introspect_s3tables_schema", "lookup_business_context", "list_registered_skills", "run_registered_skill"];

async function agentcoreStatus() {
  const out: any = {
    backend: process.env.GENBI_BACKEND || "inprocess",
    memoryBackend: process.env.GENBI_MEMORY_BACKEND || "selfmanaged",
    runtimeConfigured: !!process.env.GENBI_RUNTIME_ARN,
    memoryConfigured: !!process.env.GENBI_MEMORY_ID,
    runtime: null, gateway: null, targets: [], tools: TOOLS,
  };
  try {
    const r: any = await control.send(new ListAgentRuntimesCommand({}));
    const rt = (r.agentRuntimes || []).find((x: any) => x.agentRuntimeName === "bgp_genbi_agent");
    if (rt) out.runtime = { name: rt.agentRuntimeName, status: rt.status, version: rt.agentRuntimeVersion, updatedAt: rt.lastUpdatedAt };
  } catch (e: any) { out.runtimeError = e.message; }
  try {
    const g: any = await control.send(new ListGatewaysCommand({}));
    const gw = (g.items || []).find((x: any) => (x.name || "").includes("genbi")) || (g.items || [])[0];
    if (gw) {
      const gid = gw.gatewayId || gw.gatewayIdentifier;
      out.gateway = { name: gw.name, status: gw.status, id: gid, protocol: gw.protocolType, authorizer: gw.authorizerType };
      try {
        const t: any = await control.send(new ListGatewayTargetsCommand({ gatewayIdentifier: gid }));
        out.targets = (t.items || []).map((x: any) => ({ name: x.name, status: x.status }));
      } catch { /* targets best-effort */ }
    }
  } catch (e: any) { out.gatewayError = e.message; }
  return out;
}

function genbiStats(items: any[]) {
  const today = new Date().toISOString().slice(0, 10);
  let inTok = 0, outTok = 0, rows = 0;
  const byEngine: Record<string, number> = {};
  const byBackend: Record<string, number> = {};
  const byDay: Record<string, number> = {};
  for (const it of items) {
    inTok += it.inputTokens || 0;
    outTok += it.outputTokens || 0;
    rows += it.rowCount || 0;
    const e = it.engine || "redshift"; byEngine[e] = (byEngine[e] || 0) + 1;
    const b = it.backend || "inprocess"; byBackend[b] = (byBackend[b] || 0) + 1;
    const d = (it.createdAt || "").slice(0, 10); if (d) byDay[d] = (byDay[d] || 0) + 1;
  }
  const recent = [...items]
    .sort((a, b) => ((a.createdAt || "") < (b.createdAt || "") ? 1 : -1))
    .slice(0, 20)
    .map((it) => ({
      question: it.question, rowCount: it.rowCount ?? 0, engine: it.engine || "redshift",
      backend: it.backend || "inprocess",
      // 旧记录(v1.25.0 前)无 token 字段 → 用 null 表示"未记录",前端显示 — 而非误导性的 0。
      inputTokens: it.inputTokens ?? null, outputTokens: it.outputTokens ?? null,
      createdAt: it.createdAt,
    }));
  const tokenTracked = items.filter((it) => it.inputTokens != null).length;
  return {
    total: items.length,
    today: items.filter((it) => (it.createdAt || "").slice(0, 10) === today).length,
    inputTokens: inTok, outputTokens: outTok, totalTokens: inTok + outTok, tokenTracked,
    avgRows: items.length ? Math.round(rows / items.length) : 0,
    byEngine, byBackend,
    trend: Object.entries(byDay).sort().slice(-7).map(([date, count]) => ({ date, count })),
    recent,
  };
}

async function lambdaMetrics() {
  const end = new Date(), start = new Date(end.getTime() - 24 * 3600 * 1000);
  const Dimensions = [{ Name: "FunctionName", Value: "bgp-genbi-skills" }];
  const sumStat = async (MetricName: string) => {
    try {
      const r = await cw.send(new GetMetricStatisticsCommand({ Namespace: "AWS/Lambda", MetricName, Dimensions, StartTime: start, EndTime: end, Period: 3600, Statistics: ["Sum"] }));
      return (r.Datapoints || []).reduce((s, d) => s + (d.Sum || 0), 0);
    } catch { return 0; }
  };
  let avgDurationMs = 0;
  try {
    const r = await cw.send(new GetMetricStatisticsCommand({ Namespace: "AWS/Lambda", MetricName: "Duration", Dimensions, StartTime: start, EndTime: end, Period: 86400, Statistics: ["Average"] }));
    const dps = r.Datapoints || [];
    avgDurationMs = dps.length ? Math.round(dps.reduce((s, d) => s + (d.Average || 0), 0) / dps.length) : 0;
  } catch { /* best-effort */ }
  return { window: "24h", invocations: await sumStat("Invocations"), errors: await sumStat("Errors"), avgDurationMs };
}

// In-process 工具调用计数：AgentCore 路径外(默认进程内后端 / AgentCore 失败回落)的工具调用
// 不经 Lambda、不发 EMF,只落在历史条目的 toolCalls 里。这里按 24h 窗口从历史聚合,补齐 EMF 盲区。
function inprocessToolCalls(items: any[]): { perTool: Map<string, { calls: number; errors: number }>; total: number } {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const perTool = new Map<string, { calls: number; errors: number }>();
  let total = 0;
  for (const it of items) {
    const ts = Date.parse(it?.createdAt || "");
    if (!Number.isFinite(ts) || ts < cutoff) continue; // 与 EMF 一致的 24h 窗口
    for (const tc of it?.toolCalls || []) {
      const tool = String(tc?.tool || "").trim();
      if (!tool) continue;
      const cur = perTool.get(tool) || { calls: 0, errors: 0 };
      cur.calls += Number(tc.calls) || 0;
      cur.errors += Number(tc.errors) || 0;
      perTool.set(tool, cur);
      total += Number(tc.calls) || 0;
    }
  }
  return { perTool, total };
}

// 每工具 / 每注册技能调用计数（BGP/GenBI EMF 自定义指标，24h）+ 进程内历史聚合合并，
// 让「进程内后端」的工具调用也被计入（消除观测盲区）。items = 近 24h 历史(供 in-process 聚合)。
async function toolCallMetrics(items: any[]) {
  const end = new Date(), start = new Date(end.getTime() - 24 * 3600 * 1000);
  const sum = async (MetricName: string, dimName: string, dimVal: string) => {
    try {
      const r = await cw.send(new GetMetricStatisticsCommand({
        Namespace: GENBI_METRIC_NS, MetricName, Dimensions: [{ Name: dimName, Value: dimVal }],
        StartTime: start, EndTime: end, Period: 86400, Statistics: ["Sum"],
      }));
      return (r.Datapoints || []).reduce((s, d) => s + (d.Sum || 0), 0);
    } catch { return 0; }
  };
  const inproc = inprocessToolCalls(items);
  // 内置工具：EMF(AgentCore Lambda) + 进程内历史 合并计数,各带来源拆分供 UI 说明。
  const perTool = await Promise.all(TOOLS.map(async (t) => {
    const [emfCalls, emfErrors] = await Promise.all([sum("Calls", "ToolName", t), sum("Errors", "ToolName", t)]);
    const ip = inproc.perTool.get(t) || { calls: 0, errors: 0 };
    return { tool: t, calls: emfCalls + ip.calls, errors: emfErrors + ip.errors, emfCalls, inprocessCalls: ip.calls };
  }));
  // 进程内命中的、不在内置 TOOLS 白名单里的工具名也补进来(前向兼容 agent.ts 新增工具)。
  for (const [tool, v] of Array.from(inproc.perTool.entries())) {
    if (TOOLS.includes(tool)) continue;
    perTool.push({ tool, calls: v.calls, errors: v.errors, emfCalls: 0, inprocessCalls: v.calls });
  }
  // 注册技能：先用 ListMetrics 发现 Skill 维度值，再逐一查询(仅 AgentCore 路径有 Skill 维度)。
  let perSkill: { skill: string; calls: number; errors: number }[] = [];
  try {
    const skillNames = new Set<string>();
    let nextToken: string | undefined;
    do {
      const lm: any = await cw.send(new ListMetricsCommand({ Namespace: GENBI_METRIC_NS, MetricName: "Calls", NextToken: nextToken }));
      for (const m of lm.Metrics || []) {
        const d = (m.Dimensions || []).find((x: any) => x.Name === "Skill");
        if (d?.Value) skillNames.add(d.Value);
      }
      nextToken = lm.NextToken;
    } while (nextToken);
    perSkill = await Promise.all(Array.from(skillNames).map(async (s) => {
      const [calls, errors] = await Promise.all([sum("Calls", "Skill", s), sum("Errors", "Skill", s)]);
      return { skill: s, calls, errors };
    }));
  } catch { /* best-effort */ }
  const totalCalls = perTool.reduce((s, x) => s + x.calls, 0);
  return { window: "24h", totalCalls, inprocessTotal: inproc.total, perTool, perSkill };
}

/**
 * @kf-batch 50-WP4ter-coverage
 * @param opts.scope 传了就按区过滤**会话与工具调用**这两块。
 *
 * 🔴 如实登记:`agentcore` 与 `lambda` 两块是**运行时单实例**的指标
 * (用户 2026-09-10 拍板「都走同一个 AgentCore」⇒ 它本来就只有一套,技能 Lambda 同理),
 * 按区拆没有意义也拆不出来 ⇒ 页面上由 `partial` 说明条点名这两块不按区,不假装。
 */
export async function getGenBiObservability(opts?: { scope?: TargetScope }) {
  const [agentcore, itemsAll] = await Promise.all([agentcoreStatus(), scanGenBiHistory(1000)]);
  const items = opts?.scope ? filterRowsByScalar(itemsAll as Array<Record<string, unknown>>, opts.scope, "genbi") : itemsAll;
  const [lambda, toolCalls] = await Promise.all([lambdaMetrics().catch(() => ({})), toolCallMetrics(items).catch(() => ({}))]);
  return { agentcore, genbi: genbiStats(items), lambda, toolCalls, generatedAt: new Date().toISOString() };
}
