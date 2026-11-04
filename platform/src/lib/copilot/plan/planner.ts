// 模块 44 — Copilot 规划大脑(Planner)。用 Strands Agents 官方 TS SDK 实现。
//
// 职责(纯只读):用户一句话诉求 →【发现】并行调只读工具摸清现状 →【规划】推理出最小执行路径 →
// 产出结构化 PlanSpec(Strands structuredOutputSchema + Zod 自动校验 + 失败重试)。
//
// 安全铁律(见 PLAN-EXECUTE-DESIGN.md §1、§3):
//  - 工具集【只有只读发现工具】,无任何建/跑工具 → 闸1 能力面根除在 Strands 框架内依然成立。
//  - 建 draft 延迟到用户"确认某步"(不在规划回合内发生)。
//  - 不硬编码电商/游戏:表名/指标由发现结果填充([[qa-findings-2026-07-14-user-retest]] 教训)。
//  - 诚实缺口:发现不到源数据 → 计划如实说明,steps 可为空,不臆造。
//  - 墙钟安全:规划链路受 CloudFront 60s 硬超时约束([[genbi-async-b1plus]]);invoke 设 cancelSignal +
//    turns 上限,超时中止后仍尽力返回已有结论(路由层可选异步化)。
//
// 与现有 lib/copilot/agent.ts(手写 Converse 通用问答)物理分离:那个保留不动,这个是规划专用。

import { Agent, BedrockModel, StructuredOutputError } from "@strands-agents/sdk";
import { COPILOT } from "../config";
import { buildStrandsReadTools } from "./strands-tools";
import { PlanSpecSchema } from "./plan-schema";
import { allDialectRulesForPrompt } from "../recipes/registry";
import type { CopilotCaller } from "../tools/types";
import type { PlanSpec } from "./types";
// @kf-batch 50-W5-seg2-WP8 — 模块 51:Strands 变体(SPEC §3.3 / §3.5 形态②):BedrockModel({modelId}) 在 runAgent 闭包内按
// 候选层求值,整个 agent.invoke 作为可重试单元(planner 工具只读幂等);不再读模块加载期常量 COPILOT.modelId。
import { invokeAgent } from "@/lib/ai/invoke";
// @kf-batch 51-v2-multi-vendor —— Strands 变体没有 ConverseCommand 可整形,但 maxTokens 系数(Kimi K3 ×2)同样要吃;Claude 恒等
import { shapeInferenceConfig } from "@/lib/ai/core/converse-shape";
import type { AiModelUse } from "@/lib/ai/meta";

// 把配方库的方言硬规则(单一事实源)注入提示词——AI 生成前就知道所有 error 级硬约束。
// 与 lookup_recipe 工具、dialect-guard 共享同一份规则(改规则只改 recipes/*.ts 一处)。
function dialectRulesBlock(): string[] {
  const lines: string[] = ["", "【各引擎方言硬约束(生成对应步骤 SQL/代码必须遵守;详情用 lookup_recipe 查)】"];
  for (const { engine, rules } of allDialectRulesForPrompt()) {
    if (!rules.length) continue;
    lines.push(`· ${engine}:`);
    for (const r of rules) lines.push(`  - ${r}`);
  }
  return lines;
}

export interface PlanResult {
  spec: PlanSpec;
  usage?: { inputTokens?: number; outputTokens?: number };
  degraded?: boolean; // true = 结构化产出失败已降级兜底(如超时/校验失败)
  // @kf-batch 50-W5-seg2-WP8 — 模块 51:实际用的模型(落进 bgp-copilot-plan-tasks 任务项 usedModelId;SPEC §3.3a ⑧)
  model?: AiModelUse;
}

