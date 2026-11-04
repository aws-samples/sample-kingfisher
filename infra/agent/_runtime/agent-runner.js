// runtime 件 —— 顾问型 Agent 容器运行时装配模板(平台级共享源)。
//
// 【为什么存在】测绘铁证:netadvisor 与 paramadvisor 的 runAgent() 循环骨架 89 行里 65 行逐字相同
// (73%),唯一真差异 = finalize 返回哪些字段。若各容器复刻 = 把这 73% 抄 N 遍(与 modelId 散落同病)。
// 本模块把通用循环骨架收敛成【一份源】,经 prebuild 分发进各容器;各能力只声明"我的差异"(spec)。
//
// 【循环框架】用 Strands Agent(与 GenBI 阶段3 同,已线上 Runtime READY 验证生产可用),
// 替代 net/param 的手写 for(iter) ConverseCommand 循环——统一到 Strands 初衷。
//
// 【射程】L-Read 顾问型能力(paramadvisor/netadvisor);copilot 远程(L-Create)在其上叠加扩展契约。
// GenBI 暂不迁(镜像红线 + retrieval 复杂 prepare 阶段特例 + 已 P1 收官作样板/容灾)。
import { Agent, BedrockModel, tool } from "@strands-agents/sdk";
import { MCPClient } from "./mcp.js";
// (51 SPEC §7.2 容器落点):厂商档案的 maxTokens 系数(Kimi K3 ×2;Claude 恒等)。
//   路径按**容器内布局**写:本文件经 core-prebuild 分发到 <容器>/_runtime/,core-dist/ai 在 <容器>/core-dist/ai ⇒ ../core-dist/ai。
//   (在 infra/agent/_runtime 这个源位置它不被执行,只被分发。)
import { shapeInferenceConfig } from "../core-dist/ai/converse-shape.js";
// 瞬态流错误判定 + 有界抖动退避(与 genbi 容器 / 平台同一份清单)
import { describeModelError, TRANSIENT_MAX_RETRIES, transientBackoffMs } from "../core-dist/ai/transient.js";

const REGION = process.env.AWS_REGION || "us-east-1";
const GATEWAY_URL = process.env.GATEWAY_URL || "";

// (容器读侧,SPEC §4-B / §6.1⑤):
// 模型 = payload.modelId(平台按运行时配置透传,热生效)‖ env BEDROCK_MODEL_ID(CDK 从 SSOT 注入)。
// 🔴 删掉了此前手抄的兜底字面量(sonnet-4-5,已与 SSOT opus-4-6 漂移 —— DESIGN §1.1 坐实):容器是纯 JS、
// 读不到 repo 的 ai-model.json,任何手抄值都会再漂;唯一不漂的做法 = 只认注入来源,两者都缺就**明确报错**(fail-closed),
// 而不是静默用一个过期模型跑。生产由 CDK 恒注入 env,本地裸跑请自行 export BEDROCK_MODEL_ID。
export function resolveContainerModelId(input) {
  const fromPayload = input && typeof input.modelId === "string" ? input.modelId.trim() : "";
  if (fromPayload) return { modelId: fromPayload, source: "payload" };
  const fromEnv = (process.env.BEDROCK_MODEL_ID || "").trim();
  if (fromEnv) return { modelId: fromEnv, source: "env" };
  throw new Error("模型未配置:payload.modelId 与 env BEDROCK_MODEL_ID 均为空(容器不再内置兜底模型名,防 SSOT 漂移)");
}

