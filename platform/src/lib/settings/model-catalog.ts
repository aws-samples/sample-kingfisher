// 可选模型目录(51 SPEC §2 GET /catalog;DESIGN D3′ 四系列(v2.0)/ D4「仅 Bedrock」)。
//
//   · 列表**只**来自 `ListFoundationModels`(outputModalities ⊇ TEXT)+ `ListInferenceProfiles`(取短 id,不取 ARN)
//   · 再按厂商档案过滤(`lib/ai/core/vendors.ts` 唯一作者):Claude **Opus** 全版本 + `openai.gpt-5.6-*` + `zai.glm-5*` + `moonshotai.kimi-k3*`
//     (sonnet / haiku / glm-4.x / kimi-k2.x / titan / 其它 provider 不进选择面)
//   · `available` / `lastProbe` **只读探测缓存**(`ai-model#probe#<targetId>#<id>`,24h 内才算已知),🔴 绝不 probe-all(P0-4 / M11)
//   · 本目录也是 PUT 的**唯一权威白名单**(防直连 API 塞 haiku;P1-3)
//   · 排序(SPEC §7.5):`available` 为真的在前,再按档案系列顺序,再按 id
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from "@aws-sdk/client-bedrock";
import type { Place } from "@/lib/place/types";
import { familyOf, stripGeoPrefix, type Family, type ProbeResult } from "@/lib/ai/capabilities";
// 系列判定改由厂商档案驱动(原来这里手写两条正则 = 第二作者)
import { FAMILIES, isSelectableSeries } from "@/lib/ai/core/vendors";
import { isProbeFresh, listProbes, probeResultOf } from "./model-store";

export { isSelectableSeries };

// 🔴 原来写死 `"us." | "global."`:主控区 / 执行区不在美国时,
//   该区的 `eu.` / `apac.` / `jp.` … 推理配置在目录里**整个消失**。前缀改由账号真值推:
//   推理配置 id − 它指向的基础模型 id(ListInferenceProfiles 自带 modelArn),不再枚举地理段。
export type ProfilePrefix = `${string}.`;


export interface CatalogModel {
  /** 可直接填进 PUT 的 id(短 id 或 inference profile id) */
  modelId: string;
  family: Family;
  /** "model" = 基础模型 id;"profile" = 推理配置 id(us. / eu. / apac. / global. …,以账号真值为准) */
  kind: "model" | "profile";
  /** profile 项对应的基础模型 id */
  baseModelId?: string;
  displayName: string;
  /** 基础模型项:本 region 存在的推理配置前缀 */
  profilePrefixes: ProfilePrefix[];
  /** 最近一次真探测(24h 内)通过;未探测 / 过期 = false 且无 lastProbe */
  available: boolean;
  lastProbe?: ProbeResult;
  inferenceTypesSupported?: string[];
  lifecycle?: string;
}

export interface FoundationModelRow {
  modelId?: string;
  modelName?: string;
  providerName?: string;
  outputModalities?: string[];
  inferenceTypesSupported?: string[];
  modelLifecycle?: { status?: string };
}
export interface InferenceProfileRow {
  inferenceProfileId?: string;
  inferenceProfileName?: string;
  models?: { modelArn?: string }[];
  status?: string;
}
/** 目录的落点:哪个执行环境(探测缓存的 target 维)+ 它所在的区(Bedrock 控制面调用的区)。由已解析的 `Place` 提供。 */
export type CatalogPlace = Pick<Place, "targetId" | "region">;

export interface CatalogDeps {
  listFoundationModels?: () => Promise<FoundationModelRow[]>;
  listInferenceProfiles?: () => Promise<InferenceProfileRow[]>;
  now?: () => number;
}

const _clients = new Map<string, BedrockClient>();
function clientFor(region: string): BedrockClient {
  let c = _clients.get(region);
  if (!c) {
    c = sdkClient("model", BedrockClient, { region });
    _clients.set(region, c);
  }
  return c;
}

async function realListFoundationModels(region: string): Promise<FoundationModelRow[]> {
  const res = await clientFor(region).send(new ListFoundationModelsCommand({ byOutputModality: "TEXT" }));
  return (res.modelSummaries || []) as FoundationModelRow[];
}

