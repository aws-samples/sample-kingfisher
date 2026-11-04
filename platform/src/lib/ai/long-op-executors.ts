// → —— 七种 AI 长调用的执行体(kind ↔ 执行体一一对应,tsc 钉死:少一个 / 多一个都编不过)。
// 2026-10-:框架从 lib/ai/long-call*.ts 泛化成 lib/long-ops/(全平台唯一),本文件只剩七个执行体原文,经 lib/long-ops/registry.ts 装配。
//
// 执行体 = 原七条 POST 路由的「主体」原样搬入:鉴权 / 入参校验 / 落点点名(`requestedTargetId`)**留在路由**,
// 这里只做「拿到已校验的入参 → 调模型 → 记记忆 / 审计 → 回 data + 实际用的模型」。
// ctx.req 是**承载这次执行的请求**:同步分支就是那次 POST;异步分支被别的轮询 GET 接管时就是那次 GET ——
// 两者都带同一用户的 Authorization(全局 fetch 拦截器加)⇒ Copilot 的用户 token 从这里取,不落库。

import type { NextRequest } from "next/server";
import { createHash } from "crypto";
import type { Identity } from "@/lib/auth/identity";
import { recordAudit } from "@/lib/audit";
import { LongOpHttpError } from "@/lib/long-ops/store";
import type { LongOpExecutorRegistry } from "@/lib/long-ops/executor-types";
import type { AiModelUse } from "./meta";
import { resolveModelRuntime } from "./model";
// copilot
import { isAgentCoreConfigured } from "@/lib/copilot/config";
import { runCopilot, type CopilotAskOutput } from "@/lib/copilot/agent";
import { invokeCopilotAgent } from "@/lib/copilot/agentcore-client";
import { appendTurn as copilotAppendTurn, loadShortTerm as copilotLoadShortTerm } from "@/lib/copilot/memory";
import type { CopilotCaller } from "@/lib/copilot/tools/types";
// 网络 / 参数顾问
import { advise as netAdvise } from "@/lib/network-advisor";
import { appendTurn as netAppendTurn, loadShortTerm as netLoadShortTerm } from "@/lib/network-advisor/memory";
import { advise as paramAdvise } from "@/lib/param-advisor";
import { appendTurn as paramAppendTurn, loadShortTerm as paramLoadShortTerm } from "@/lib/param-advisor/memory";
// codegen(离线作业 / EMR / 需求)
import { generateEtlCode, generateImplementation } from "@/lib/requirements/codegen";
import { getContextForGrounding, contextToPromptText } from "@/lib/genbi/context";
import { availableActions, getRequirement, isAssignee, saveGeneratedImplementation } from "@/lib/requirements/service";
// Flink SQL
import { generateFlinkSql } from "@/lib/realtime/flink-sql-ai";

export type { LongOpExecContext as AiExecContext } from "@/lib/long-ops/executor-types";
import type { LongOpExecContext, LongOpExecutor } from "@/lib/long-ops/executor-types";

function bearerToken(req: NextRequest): string {
  const authz = req.headers.get("authorization") || "";
  return authz.startsWith("Bearer ") ? authz.slice(7) : "";
}

async function resolvedModelFor(capability: "copilot" | "net-advisor" | "param-advisor"): Promise<AiModelUse> {
  const resolved = await resolveModelRuntime(capability);
  return { modelId: resolved.modelId, modelSource: resolved.source };
}