// 顾问型 Agent 通用装配。各能力容器 agent.js 只需声明 spec,调用本函数。
//
// spec 契约(证据:唯一需参数化的几点):
//   spec.clientName    : MCP init 的 clientInfo.name(如 "bgp-paramadvisor-agent")
//   spec.systemPrompt  : (req) => string   —— 来自 core-dist(消手抄)
//   spec.firstTurnText : (req) => string   —— 来自 core-dist
//   spec.inject        : (rawArgs, req) => finalArgs  —— 上下文注入(硬冲突1)。
//                        advisor: (raw, req) => ({ ...raw, request: req })
//   spec.captureSuffix : string —— 权威结果工具名后缀(param:"recommend_parameters" / net:"analyze_connectivity")
//   spec.finalize      : (reasoning, lastCaptured, steps, usage) => wireObject —— 唯一真差异:组装各自结构
//   spec.maxIters      : number(默认 env 或 8)
//   spec.maxTokens     : number(默认 env 或 2400)
export async function runAdvisorAgent(input, spec) {
  const req = input.request;
  if (!GATEWAY_URL) throw new Error("GATEWAY_URL 未配置");
  // 每次 invoke 求值(payload 优先),并把实际用的模型回显在 wire 的 _meta(平台侧校验相等)。
  const { modelId: MODEL_ID, source: modelSource } = resolveContainerModelId(input);
  const withMeta = (wire) => ({ ...wire, _meta: { modelId: MODEL_ID, modelSource } });

  const maxIters = spec.maxIters || 8;
  const maxTokens = spec.maxTokens || 2400;

  const mcp = new MCPClient(GATEWAY_URL, REGION, spec.clientName || "bgp-agent");
  await mcp.init();
  const tools = await mcp.listTools();

  // 多轮对话历史 → 交替 user/assistant 前缀(与手写版同构),供 Strands messages 预置。
  const messages = [];
  for (const h of (input.history || []).slice(-6)) {
    if (!h || !h.question) continue;
    messages.push({ role: "user", content: [{ text: String(h.question) }] });
    messages.push({ role: "assistant", content: [{ text: String(h.answer || "(上一轮无文字结论)").slice(0, 4000) }] });
  }

  const steps = [];
  let lastCaptured = null; // 最后一次"权威结果工具"(spec.captureSuffix)的结构化结果 —— 各能力结构字段的权威来源。

  // 热加载:Gateway 发现的工具 → Strands tool。每个工具包一层回调:
  // 注入无状态 request(spec.inject)+ 记 step + 捕获权威结果(spec.captureSuffix)+ 错误回传模型自愈。
  const strandsTools = (tools || []).filter((t) => t && t.name).map((t) => tool({
    name: t.name.split("___").pop() || t.name, // 短名(去 Gateway target 前缀)作模型可见工具名
    description: t.description || t.name,
    inputSchema: (t.inputSchema && typeof t.inputSchema === "object") ? t.inputSchema : { type: "object", properties: {} },
    callback: async (rawInput) => {
      const raw = (rawInput && typeof rawInput === "object") ? rawInput : {};
      const args = spec.inject ? spec.inject(raw, req) : raw; // 硬冲突1:上下文注入(advisor 注入整个 request)
      let res, err;
      try { res = await mcp.callTool(t.name, args); } catch (e) { err = e; } // 用完整 Gateway 名调用
      const ok = !err && !(res && res.success === false);
      steps.push({ tool: t.name.split("___").pop() || t.name, ok, error: err ? String(err.message || err) : (res && res.error) });
      // 捕获最后一次权威一站式结果(结构化字段的权威来源)。
      if (ok && spec.captureSuffix && t.name.endsWith(spec.captureSuffix)) lastCaptured = res;
      if (err) return { success: false, error: String((err.message) || err) }; // 错误回传模型自愈
      return res || { ok: true };
    },
  }));

  // Agent 用工厂建:瞬态流错误重试时**重建**(上一轮可能留下半截 assistant 消息),历史用浅拷贝不被改。
  const mkAgent = () => new Agent({
    model: new BedrockModel({ modelId: MODEL_ID, region: REGION, maxTokens: shapeInferenceConfig(MODEL_ID, { maxTokens }).config.maxTokens }),
    systemPrompt: spec.systemPrompt(req),
    tools: strandsTools,
    messages: [...messages],
    printer: false,              // 关闭 Strands 控制台进度输出(容器日志干净)
    limits: { turns: maxIters },  // 迭代上限(超限优雅停止)
  });

  const t0 = Date.now();
  let result;
  for (let attempt = 0; ; attempt++) {
    try {
      result = await mkAgent().invoke(spec.firstTurnText(req));
      break;
    } catch (e) {
      // 【可观测性】详打错误现场(name/message/stack/关键字段),诊断降级根因用——绝不静默吞错。
      const d = describeModelError(e);
      console.error(`[agent-runner] agent.invoke 抛错 cap=${spec.clientName} attempt=${attempt} transient=${d.transient} ` +
        `elapsedMs=${Date.now() - t0} name=${d.name} msg=${d.message} ` +
        `code=${e && (e.$metadata?.httpStatusCode || e.code || e.Code)} ` +
        `hasCaptured=${!!lastCaptured} stepsN=${steps.length}`);
      if (e && e.stack) console.error(`[agent-runner] stack: ${String(e.stack).slice(0, 800)}`);
      // 瞬态(流中途断 / 限流 / 5xx)重试一次(有界、全幅抖动;2026-10-14 …7698 Kimi K3 真环境实证);其它错误不重试。
      if (d.transient && attempt < TRANSIENT_MAX_RETRIES) {
        const waitMs = transientBackoffMs(attempt);
        steps.push({ tool: "model", ok: false, error: d.message.slice(0, 200), retry: `瞬态模型错误,${waitMs}ms 后重试(第 ${attempt + 1} 次)` });
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      // 兜底:Strands 抛错时仍返回可用 wire(已记 steps + 已捕获的权威结果),降级到确定性结果。
      return withMeta(spec.finalize(
        `(执行异常:${d.message.slice(0, 200)})`,
        lastCaptured, steps, { inputTokens: 0, outputTokens: 0 },
      ));
    }
  }

  const reasoning = (result.lastMessage?.content || []).map((b) => ("text" in b ? b.text : "")).join("").trim();
  const usage = result.metrics?.accumulatedUsage || {};
  const stopped = result.stopReason && !["endTurn", "end_turn", "stop", "stopSequence"].includes(result.stopReason);
  // 【可观测性】每次 invoke 成功后打一行结果摘要:stopReason/reasoning长度/工具步数/token/耗时。
  // 用于诊断"invoke 成功但无 reasoning 文本→走兜底文案"(与抛错降级是两种不同现象,须能区分)。
  console.log(`[agent-runner] invoke ok cap=${spec.clientName} elapsedMs=${Date.now() - t0} ` +
    `stopReason=${result.stopReason} reasoningLen=${reasoning.length} stepsN=${steps.length} ` +
    `hasCaptured=${!!lastCaptured} inTok=${usage.inputTokens || 0} outTok=${usage.outputTokens || 0}`);
  if (!reasoning) {
    console.warn(`[agent-runner] invoke 成功但 reasoning 为空(将用兜底文案) stopReason=${result.stopReason} ` +
      `lastMessageKeys=${result.lastMessage ? Object.keys(result.lastMessage).join(",") : "null"}`);
  }
  const finalReasoning = reasoning || (stopped
    ? "(已达最大推理步数,以下为基于确定性引擎的结果。)"
    : "(未能生成结论,请重试。)");
  return withMeta(spec.finalize(finalReasoning, lastCaptured, steps, {
    inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0,
  }));
}