// 规划大脑系统提示:发现→规划两阶段,强调只读、最小路径、诚实缺口、不硬编码。
function plannerSystemPrompt(): string {
  return [
    "你是 Kingfisher 大数据治理平台的【规划大脑】。用户会用一句话描述数据诉求(如「帮我把广告 ROI 算出来」),",
    "你的任务是:先用只读工具【发现现状】,再推理出在本平台上把它算出来的【最小执行路径】,产出一份结构化执行计划。",
    "",
    "【工作方式:先发现,再规划】",
    "1. 发现阶段(用只读工具,可多次调用):",
    "   - 有没有现成指标? → find_metric(先查,若已有 ROI/ROAS 等现成指标,可能不必再建作业,直接查即可)。",
    "   - 目标表在数仓/湖里有没有?【列名是什么?】→ discover_catalog(target=warehouse 查 Redshift 数仓,lake 查 S3 Tables 数据湖)。",
    "     ⚠ 若你要写 SQL 引用某表的列,【必须】先用 discover_catalog 看到该表的真实列名再写,【严禁凭空猜列名】(猜错列名 SQL 必然报错)。",
    "   - 【写 SQL/代码前必查配方】→ lookup_recipe(engine):拿该引擎的【方言硬规则 + 验证过的代码范式】。",
    "     写 redshift-sql 前必查 engine=redshift(照 CTAS/UPSERT/窗口范式写,避免方言报错);写 S3Table/EMR 前查 s3tables/emr。",
    "   - 源头有没有相关数据? → list_datasources 拿数据源,再 introspect_source_tables 看源库表列。",
    "   - 某表数据从哪来、链路有没有? → get_lineage。某同步/作业最近跑成功没? → check_run_status。",
    "   - 业务口径/指标定义 → lookup_business_context(如 ROI 的计算口径)。",
    "2. 规划阶段:基于发现结果,推理出把诉求实现的【最小步骤序列】。",
    "",
    "【步骤类型(每步选其一)】",
    "- sync-glue:建 Glue 批同步任务(把源库表同步进数仓/湖)。",
    "- sync-dms:建 DMS 实时同步任务(CDC 近实时)。",
    "- redshift-sql:建 Redshift SQL 离线作业(在数仓里做聚合/计算,如算 ROI)。",
    "- glue:建 Glue PySpark 离线作业(在数据湖里做重计算)。",
    "- emr:建 EMR Serverless 作业(大规模 Spark 计算)。网络(VPC 子网/安全组)【平台自动配置默认私有子网+出网】,你无需操心、也不要臆造 subnetIds/securityGroupIds;专注写正确的计算逻辑即可。",
    "- query-only:直接查数据验证结果(仅作计划终点,指引用户去查询页/问数页自己查,不代跑 SQL)。",
    "",
    "【写 SQL/代码的硬规则 —— 违反则作业跑必报错】",
    "1. 生成 SQL/代码前【必须先 lookup_recipe(engine)】拿到该引擎的方言规则和验证过的范式,照着写。",
    "2. 引用的每个表名、列名【必须】来自 discover_catalog 的真实返回;不确定的列不要写进 SQL。",
    "3. 若关键列/口径无法从发现结果确定(如归因关系、金额列名不明),【不要硬写会报错的 SQL】——",
    "   改为把该步骤 script 留空或只给注释框架,rationale 说明'需用户在作业页确认列名后补全',让用户去页面补。",
    ...dialectRulesBlock(),
    "",
    "【关键原则 —— 必须遵守】",
    "- 你【只做规划,不执行也不创建】。你没有建/跑任何东西的工具,只能发现+产计划。建与跑由用户后续在页面逐步确认。",
    "- 产出【最小必要路径】:若已有现成指标或数据已就绪,steps 可能只有 1 步(query-only)甚至 0 步(直接在 summary 答复)。不要多余步骤。",
    "- 步骤间有先后依赖时,用 dependsOnSeq 表达(如'先同步(seq1)再计算(seq2)',则 seq2 的 dependsOnSeq=[1])。",
    "- 【诚实】:若发现源头根本没有相关数据、无法完成,就在 findings 如实说明、steps 给空数组,绝不臆造步骤或编造表名。",
    "- 【不硬编码】:所有表名/指标/数据源必须来自发现工具的真实返回,不要凭空假设是电商或游戏数据。",
    "- 每步的 params 尽量给出你已知的字段(如同步给 datasourceId/sourceTable/targetType;SQL 作业给 name 和你能写出的 script),不确定的留空,后续用户在页面补。",
    "  ⚠ sync-glue/sync-dms 的 targetType 只有三个合法值:【s3-tables】(数据湖) / 【redshift】(数仓) / 【both】。" +
    "  不要写 discover_catalog 用的 warehouse/lake ——那是查询工具的词,不是 targetType 的值(数仓→redshift,数据湖→s3-tables)。",
    "",
    "最终必须产出符合给定 schema 的结构化计划(summary + findings + steps)。",
  ].join("\n");
}

// 兜底 PlanSpec:结构化产出失败(超时/校验失败/异常)时,返回一个诚实的"无法自动规划"计划(0 步)。
function fallbackSpec(reason: string): PlanSpec {
  return {
    summary: "未能自动生成结构化执行计划",
    findings: `规划大脑本轮未能完成结构化规划(${reason})。请把诉求描述得更具体一些,或在对应页面手动操作。`,
    steps: [],
  };
}

