// 参数辅助顾问 Agent ——:接入 ②runtime 件(agent-runner),只声明"我的差异"。
//
// 【收敛前】本文件曾是 213 行:手写 for(iter) ConverseCommand 循环(与 netadvisor 逐字 73% 相同)
// + CATALOG_TEXT(6401 字手抄自 catalog.ts)+ systemPrompt 手抄。
// 【收敛后】循环骨架 → _runtime/agent-runner(Strands 装配,net/copilot 共用);
// systemPrompt/firstTurnText → core-dist(与 platform inprocess 同源,消手抄漂移)。
// 本文件只剩"参数顾问的差异":request 注入器 + 权威结果工具名 + finalize 结构。
// _runtime 是平台级共享源(infra/agent/_runtime),由 prebuild 分发进本容器目录内(同 core-dist 机制)——
// Docker 构建上下文是本目录,COPY 不能出上下文,故分发进来后走 ./_runtime 相对 import。
import { runAdvisorAgent } from "./_runtime/agent-runner.js";
// @paramadvisor/core 编译产物(prebuild copy 进 core-dist):systemPrompt/firstTurnText 与 platform inprocess 同源。
import { systemPrompt, firstTurnText } from "./core-dist/prompt.js";

const MAX_ITERS = parseInt(process.env.PARAMADVISOR_MAX_ITERS || "6", 10);
const MAX_TOKENS = parseInt(process.env.PARAMADVISOR_MAX_TOKENS || "2000", 10);

// 参数顾问 spec(差异声明):
//   inject        —— 无状态请求上下文 request 注入每个工具调用(技能 Lambda 的 SkillEvent.request 契约)
//   captureSuffix —— recommend_parameters 是一站式推荐(结构化字段的权威来源)
//   finalize      —— 组装参数顾问 wire(recommendations/prefill/questions/historyFacts/confidence)
export async function runAgent(input) {
  return runAdvisorAgent(input, {
    clientName: "bgp-paramadvisor-agent",
    systemPrompt: (req) => systemPrompt(req.channel),
    firstTurnText: (req) => firstTurnText(req),
    inject: (raw, req) => ({ ...raw, request: req }),
    captureSuffix: "recommend_parameters",
    maxIters: MAX_ITERS,
    maxTokens: MAX_TOKENS,
    finalize: (reasoning, lastRecommend, steps, usage) => ({
      reasoning,
      recommendations: lastRecommend?.recommendations || [],
      prefill: lastRecommend?.prefill || null,
      questions: lastRecommend?.questions || [],
      historyFacts: lastRecommend?.historyFacts || null,
      confidence: typeof lastRecommend?.confidence === "number" ? lastRecommend.confidence : 0.3,
      steps,
      llmAvailable: true,
      usage,
    }),
  });
}
