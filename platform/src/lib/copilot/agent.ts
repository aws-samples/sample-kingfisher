// 模块 44 — Copilot 进程内 agent(Bedrock Converse tool-use 循环)。
// 既是【默认后端】(COPILOT_BACKEND=inprocess,零基建即可用),也是 AgentCore 的【失败回退】
// (标准契约 7:try Runtime → catch 回退 inprocess,不让本可用功能 500)。
// 与将来 AgentCore 容器共享同一份工具注册表声明(防两处漂移)。

// @kf-batch 50-WP31-place-first-class —— 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { BedrockRuntimeClient, ConverseCommand, type Message, type Tool } from "@aws-sdk/client-bedrock-runtime";
import { COPILOT } from "./config";
// @kf-batch 50-W5-seg2-WP8 — 模块 51:两处 Converse 的 modelId 改调用处求值(循环外解析一次候选层,经 invokeConverse 退避/降级),
// 不再读模块加载期常量 COPILOT.modelId(COPILOT 其余字段不动)。
import { resolveLayered } from "@/lib/ai/model";
import { invokeConverse } from "@/lib/ai/invoke";
import type { AiModelUse } from "@/lib/ai/meta";
import { buildTools, getTool, toolSpecs } from "./tools/registry";
import { systemPrompt } from "./prompt";
import type { CopilotCaller } from "./tools/types";

const bedrock = sdkClient("model", BedrockRuntimeClient, { region: COPILOT.region });

export interface CopilotStep {
  tool: string;
  kind: string;
  ok: boolean;
  inputSummary?: string;
  outputSummary?: string;
  durationMs?: number;
}

export interface CopilotAskInput {
  prompt: string;
  caller: CopilotCaller;
  canCreate: boolean; // 闸3:调用者是否具 editor 角色 → 决定是否装入创建工具(否则只读)
  history?: { question: string; answer: string }[];
  memory?: string;
}

export interface CopilotAskOutput {
  answer: string;
  steps: CopilotStep[];
  usage: { inputTokens: number; outputTokens: number };
  // @kf-batch 50-W5-seg2-WP8 — 模块 51 `_meta` 回显:实际用的模型(agentcore 路径由容器回执;copilot 容器不在本仓,可缺省)。
  model?: AiModelUse;
}

function summarize(v: any, n = 200): string {
  try { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + "…" : s; }
  catch { return String(v).slice(0, n); }
}

