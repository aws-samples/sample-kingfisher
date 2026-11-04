// `_meta` 回显契约(51 SPEC §3.3a):响应体统一元数据块 `{ modelId, modelSource, correlationId }`。
//
// 为什么是响应体不是响应头:长任务走异步 + 轮询(绕 CloudFront 60s),头拿不到终态;
// 为什么必带 correlationId:并发验收下没有它无法把响应与日志对上(基建已有 x-correlation-id)。
// 落点:6 个同步 route 经 `apiOk(data, status, meta)`;genbi 异步分支塞进 `GenBiResult._meta`;
//       copilot/plan 任务项落 `usedModelId`;retrieval / memory 无端点 ⇒ 经 genbi 的 `_meta.invocations[]`。
// 值来源:`invokeWithFallback` 返回的 **实际使用** modelId(降级换了模型也如实回显,M14)。
import { getCorrelationId } from "@/lib/observability/logger";
import type { Capability, SourceLayer } from "./capabilities";

export interface AiInvocationMeta {
  capability: Capability;
  modelId: string;
  modelSource: SourceLayer;
  /** 该子调用是否发生了跨层降级 */
  degraded?: boolean;
  /**
   * 该子调用在**响应之后**才发生(如 genbi-memory 的长期摘要是 fire-and-forget、且每 6 轮才触发一次)
   * ⇒ 这里回显的是它**将要用**的解析值,不是本次真发出的 invoke。诚实标注,免得验收把它当铁证。
   */
  deferred?: boolean;
}

/**
 * 🔴🔴 这一次 SQL **实际**在哪执行 —— 由**执行层**回报(Redshift Data API / Athena 真发出请求的那个客户端),
 * 不是请求侧「我在哪个视角提问」的声称。
 * 为什么要它(2026-10-01 无头实测):在 us-west-2 视角选「数据湖」问数,10 条 Athena 查询**全部**
 * 打在主控区工作组、us-west-2 工作组 0 条,而页面横幅照样写「当前在 us-west-2 提问」—— 请求侧声称与执行事实
 * 不一致时,没有回显就**谁都看不见**(答案长得一样)。
 */
export interface RanInMeta {
  engine: "redshift" | "athena";
  region: string;
  /** Redshift 工作组 / Athena 工作组 实名 */
  workgroup: string;
}

/** 去重合并(同一引擎 × 区 × 工作组只留一条;保序)。唯一作者:两条后端分路与容器回执都经它。 */
export function mergeRanIn(into: RanInMeta[], more: readonly (RanInMeta | null | undefined)[]): RanInMeta[] {
  for (const r of more) {
    if (!r || typeof r.region !== "string" || !r.region) continue;
    if ((r.engine !== "redshift" && r.engine !== "athena") || typeof r.workgroup !== "string") continue;
    if (!into.some((x) => x.engine === r.engine && x.region === r.region && x.workgroup === r.workgroup)) {
      into.push({ engine: r.engine, region: r.region, workgroup: r.workgroup });
    }
  }
  return into;
}

export interface AiMeta {
  /**
   * 本次 SQL 实际执行的落点(执行层回报;见 `RanInMeta`)。
   * 🔴 空数组 = 这次**没有**执行 SQL(或执行层没回报)—— 页面必须如实说「未回报」,不许拿视角顶上。
   */
  ranIn?: RanInMeta[];
  /**
   * 🔴 **这次问数实际喂进去的前序对话轮数**(2026-09-13 新增)。
   * 加它的理由与当初给 `backend` 加的一样:**判据需要的真值,产品有义务暴露出来**。
   * 「续聊是不是真接上了」原来只能去猜模型措辞 —— 而追问「那按分类呢?」在有码表的库里,
   * 接上与没接上会给出**同一张表**,判据因此没有判别力(实测)。有了这个数就是确定性的:
   * 打开旧卡续聊 ⇒ ≥ 卡片轮数;新对话 ⇒ 0。运维侧同样受益(「它到底看没看见上文」)。
   */
  contextTurns?: number;
  modelId: string;
  modelSource: SourceLayer;
  correlationId: string;
  degraded?: boolean;
  invocations?: AiInvocationMeta[];
  /**
   * 本次**实际用的执行后端**(问数:`agentcore` | `inprocess`)。
   * 🔴 为什么必须回显:此后「在哪个区提问」会决定走哪个后端(AgentCore 只装在主控区),
   * 而两个后端的能力**不完全一样**(记忆 / Gateway 技能)。不回显 = 用户与验收都只能靠猜,
   * 而「猜」在这件事上必然出错:两条路的答案长得一样。`_meta` 本来就是「这次实际用了什么」的地方。
   */
  backend?: string;
}

export interface AiModelUse {
  modelId: string;
  modelSource: SourceLayer;
  degraded?: boolean;
}

type HeaderReader = { headers: { get(name: string): string | null } };

/** 组装 `_meta`。`req` 缺省(异步执行体无请求上下文)时用 correlationId 参数或新生成。 */
export function buildAiMeta(
  req: HeaderReader | null | undefined,
  primary: AiModelUse,
  extra: { invocations?: AiInvocationMeta[]; correlationId?: string; backend?: string; contextTurns?: number; ranIn?: RanInMeta[] } = {}
): AiMeta {
  const correlationId = extra.correlationId || (req ? getCorrelationId(req) : getCorrelationId({ headers: { get: () => null } }));
  return {
    modelId: primary.modelId,
    modelSource: primary.modelSource,
    correlationId,
    ...(primary.degraded ? { degraded: true } : {}),
    ...(extra.invocations && extra.invocations.length ? { invocations: extra.invocations } : {}),
    ...(extra.backend ? { backend: extra.backend } : {}),
    // 🔴 0 也要回显(`?? undefined` 会把「明确的 0 轮」抹成「没这个字段」⇒ 判据分不清「没接上」与「产品没暴露」)
    ...(typeof extra.contextTurns === "number" ? { contextTurns: extra.contextTurns } : {}),
    // 🔴 空数组也回显(与 contextTurns 同理:「没执行 SQL」与「没接上」必须分得清)
    ...(extra.ranIn ? { ranIn: extra.ranIn } : {}),
  };
}
