// 平台侧调用网络顾问 AgentCore Runtime（数据面 invoke_agent_runtime，IAM 鉴权）。
// 平台标准见 docs/design/28-agentcore-standard/DESIGN.md §3 契约 4。照抄 genbi/agentcore-client.ts，
// 换 env 前缀(NETADVISOR_RUNTIME_ARN)+ Input/Output 接口(匹配容器 agent.js 的入参/返回)。调用骨架不动。
//
// 方案 A(用户拍板)：Runtime 是【自包含能力服务】——容器内 Lambda 已做 L2 权威裁决，直接返回结构化结论
// (verdict/rulings/candidates/remediations + facts 摘要)。平台薄封装只补 prefill/confidence/questions。
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { homeRegion } from "@/lib/place/home-region";
import { sdkClient } from "@/lib/aws/clients";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import type { PlacedConnectivityRequest, Ruling, Remediation, RecommendedPlacement, Verdict } from "./types";
import type { AiModelUse } from "@/lib/ai/meta";
// payload 透传运行时模型 + 回执校验(缺/不等 ⇒ AgentCoreModelMismatch,fail-closed)。
import { resolveModelRuntime } from "@/lib/ai/model";
import { assertAgentCoreModelMeta, currentReleaseId } from "@/lib/ai/agentcore-contract";


const REGION = homeRegion();
const RUNTIME_ARN = process.env.NETADVISOR_RUNTIME_ARN || "";

const client = sdkClient("central:agentcore", BedrockAgentCoreClient, { region: REGION });

export interface AdvisorInvokeInput {
  request: PlacedConnectivityRequest; // 已落点(region 来自描述符)—— 容器 / 技能 Lambda 按它探测
  history?: { question: string; answer: string }[];
}

// 容器 agent.js 的返回结构(Phase 3)。facts 为摘要版(标准 §7① 只回摘要)。
export interface AdvisorInvokeOutput {
  reasoning: string;
  verdict: Verdict;
  rulings: Ruling[];
  remediations: Remediation[];
  candidates: { placement: RecommendedPlacement; score: number; reason: string }[];
  chosenPlacement: RecommendedPlacement | null;
  facts: unknown | null; // 摘要 facts（summarizeFacts 产物；平台不用它重裁决）
  steps?: { tool: string; ok: boolean; error?: string }[];
  llmAvailable: boolean;
  usage: { inputTokens: number; outputTokens: number };
  // 容器回执的实际模型(payload 透传 + 回执校验,⑥ 填实)。
  model?: AiModelUse;
}

export function isAgentCoreConfigured(): boolean {
  return !!RUNTIME_ARN;
}

export async function invokeNetAdvisorAgent(sessionId: string, input: AdvisorInvokeInput): Promise<AdvisorInvokeOutput> {
  if (!RUNTIME_ARN) throw new Error("NETADVISOR_RUNTIME_ARN 未配置");
  // 运行时模型透传 + releaseId。
  const resolved = await resolveModelRuntime("net-advisor");
  const payload = new TextEncoder().encode(JSON.stringify({ input, modelId: resolved.modelId, releaseId: currentReleaseId() }));
  const resp = await client.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: RUNTIME_ARN,
    runtimeSessionId: sessionId,
    qualifier: "DEFAULT",
    contentType: "application/json",
    accept: "application/json",
    payload,
  }));
  // response 为流/字节，读出为字符串再解析。
  const body: unknown = (resp as { response?: unknown }).response;
  let text = "";
  if (body == null) text = "";
  else if (typeof (body as { transformToString?: () => Promise<string> }).transformToString === "function") {
    text = await (body as { transformToString: () => Promise<string> }).transformToString();
  } else if (body instanceof Uint8Array) text = Buffer.from(body).toString("utf-8");
  else text = String(body);
  const parsed = text ? JSON.parse(text) : {};
  const out = parsed.output || parsed;
  if (parsed.error && !out.verdict) throw new Error(String(parsed.error).slice(0, 300));
  // 回执校验(缺 / 不等 ⇒ AgentCoreModelMismatch,fail-closed)。
  const echoed = assertAgentCoreModelMeta(out, resolved.modelId, "net-advisor");
  return {
    model: { modelId: echoed, modelSource: resolved.source },
    reasoning: out.reasoning || "",
    verdict: (out.verdict as Verdict) || "unknown",
    rulings: Array.isArray(out.rulings) ? out.rulings : [],
    remediations: Array.isArray(out.remediations) ? out.remediations : [],
    candidates: Array.isArray(out.candidates) ? out.candidates : [],
    chosenPlacement: out.chosenPlacement || null,
    facts: out.facts ?? null,
    steps: Array.isArray(out.steps) ? out.steps : [],
    llmAvailable: out.llmAvailable !== false,
    usage: out.usage || { inputTokens: 0, outputTokens: 0 },
  };
}
