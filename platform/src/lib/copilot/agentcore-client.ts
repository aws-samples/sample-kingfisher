// 平台侧调用 Copilot AgentCore Runtime(数据面 invoke_agent_runtime,IAM 鉴权)。
// 照抄 lib/genbi/agentcore-client.ts,换 env 前缀 COPILOT_*。默认 inprocess,本文件供
// COPILOT_BACKEND=agentcore 时使用(部署 Runtime 后启用);未配置则 isAgentCoreConfigured()=false。

// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { COPILOT } from "./config";
import type { CopilotAskOutput } from "./agent";
// payload 透传运行时模型。🔴 copilot 的 Runtime **不在本仓**(DESIGN D7 R1),
// 容器无法回显 _meta ⇒ 这里**不做**回执断言(否则该后端永久 503);回执若带 _meta.modelId 则如实带回,否则 model 缺省。
import { resolveModelRuntime } from "@/lib/ai/model";
import { agentCoreEchoedModelId, currentReleaseId } from "@/lib/ai/agentcore-contract";

const client = sdkClient("central:agentcore", BedrockAgentCoreClient, { region: COPILOT.region });

// 传给容器的入参(容器内用同一份工具注册表跑 Converse 循环)。
export interface CopilotAgentInput {
  prompt: string;
  projectId: string;
  env: string;
  token: string;
  canCreate: boolean; // 闸3:是否装入创建工具(容器侧同构按此收敛工具集)
  history?: { question: string; answer: string }[];
  memory?: string;
}

export async function invokeCopilotAgent(
  sessionId: string,
  input: CopilotAgentInput,
  opts: { abortSignal?: AbortSignal } = {}
): Promise<CopilotAskOutput> {
  if (!COPILOT.runtimeArn) throw new Error("COPILOT_RUNTIME_ARN 未配置");
  const resolved = await resolveModelRuntime("copilot");
  const payload = new TextEncoder().encode(JSON.stringify({ input, modelId: resolved.modelId, releaseId: currentReleaseId() }));
  const resp = await client.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: COPILOT.runtimeArn,
    runtimeSessionId: sessionId,
    qualifier: "DEFAULT",
    contentType: "application/json",
    accept: "application/json",
    payload,
  }), { abortSignal: opts.abortSignal });
  const body: any = (resp as any).response;
  let text = "";
  if (body == null) text = "";
  else if (typeof body.transformToString === "function") text = await body.transformToString();
  else if (body instanceof Uint8Array) text = Buffer.from(body).toString("utf-8");
  else text = String(body);
  const parsed = text ? JSON.parse(text) : {};
  const out = parsed.output || parsed;
  if (parsed.error && !out.answer) throw new Error(String(parsed.error).slice(0, 300));
  const echoed = agentCoreEchoedModelId(out);
  return {
    answer: out.answer || "",
    steps: out.steps || [],
    usage: out.usage || { inputTokens: 0, outputTokens: 0 },
    ...(echoed ? { model: { modelId: echoed, modelSource: resolved.source } } : {}),
  };
}