// 运行 Copilot 一轮问答:tool-use 循环直到模型停止要工具、到 maxIters 或到墙钟软上限。
// 墙钟软上限(DEADLINE_MS,默认 45s < CloudFront origin 60s 硬超时):同步请求绝不能跑过 60s
// 否则 CloudFront 返 504 HTML 前端 JSON.parse 崩(GenBI 当年踩坑,见 [[genbi-async-b1plus]])。
// 到软上限后不再进下一轮,基于已有信息收尾——宁可少一轮工具,也不撞 60s 墙。
export async function runCopilot(input: CopilotAskInput): Promise<CopilotAskOutput> {
  const { prompt, caller } = input;
  const tools = buildTools(input.canCreate); // 按角色收敛工具集:viewer 只读,editor 才含创建工具
  // 多轮对话高保真(对齐 GenBI infra/agent/genbi/agent.js):把历史构造成真正的交替 user/assistant
  // Converse messages(取最近若干轮),而非仅塞进系统提示文本——模型对多轮上下文的理解更准。
  // 故 systemPrompt 不再注入 history(避免与 messages 重复);memory(长期摘要)仍进系统提示。
  const system = [{ text: systemPrompt({ memory: input.memory, canCreate: input.canCreate }) }];
  const toolConfig: { tools: Tool[] } = { tools: toolSpecs(tools) as unknown as Tool[] };
  const messages: Message[] = [];
  for (const h of (input.history || []).slice(-6)) {
    if (h.question) messages.push({ role: "user", content: [{ text: h.question }] });
    // assistant 内容不能为空(Converse 报错),空答用占位;严格交替 user/assistant。
    messages.push({ role: "assistant", content: [{ text: h.answer || "(无回复)" }] });
  }
  messages.push({ role: "user", content: [{ text: prompt }] });
  const steps: CopilotStep[] = [];
  let inTok = 0, outTok = 0;
  const deadlineMs = COPILOT.deadlineMs;
  const startedAt = Date.now();
  // @kf-batch 50-W5-seg2-WP8:循环外求值一次候选层;`used` = 最近一次实际用的模型(降级则为回落层)。
  const layers = await resolveLayered("copilot");
  let used: AiModelUse = { modelId: layers[0].modelId, modelSource: layers[0].source };
  const converse = async (msgs: Message[], withTools: boolean) => {
    const inv = await invokeConverse("copilot", undefined, bedrock, (modelId) => new ConverseCommand({
      modelId,
      system,
      messages: msgs,
      ...(withTools ? { toolConfig } : {}),
      inferenceConfig: { maxTokens: COPILOT.maxTokens },
    }), {}, { layers });
    used = { modelId: inv.usedModelId, modelSource: inv.usedSource, ...(inv.degraded ? { degraded: true } : {}) };
    return inv.response;
  };

  for (let i = 0; i < COPILOT.maxIters; i++) {
    // 墙钟软上限:已超时则跳出循环,让模型基于已收集信息给最终答复(下方最后一次无工具 Converse)。
    if (Date.now() - startedAt > deadlineMs) break;
    const resp = await converse(messages, true);
    inTok += resp.usage?.inputTokens || 0;
    outTok += resp.usage?.outputTokens || 0;
    const out = resp.output?.message;
    if (out) messages.push(out);

    if (resp.stopReason !== "tool_use") {
      const answer = (out?.content || []).map((b: any) => b.text).filter(Boolean).join("\n").trim();
      return { answer, steps, usage: { inputTokens: inTok, outputTokens: outTok }, model: used };
    }

    // 执行模型请求的工具(P44.1 全为只读)。
    const toolResults: any[] = [];
    for (const blk of out?.content || []) {
      const tu = (blk as any).toolUse;
      if (!tu || !tu.toolUseId) continue;
      const tool = getTool(tools, tu.name);
      const t0 = Date.now();
      let res;
      if (!tool) {
        res = { success: false, error: `unknown tool: ${tu.name}` };
      } else {
        // 安全兜底:进程内 agent 只执行 read/create 工具;绝不存在 execute。P44.1 仅 read。
        try { res = await tool.handler(tu.input || {}, caller); }
        catch (e: any) { res = { success: false, error: String(e?.message || e).slice(0, 300) }; }
      }
      steps.push({
        tool: tu.name, kind: tool?.kind || "unknown", ok: res.success !== false,
        inputSummary: summarize(tu.input), outputSummary: summarize(res.data ?? res.error),
        durationMs: Date.now() - t0,
      });
      toolResults.push({
        toolResult: {
          toolUseId: tu.toolUseId,
          content: [{ json: res }],
          ...(res.success === false ? { status: "error" } : {}),
        },
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  // 循环因 maxIters 或墙钟软上限退出(而非模型主动收尾):最后一条可能仍是 tool_use 或工具结果,
  // 无自然语言答复。再发【一次不带工具】的 Converse,强制模型基于已收集信息给出文字总结(不会再要工具)。
  // 这既避免"空答复",也保证到软上限时用户拿到有意义的回复而非撞 60s 墙。
  try {
    const finalResp = await converse(
      [...messages, { role: "user", content: [{ text: "请基于以上信息直接给出最终中文答复(不要再请求工具)。若无法完成用户诉求,请说明原因并建议下一步。" }] }],
      false
    );
    inTok += finalResp.usage?.inputTokens || 0;
    outTok += finalResp.usage?.outputTokens || 0;
    const answer = (finalResp.output?.message?.content || []).map((b: any) => b.text).filter(Boolean).join("\n").trim();
    if (answer) return { answer, steps, usage: { inputTokens: inTok, outputTokens: outTok }, model: used };
  } catch { /* 收尾 Converse 失败则退回下方兜底文案 */ }

  const last = messages[messages.length - 1];
  const answer = (last?.content || []).map((b: any) => b.text).filter(Boolean).join("\n").trim()
    || "(本轮信息较多,请把问题拆得更具体一些,我再帮你分析)";
  return { answer, steps, usage: { inputTokens: inTok, outputTokens: outTok }, model: used };
}

// 供 UI/路由展示只读工具元数据(能力透明化;创建工具随角色收敛,不在此静态列出)。
export { readToolMeta as listToolMeta } from "./tools/registry";