// ── ① Copilot 问答(原 app/api/copilot/ask/route.ts 主体) ──
// 铁律(AgentCore 标准契约 7):agentcore 启用后 try Runtime → catch 回退 inprocess;usedBackend 如实反映。
const copilotAsk: LongOpExecutor<"copilot-ask"> = async (params, ctx) => {
  const { prompt, conversationId, projectId, env, canCreate } = params;
  const caller: CopilotCaller = { token: bearerToken(ctx.req), projectId, env };
  const history = conversationId ? await copilotLoadShortTerm(conversationId) : [];
  let out: CopilotAskOutput;
  let usedBackend: "agentcore" | "inprocess" = "inprocess";
  if (isAgentCoreConfigured()) {
    try {
      const sessionId = "copilot-" + createHash("sha256").update(conversationId || "default").digest("hex").slice(0, 48);
      out = await invokeCopilotAgent(sessionId, { prompt, projectId, env, token: caller.token, canCreate, history }, { abortSignal: ctx.abortSignal });
      usedBackend = "agentcore";
    } catch {
      out = await runCopilot({ prompt, caller, canCreate, history });
      usedBackend = "inprocess";
    }
  } else {
    out = await runCopilot({ prompt, caller, canCreate, history });
  }
  if (conversationId) copilotAppendTurn(conversationId, { question: prompt, answer: out.answer }).catch(() => {});
  const createSteps = out.steps.filter((step) => step.kind === "create" && step.ok);
  recordAudit(ctx.req, "copilot.ask", {
    resourceType: "copilot",
    detail: { backend: usedBackend, steps: out.steps.length, creates: createSteps.length, canCreate },
  }).catch(() => {});
  for (const step of createSteps) {
    recordAudit(ctx.req, "copilot.create", { resourceType: "copilot", detail: { tool: step.tool, result: step.outputSummary } }).catch(() => {});
  }
  // agentcore 路径(copilot 容器不在本仓)无回执时如实回落解析值。
  const model = out.model ?? (await resolvedModelFor("copilot"));
  return { data: { ...out, backend: usedBackend }, meta: { model } };
};

// ── ② 网络顾问(原 app/api/network-advisor/advise/route.ts 主体) ──
const netAdviseExec: LongOpExecutor<"net-advise"> = async (params, ctx) => {
  const { request, conversationId, projectId } = params;
  const history = conversationId ? await netLoadShortTerm(conversationId, projectId).catch(() => []) : [];
  const rec = await netAdvise(request, history, { conversationId });
  if (conversationId) {
    const userMsg = request.userMessage || `${request.computeKind} → ${request.targets.map((target) => target.kind).join(",")}`;
    netAppendTurn(conversationId, { question: userMsg, answer: rec.reasoning }, projectId).catch(() => {});
  }
  void ctx;
  const model = rec.model ?? (await resolvedModelFor("net-advisor"));
  return { data: rec, meta: { model } };
};

// ── ③ 参数顾问(原 app/api/param-advisor/advise/route.ts 主体) ──
const paramAdviseExec: LongOpExecutor<"param-advise"> = async (params, ctx) => {
  const { request, conversationId, projectId } = params;
  const history = conversationId ? await paramLoadShortTerm(conversationId, projectId).catch(() => []) : [];
  const rec = await paramAdvise(request, history, { conversationId });
  if (conversationId) {
    const userMsg = request.userMessage || `${request.channel} 参数推荐(${JSON.stringify(request.workload || {})})`;
    paramAppendTurn(conversationId, { question: userMsg, answer: rec.reasoning }, projectId).catch(() => {});
  }
  void ctx;
  const model = rec.model ?? (await resolvedModelFor("param-advisor"));
  return { data: rec, meta: { model } };
};

// ── ④ 离线作业 AI 生成(原 app/api/etl-jobs/generate/route.ts 主体) ──
// 按作业绑定的区做目录 grounding(区由路由经 requestedTargetId 点名后落在 params.targetId)
const codegenEtl: LongOpExecutor<"codegen-etl"> = async (params, ctx) => {
  const bizCtx = contextToPromptText(await getContextForGrounding(params.projectId, params.prompt).catch(() => []));
  const gen = await generateEtlCode({ intent: params.prompt, currentCode: params.currentCode }, params.targetType, bizCtx, params.targetId, params.projectId);
  recordAudit(ctx.req, "etl-job.ai-generate", {
    resourceType: "etl-job",
    resourceId: "(draft)",
    detail: { targetType: params.targetType, outputTokens: gen.usage.outputTokens },
  }).catch(() => {});
  // data 比此前多回 `dialect`(页面 etl-jobs 一直在读它,此前服务端没给)。
  return {
    data: { targetType: params.targetType, code: gen.code, explanation: gen.explanation, usage: gen.usage, groundedOn: gen.groundedOn, dialect: gen.dialect },
    meta: { model: gen.model },
  };
};

