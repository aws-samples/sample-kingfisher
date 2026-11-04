// 后一半(2026-10-11 真环境坐实):模型目录原来 `region = opts.region || process.env.AWS_REGION`,路由只传 targetId ⇒
// **任何 targetId 查的都是主控区的 Bedrock 目录**。本文件钉行为:目录的 Bedrock 控制面调用打在**落点的区**,与本进程 env 无关。
// 只 mock 真外部:Bedrock SDK(记下客户端建在哪个区、零网络)+ DynamoDB(探测缓存读)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ regions: [] as string[], probeTargets: [] as string[] }));

vi.mock("@aws-sdk/client-bedrock", () => {
  class BedrockClient {
    constructor(readonly cfg: { region: string }) {
      h.regions.push(cfg.region);
    }
    async send(cmd: { kind: string }) {
      return cmd.kind === "fm"
        ? { modelSummaries: [{ modelId: "anthropic.claude-opus-4-8", modelName: "Opus", outputModalities: ["TEXT"] }] }
        : { inferenceProfileSummaries: [] };
    }
  }
  class ListFoundationModelsCommand { kind = "fm"; constructor(readonly input: unknown) {} }
  class ListInferenceProfilesCommand { kind = "ip"; constructor(readonly input: unknown) {} }
  return { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand };
});
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: new Proxy({}, { get: (_t, k) => String(k) }),
  docClient: {
    send: async (cmd: { input?: { ExpressionAttributeValues?: Record<string, unknown> } }) => {
      h.probeTargets.push(JSON.stringify(cmd.input ?? {}));
      return { Items: [] };
    },
  },
}));

import { fetchCatalog } from "../model-catalog";

beforeEach(() => {
  h.regions.length = 0;
  h.probeTargets.length = 0;
});

describe("🔴 模型目录打在**落点的区**(不是 process.env.AWS_REGION)", () => {
  it("点名 us-west-2 的落点 ⇒ Bedrock 客户端建在 us-west-2,探测缓存按该 target 读;env 是别的区也不影响", async () => {
    const saved = process.env.AWS_REGION;
    process.env.AWS_REGION = "us-east-1";
    try {
      const cat = await fetchCatalog({ place: { targetId: "tgt_usw2_a", region: "us-west-2" } });
      expect(cat.map((c) => c.modelId)).toEqual(["anthropic.claude-opus-4-8"]);
      expect(h.regions, "目录必须查落点那个区").toEqual(["us-west-2"]);
      expect(h.probeTargets.join(" "), "探测缓存必须按该 target 读").toContain("tgt_usw2_a");
      expect(h.probeTargets.join(" ")).not.toContain("tgt_home");
    } finally {
      if (saved === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = saved;
    }
  });
});