// 运行规划大脑一轮:发现 + 规划 → PlanSpec。
// deadlineMs:墙钟软上限。异步执行(推荐)传大值(如 200s,<任务天花板 240s);
//   若同步调用则须 <CloudFront 60s(传 COPILOT.planDeadlineMs)。默认取 planDeadlineMs(保守)。
export async function runPlanner(input: { prompt: string; caller: CopilotCaller; deadlineMs?: number }): Promise<PlanResult> {
  const { prompt, caller } = input;
  const deadlineMs = input.deadlineMs ?? COPILOT.planDeadlineMs;

  // 墙钟软上限:异步执行体传大值(不受 60s 墙,只受任务天花板);同步调用须 <CloudFront 60s。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);

  // @kf-batch 50-W5-seg2-WP8:agent 型 —— modelId 由 invokeAgent 按候选层给出,每次尝试新建 BedrockModel + Agent;
  // 限流(含 Strands ModelThrottledError)退避重试,仍限流/不可用则降级回落下一层模型。
  const runAgent = async (modelId: string) => {
    const model = new BedrockModel({
      region: COPILOT.region,
      modelId,
      // 计划专用:多步骤结构化 JSON 需更大输出预算;再按厂商档案系数放大(恒带推理块的 Kimi K3 ×2,其余 ×1)
      maxTokens: shapeInferenceConfig(modelId, { maxTokens: COPILOT.planMaxTokens }).config.maxTokens,
    });
    const agent = new Agent({
      model,
      systemPrompt: plannerSystemPrompt(),
      tools: buildStrandsReadTools(caller), // 只读发现工具;无建/跑工具(闸1)
      printer: false, // 服务端:不往 stdout 打印
    });
    return agent.invoke(prompt, {
      structuredOutputSchema: PlanSpecSchema,
      cancelSignal: controller.signal,
      // 计划专用轮次:发现(多轮只读工具)+ 结构化输出(强制工具至少 1 轮)。6 太紧,给 10。
      limits: { turns: COPILOT.planTurns },
    });
  };
  let used: AiModelUse | undefined;

  try {
    const inv = await invokeAgent("copilot-planner", undefined, runAgent);
    used = { modelId: inv.usedModelId, modelSource: inv.usedSource, ...(inv.degraded ? { degraded: true } : {}) };
    const result = inv.response;
    clearTimeout(timer);

    const so = result.structuredOutput as PlanSpec | undefined;
    // 诊断:记录 Strands 实际返回形态(stopReason / 有无 structuredOutput / lastMessage 摘要)。
    console.log("[copilot-planner] invoke done", JSON.stringify({
      stopReason: (result as any)?.stopReason,
      hasStructuredOutput: !!so,
      soType: so ? typeof so : "undefined",
      soKeys: so ? Object.keys(so as any) : [],
      lastMsgText: String((result as any)?.lastMessage?.content?.map?.((c: any) => c?.text).filter(Boolean).join(" ") || "").slice(0, 300),
    }));
    if (!so) {
      return { spec: fallbackSpec("模型未产出结构化计划"), degraded: true, model: used };
    }
    // 归一化:确保 steps 是数组、seq 唯一且从 1 递增稳定(模型偶发乱序/重号时纠正)。
    const spec = normalizeSpec(so);
    return {
      spec,
      usage: {
        inputTokens: result.metrics?.accumulatedUsage?.inputTokens,
        outputTokens: result.metrics?.accumulatedUsage?.outputTokens,
      },
      model: used,
    };
  } catch (e: any) {
    clearTimeout(timer);
    // 诊断:记录异常类型与消息(排查 Strands/Bedrock/结构化校验失败根因)。
    console.error("[copilot-planner] invoke error", JSON.stringify({
      name: e?.name, message: String(e?.message || e).slice(0, 500),
      aborted: controller.signal.aborted, isStructuredErr: e instanceof StructuredOutputError,
    }));
    if (e instanceof StructuredOutputError) {
      return { spec: fallbackSpec("结构化校验失败"), degraded: true, model: used };
    }
    if (controller.signal.aborted) {
      return { spec: fallbackSpec("规划超时"), degraded: true, model: used };
    }
    return { spec: fallbackSpec(String(e?.message || e).slice(0, 120)), degraded: true, model: used };
  }
}

// 归一化 PlanSpec:seq 去重/重排(1..N),dependsOnSeq 只保留指向本计划内更早步骤的引用(防环/防悬空)。
function normalizeSpec(raw: PlanSpec): PlanSpec {
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  // 按原始 seq 稳定排序后重新编号 1..N,建立旧→新映射。
  const sorted = [...steps].sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const oldToNew = new Map<number, number>();
  sorted.forEach((s, i) => oldToNew.set(s.seq, i + 1));
  const renumbered = sorted.map((s, i) => {
    const newSeq = i + 1;
    const deps = (s.dependsOnSeq || [])
      .map((d) => oldToNew.get(d))
      .filter((d): d is number => !!d && d < newSeq); // 只依赖更早的步骤(防环/防自依赖)
    return { ...s, seq: newSeq, dependsOnSeq: Array.from(new Set(deps)) };
  });
  return {
    summary: String(raw.summary || "").slice(0, 500),
    findings: String(raw.findings || "").slice(0, 2000),
    steps: renumbered,
  };
}