// ── ⑤ EMR 作业 AI 生成(原 app/api/engines/generate/route.ts 主体;EMR Serverless PySpark 复用 Glue PySpark 生成器) ──
const codegenEmr: LongOpExecutor<"codegen-emr"> = async (params, ctx) => {
  const bizCtx = contextToPromptText(await getContextForGrounding(params.projectId, params.prompt).catch(() => []));
  const gen = await generateEtlCode({ intent: params.prompt, currentCode: params.currentCode }, "glue", bizCtx, params.targetId, params.projectId);
  recordAudit(ctx.req, "engine.ai-generate", {
    resourceType: "engine-job",
    resourceId: "(draft)",
    detail: { engine: "emr-serverless", outputTokens: gen.usage.outputTokens },
  }).catch(() => {});
  return { data: { code: gen.code, explanation: gen.explanation, usage: gen.usage, groundedOn: gen.groundedOn }, meta: { model: gen.model } };
};

// ── ⑥ 需求「大模型生成实现」(原 app/api/requirements/[id]/generate/route.ts 主体) ──
// 路由已做过 404 / 403 / 409 三道闸让用户秒得结论;这里**再核一遍**是为了被别的请求接管重跑时同样守住。
const codegenRequirement: LongOpExecutor<"codegen-requirement"> = async (params, ctx) => {
  const requirement = await getRequirement(params.requirementId);
  if (!requirement) throw new LongOpHttpError(404, "需求不存在");
  if (!isAssignee(requirement, ctx.identity)) throw new LongOpHttpError(403, "仅被指派的研发可生成实现");
  if (!["assigned", "in_development"].includes(requirement.status)) throw new LongOpHttpError(409, `当前状态(${requirement.status})不可生成实现`);
  const bizCtx = contextToPromptText(await getContextForGrounding(requirement.projectId, requirement.title).catch(() => []));
  const gen = await generateImplementation(requirement, params.targetType, bizCtx, params.targetId, requirement.projectId);
  const updated = await saveGeneratedImplementation(requirement, ctx.identity, {
    targetType: params.targetType,
    generatedCode: gen.code,
    explanation: gen.explanation,
    // 「按哪个区生成」记到实现上:「创建作业」据此要求绑定区含它
    groundedTargetId: gen.groundedOn.targetId,
  });
  recordAudit(ctx.req, "requirement.generate", {
    resourceType: "requirement",
    resourceId: requirement.requirementId,
    detail: { targetType: params.targetType, outputTokens: gen.usage.outputTokens },
  }).catch(() => {});
  return {
    data: {
      requirement: { ...updated, _actions: availableActions(updated, ctx.identity) },
      generated: { targetType: params.targetType, code: gen.code, explanation: gen.explanation, usage: gen.usage, groundedOn: gen.groundedOn },
    },
    meta: { model: gen.model },
  };
};

// ── ⑦ Flink SQL AI 生成(原 app/api/flink/ai-sql/route.ts 主体;现有 `model:` 字段保留,与 `_meta.modelId` 相等 M14) ──
const flinkAiSql: LongOpExecutor<"flink-ai-sql"> = async (params, ctx) => {
  const gen = await generateFlinkSql(params.prompt, params.sinkType);
  if (!/insert\s+into/i.test(gen.sql)) {
    throw new LongOpHttpError(422, "AI 生成的 SQL 未包含 INSERT INTO,请细化需求后重试");
  }
  recordAudit(ctx.req, "flink.ai_sql", { resourceType: "flink", detail: { sinkType: params.sinkType, promptLen: params.prompt.length, model: gen.model } }).catch(() => {});
  return {
    data: { sql: gen.sql, model: gen.model, usage: gen.usage, dialect: gen.dialect },
    meta: { model: { modelId: gen.model, modelSource: gen.modelSource } },
  };
};

/** 七种 AI 执行体(键集 = LONG_OP_KINDS 的 AI 子集;类型层钉死,`registry-wiring.test` 再钉源码字面)。 */
export type AiLongOpKind = "copilot-ask" | "net-advise" | "param-advise" | "codegen-etl" | "codegen-emr" | "codegen-requirement" | "flink-ai-sql";
export const AI_LONG_OP_EXECUTORS: Pick<LongOpExecutorRegistry, AiLongOpKind> = {
  "copilot-ask": copilotAsk,
  "net-advise": netAdviseExec,
  "param-advise": paramAdviseExec,
  "codegen-etl": codegenEtl,
  "codegen-emr": codegenEmr,
  "codegen-requirement": codegenRequirement,
  "flink-ai-sql": flinkAiSql,
};
