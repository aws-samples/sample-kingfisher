// GenBI 语义表检索（platform 适配器层）。
//
// 检索的引擎无关核心逻辑已收敛进 @genbi/core/retrieval-core（buildSemanticCatalog /
// prefilter / entryBrief / selectRelevantTables，模型调用经 ModelClient 注入）。
// 本文件是 platform 侧适配器:
//   1) fetchOmDescriptions —— 读 OpenMetadata(不纯,留此),core 不依赖 OM;
//   2) bedrockModelClient —— ModelClient 的 Bedrock 直连实现(不纯,留此);
//   3) selectRelevantTables(旧 4 参数签名包装) —— 注入 bedrockModelClient 调 core,
//      使 agent.ts 调用点零改。
//
//当前阶段1c:抽 core 检索纯逻辑 + 引入 ModelClient 接口。

// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { GENBI } from "./config";
import type { SchemaTable } from "./core/types";
import { omRequest, isOmConfigured } from "@/lib/openmetadata/om-client";
import type { ModelClient, ModelConverseInput, ModelConverseOutput } from "./core/model-client";
import { selectRelevantTables as coreSelectRelevantTables } from "./core/retrieval-core";
// modelId 改为调用时求值(能力 key genbi-retrieval),经 invokeConverse 退避/降级;
// 不再读模块加载期常量 GENBI.modelId(GENBI 仍用于 region)。实际用的模型经 onInvocation 回给 genbi 的 _meta.invocations[]。
import { invokeConverse } from "@/lib/ai/invoke";
import type { AiInvocationMeta } from "@/lib/ai/meta";

// 类型/纯函数从 core re-export，保持现有 import 路径不变。
export type {
  PublishedHint, CatalogEntry, TableMatch, RetrievalResult,
} from "./core/types";
export { buildSemanticCatalog } from "./core/retrieval-core";

const bedrock = sdkClient("model", BedrockRuntimeClient, { region: GENBI.region });

// ── OpenMetadata 表描述（best-effort，OM 是目录单一事实来源；不纯，留适配器层）──
export async function fetchOmDescriptions(): Promise<Record<string, string>> {
  if (!isOmConfigured()) return {};
  try {
    const res = await omRequest("GET", "/api/v1/tables?fields=description&limit=500");
    const out: Record<string, string> = {};
    for (const t of res?.data || []) {
      const name = (t.name || "").toLowerCase();
      const desc = (t.description || "").trim();
      if (name && desc) out[name] = desc;
    }
    return out;
  } catch {
    return {};
  }
}

/** 检索子调用实际用的模型回传口(genbi 的 `_meta.invocations[]` 靠它证第二条腿)。 */
export type RetrievalInvocationSink = (inv: AiInvocationMeta) => void;

// ── ModelClient 的 Bedrock 直连实现（不纯，留适配器层）──
// 改为工厂 —— 每次问数一个实例,modelId 在 converse 时经 invokeConverse 求值(51 SPEC §3.3),
// 并把实际使用的模型(可能已降级)回给调用方;core 的 ModelClient 接口零改。
function makeBedrockModelClient(onInvocation?: RetrievalInvocationSink): ModelClient {
  return {
    async converse(input: ModelConverseInput): Promise<ModelConverseOutput> {
      const inv = await invokeConverse("genbi-retrieval", undefined, bedrock, (modelId) =>
        new ConverseCommand({
          modelId,
          system: [{ text: input.system }],
          messages: input.messages.map((m) => ({ role: m.role, content: [{ text: m.content }] })),
          inferenceConfig: {
            ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
            ...(input.temperature != null ? { temperature: input.temperature } : {}),
          },
        })
      );
      onInvocation?.({ capability: "genbi-retrieval", modelId: inv.usedModelId, modelSource: inv.usedSource, ...(inv.degraded ? { degraded: true } : {}) });
      const resp = inv.response;
      const text = (resp.output?.message?.content || []).map((b) => ("text" in b ? b.text : "")).join("");
      return {
        text,
        usage: { inputTokens: resp.usage?.inputTokens || 0, outputTokens: resp.usage?.outputTokens || 0 },
      };
    },
  };
}

// ── 旧 4 参数签名包装：注入 bedrockModelClient 调 core（agent.ts 调用点零改;第 5 参可选,回传实际用的模型）──
export function selectRelevantTables(
  question: string,
  tables: SchemaTable[],
  published: import("./core/types").PublishedHint[],
  omDesc: Record<string, string>,
  opts: { onInvocation?: RetrievalInvocationSink } = {}
) {
  return coreSelectRelevantTables(question, tables, published, omDesc, makeBedrockModelClient(opts.onInvocation));
}
