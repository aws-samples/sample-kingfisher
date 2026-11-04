// 平台侧调用 AgentCore Runtime（数据面 invoke_agent_runtime，IAM 鉴权）。
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { homeRegion } from "@/lib/place/home-region";
import { sdkClient } from "@/lib/aws/clients";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import type { AiModelUse } from "@/lib/ai/meta";
// payload 透传运行时模型 + 回执校验(缺/不等 ⇒ AgentCoreModelMismatch,fail-closed)。
import { resolveModelRuntime } from "@/lib/ai/model";
import { assertAgentCoreModelMeta, currentReleaseId } from "@/lib/ai/agentcore-contract";
import { mergeRanIn, type AiInvocationMeta, type RanInMeta } from "@/lib/ai/meta";
import type { GenBiPlace } from "@/lib/genbi/place";
import type { PlaceWire } from "@/lib/place/wire";


const REGION = homeRegion();
const RUNTIME_ARN = process.env.GENBI_RUNTIME_ARN || "";

const client = sdkClient("central:agentcore", BedrockAgentCoreClient, { region: REGION });

export interface AgentInvokeInput {
  prompt: string;
  engine: "redshift" | "athena";
  database?: string;
  projectId?: string;
  /**
   * 🔴🔴 **用户 2026-09-10 拍板「都走同一个 AgentCore」** ⇒ 取数落点由平台解析好、随 payload 交给容器,
   * 容器**确定性地**把它并进每一次 Gateway 工具调用(不由模型决定 —— 模型漏传或编错区,
   * 结果会在**错的区**执行而答案里看不出来)。
   * (旧镜像:缺省(不传)= 技能 Lambda 用自己 env 里的主控区那一套。新镜像只读下面的 placeWire,缺即拒。)
   * 🔴 `secretArn` 是 **ARN 不是密钥值**;能不能读它仍由技能 Lambda 的角色决定。
   */
  // 按引擎的封闭联合(Athena 带工作组 / 结果位置 / 该区联邦目录引用);唯一作者 `resolveGenBiPlace`
  place?: GenBiPlace;
  /**
   * **容器唯一读的落点**(PlaceWire v1,形状见 platform/place-wire.schema.json)。
   * 新镜像只认它(缺 / 不合法 ⇒ 容器报错 ⇒ 本侧回落进程内后端,不会落主控区);上面的 `place` 只留给**旧镜像**
   * 过渡(平台先于 AgentCore 镜像部署时旧镜像仍读它)—— AgentCore 新镜像上线后删 `place`。
   */
  placeWire: PlaceWire;
  published?: any[];
  history?: { question: string; answer: string; sql?: string | null }[];
  memory?: string;
}

export interface AgentInvokeOutput {
  answer: string;
  sql: string | null;
  columns: string[];
  rows: (string | null)[][];
  rowCount: number;
  steps: {
    sql: string; ok: boolean; rowCount?: number; error?: string;
    tool?: string; phase?: "prepare" | "reason"; inputSummary?: string; outputSummary?: string; durationMs?: number;
  }[];
  usage: { inputTokens: number; outputTokens: number };
  // 容器回执的实际模型(payload 透传 + 回执校验后由 ⑥ 填实)。
  model?: AiModelUse;
  /** 容器回执的子调用腿(genbi-retrieval);inprocess 路径由 sink 收集,形状一致 */
  invocations?: AiInvocationMeta[];
  /** 技能 Lambda 每次真执行 SQL 回报的落点,容器汇总进 `_meta.ranIn` */
  ranIn?: RanInMeta[];
}

export function isAgentCoreConfigured(): boolean {
  return !!RUNTIME_ARN;
}