async function realListInferenceProfiles(region: string): Promise<InferenceProfileRow[]> {
  const out: InferenceProfileRow[] = [];
  let nextToken: string | undefined;
  do {
    const res = await clientFor(region).send(new ListInferenceProfilesCommand({ typeEquals: "SYSTEM_DEFINED", maxResults: 100, nextToken }));
    for (const s of res.inferenceProfileSummaries || []) out.push(s as InferenceProfileRow);
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

function baseIdFromArn(arn: string | undefined): string | undefined {
  // arn:aws:bedrock:<region>::foundation-model/<modelId>
  const m = (arn || "").match(/foundation-model\/(.+)$/);
  return m ? m[1] : undefined;
}

/**
 * 拉目录并合并探测缓存。会抛(控制面调用失败),路由层转 503 CatalogUnavailable。
 * 🔴 全程零 InvokeModel:探测态只读 `ai-model#probe#<targetId>#*`。
 */
// 后一半(2026-10-11 真环境坐实):🔴 原来 `region = opts.region || process.env.AWS_REGION`、
//   `targetId = opts.targetId || HOME_TARGET_ID`,而路由只传 targetId ⇒ **任何 targetId(含合法的 tgt_usw2_a)查的都是主控区的
//   Bedrock 目录**,不存在的 targetId 也照样 200。模型开通是「账号 × region」级(51 SPEC §1 探测缓存按 targetId 定形的理由),
//   目录必须取**该执行环境所在区**的 ListFoundationModels / ListInferenceProfiles。⇒ 落点**必填**、region 只从落点(描述符)来。
export async function fetchCatalog(opts: { place: CatalogPlace; deps?: CatalogDeps }): Promise<CatalogModel[]> {
  const { targetId, region } = opts.place;
  const now = opts.deps?.now ?? Date.now;
  const [models, profiles, probes] = await Promise.all([
    (opts.deps?.listFoundationModels ?? (() => realListFoundationModels(region)))(),
    (opts.deps?.listInferenceProfiles ?? (() => realListInferenceProfiles(region)))(),
    listProbes(targetId).catch(() => []), // 探测缓存读失败不阻断目录(全部按「未探测」呈现)
  ]);
  const probeById = new Map(probes.map((p) => [p.modelId, p]));
  const attach = (modelId: string): Pick<CatalogModel, "available" | "lastProbe"> => {
    const p = probeById.get(modelId);
    if (!p || !isProbeFresh(p, now())) return { available: false };
    return { available: p.probeOk === true, lastProbe: probeResultOf(p) };
  };

  const out: CatalogModel[] = [];
  const baseEntries = new Map<string, CatalogModel>();
  for (const m of models) {
    const id = m.modelId || "";
    if (!id || !isSelectableSeries(id)) continue;
    if (m.outputModalities && !m.outputModalities.includes("TEXT")) continue;
    const family = familyOf(id);
    if (!family) continue;
    const entry: CatalogModel = {
      modelId: id,
      family,
      kind: "model",
      displayName: m.modelName || id,
      profilePrefixes: [],
      inferenceTypesSupported: m.inferenceTypesSupported,
      lifecycle: m.modelLifecycle?.status,
      ...attach(id),
    };
    baseEntries.set(id, entry);
    out.push(entry);
  }
  for (const p of profiles) {
    const id = p.inferenceProfileId || "";
    if (!id || !isSelectableSeries(id)) continue;
    const family = familyOf(id);
    if (!family) continue;
    const baseId = baseIdFromArn(p.models?.[0]?.modelArn) || stripGeoPrefix(id);
    // 前缀 = 配置 id 去掉它指向的基础模型 id(账号真值);推不出 / 形态不对 ⇒ 不进目录
    const rawPrefix = id.length > baseId.length && id.endsWith(baseId) ? id.slice(0, id.length - baseId.length) : "";
    if (!/^[a-z]+(?:-[a-z]+)*\.$/.test(rawPrefix)) continue;
    const prefix = rawPrefix as ProfilePrefix;
    const base = baseEntries.get(baseId);
    if (base && !base.profilePrefixes.includes(prefix)) base.profilePrefixes.push(prefix);
    out.push({
      modelId: id,
      family,
      kind: "profile",
      baseModelId: baseId,
      displayName: p.inferenceProfileName || id,
      profilePrefixes: [],
      lifecycle: p.status,
      ...attach(id),
    });
  }
  // SPEC §7.5:探测过且通过的在前(用户最可能要的),再按档案系列顺序(Claude → GPT → GLM → Kimi),再按 id
  const rank = (f: Family) => FAMILIES.indexOf(f);
  out.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (a.family !== b.family) return rank(a.family) - rank(b.family);
    return a.modelId.localeCompare(b.modelId);
  });
  return out;
}
