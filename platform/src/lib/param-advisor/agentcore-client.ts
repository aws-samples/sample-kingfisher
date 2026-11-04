// 平台侧调用参数顾问 AgentCore Runtime(数据面 invoke_agent_runtime,IAM 鉴权)。
// 平台标准 docs/design/28-agentcore-standard/DESIGN.md §3 契约 4。照抄 network-advisor/agentcore-client.ts,
// 换 env 前缀(PARAMADVISOR_RUNTIME_ARN)+ Input/Output 接口(匹配容器 agent.js 的入参/返回)。调用骨架不动。
//
// 方案 A:Runtime 是【自包含能力服务】——容器内 Lambda 已跑确定性推荐引擎,直接返回结构化结论
// (recommendations/prefill/questions/historyFacts)。平台薄封装只透传 + 补 confidence 兜底。
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { homeRegion } from "@/lib/place/home-region";
import { sdkClient } from "@/lib/aws/clients";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import type { HistoryFacts, ParamAdviceRequest, ParamPrefill, ParamRecommendation } from "./types";
import type { AiModelUse } from "@/lib/ai/meta";
// payload 透传运行时模型 + 回执校验(缺/不等 ⇒ AgentCoreModelMismatch,fail-closed)。
import { resolveModelRuntime } from "@/lib/ai/model";
import { assertAgentCoreModelMeta, currentReleaseId } from "@/lib/ai/agentcore-contract";


const REGION = homeRegion();
const RUNTIME_ARN = process.env.PARAMADVISOR_RUNTIME_ARN || "";

const client = sdkClient("central:agentcore", BedrockAgentCoreClient, { region: REGION });

export interface ParamAdvisorInvokeInput {
  request: ParamAdviceRequest;
  history?: { question: string; answer: string }[];
}

// 容器 agent.js 的返回结构。
export interface ParamAdvisorInvokeOutput {
  reasoning: string;
  recommendations: ParamRecommendation[];
  prefill: ParamPrefill | null;
  questions: string[];
  historyFacts: HistoryFacts | null;
  confidence: number;
  steps?: { tool: string; ok: boolean; error?: string }[];
  llmAvailable: boolean;
  usage: { inputTokens: number; outputTokens: number };
  // 容器回执的实际模型(payload 透传 + 回执校验,⑥ 填实)。
  model?: AiModelUse;
}

export function isAgentCoreConfigured(): boolean {
  return !!RUNTIME_ARN;
}

export async function invokeParamAdvisorAgent(sessionId: string, input: ParamAdvisorInvokeInput): Promise<ParamAdvisorInvokeOutput> {
  if (!RUNTIME_ARN) throw new Error("PARAMADVISOR_RUNTIME_ARN 未配置");
  // 运行时模型透传 + releaseId。
  const resolved = await resolveModelRuntime("param-advisor");
  const payload = new TextEncoder().encode(JSON.stringify({ input, modelId: resolved.modelId, releaseId: currentReleaseId() }));
  const resp = await client.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: RUNTIME_ARN,
    runtimeSessionId: sessionId,
    qualifier: "DEFAULT",
    contentType: "application/json",
    accept: "application/json",
    payload,
  }));
  const body: unknown = (resp as { response?: unknown }).response;
  let text = "";
  if (body == null) text = "";
  else if (typeof (body as { transformToString?: () => Promise<string> }).transformToString === "function") {
    text = await (body as { transformToString: () => Promise<string> }).transformToString();
  } else if (body instanceof Uint8Array) text = Buffer.from(body).toString("utf-8");
  else text = String(body);
  const parsed = text ? JSON.parse(text) : {};
  const out = parsed.output || parsed;
  if (parsed.error && !Array.isArray(out.recommendations)) throw new Error(String(parsed.error).slice(0, 300));
  // 回执校验(缺 / 不等 ⇒ AgentCoreModelMismatch,fail-closed)。
  const echoed = assertAgentCoreModelMeta(out, resolved.modelId, "param-advisor");
  return {
    model: { modelId: echoed, modelSource: resolved.source },
    reasoning: out.reasoning || "",
    recommendations: Array.isArray(out.recommendations) ? out.recommendations : [],
    prefill: out.prefill || null,
    questions: Array.isArray(out.questions) ? out.questions : [],
    historyFacts: out.historyFacts || null,
    confidence: typeof out.confidence === "number" ? out.confidence : 0.5,
    steps: Array.isArray(out.steps) ? out.steps : [],
    llmAvailable: out.llmAvailable !== false,
    usage: out.usage || { inputTokens: 0, outputTokens: 0 },
  };
}