export async function invokeGenBiAgent(
  sessionId: string,
  input: AgentInvokeInput,
  opts: { abortSignal?: AbortSignal } = {}
): Promise<AgentInvokeOutput> {
  if (!RUNTIME_ARN) throw new Error("GENBI_RUNTIME_ARN 未配置");
  // 运行时模型透传(容器读 payload.modelId ‖ env);releaseId 供排障对账。
  const resolved = await resolveModelRuntime("genbi");
  const payload = new TextEncoder().encode(JSON.stringify({ input, modelId: resolved.modelId, releaseId: currentReleaseId() }));
  // ：传 abortSignal——到达 300s 天花板时客户端立即停止等待、断开连接、释放 ECS 侧资源。
  // (runtime 容器内 runAgent 是其自有进程，本就有界 maxIters+查询轮询上限，会自然收尾；要连
  //  容器算力都当场杀需改镜像=B3，本期不做。用户/ECS 侧对超时的感知与资源释放已完全强制。)
  const resp = await client.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: RUNTIME_ARN,
    runtimeSessionId: sessionId,
    qualifier: "DEFAULT",
    contentType: "application/json",
    accept: "application/json",
    payload,
  }), { abortSignal: opts.abortSignal });
  // response 为流/字节，读出为字符串再解析。
  const body: any = (resp as any).response;
  let text = "";
  if (body == null) text = "";
  else if (typeof body.transformToString === "function") text = await body.transformToString();
  else if (body instanceof Uint8Array) text = Buffer.from(body).toString("utf-8");
  else text = String(body);
  const parsed = text ? JSON.parse(text) : {};
  const out = parsed.output || parsed;
  if (parsed.error && !out.answer) throw new Error(String(parsed.error).slice(0, 300));
  // 回执校验 —— 容器实际用的模型必须等于透传值(缺 / 不等 ⇒ 抛,调用方不得回落 inprocess 吞掉)。
  const echoed = assertAgentCoreModelMeta(out, resolved.modelId, "genbi");
  return {
    answer: out.answer || "",
    sql: out.sql ?? null,
    columns: out.columns || [],
    rows: out.rows || [],
    rowCount: out.rowCount || 0,
    steps: out.steps || [],
    usage: out.usage || { inputTokens: 0, outputTokens: 0 },
    model: { modelId: echoed, modelSource: resolved.source },
    invocations: echoedSubInvocations(out, resolved.modelId),
    // 🔴 形状不对的条目丢掉(mergeRanIn 只收合法三元组);旧镜像没有这个字段 ⇒ 空数组 ⇒ 页面说「未回报」
    ranIn: mergeRanIn([], Array.isArray(out?._meta?.ranIn) ? out._meta.ranIn : []),
  };
}

/**
 * 容器回执 `_meta.invocations[]`(目前一条腿:genbi-retrieval,检索重排真发过 Converse 才有)。
 * 🔴 每条子调用的 modelId 同样必须等于透传值 —— 子调用用了别的模型与主调用不等是同一类接线故障(fail-closed,不吞)。
 */
export function echoedSubInvocationsForTests(out: unknown, expectedModelId: string): AiInvocationMeta[] {
  return echoedSubInvocations(out, expectedModelId);
}

function echoedSubInvocations(out: unknown, expectedModelId: string): AiInvocationMeta[] {
  const raw = (out as { _meta?: { invocations?: unknown } } | null)?._meta?.invocations;
  if (!Array.isArray(raw)) return [];
  const list: AiInvocationMeta[] = [];
  for (const it of raw) {
    const o = it as { capability?: unknown; modelId?: unknown; modelSource?: unknown };
    if (typeof o?.capability !== "string" || typeof o?.modelId !== "string") continue;
    assertAgentCoreModelMeta({ _meta: { modelId: o.modelId } }, expectedModelId, `genbi:${o.capability}`);
    list.push({ capability: o.capability as AiInvocationMeta["capability"], modelId: o.modelId, modelSource: (typeof o.modelSource === "string" ? o.modelSource : "runtime") as AiInvocationMeta["modelSource"] });
  }
  return list;
}
