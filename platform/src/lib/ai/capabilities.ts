// AI 能力 key 白名单(51 SPEC §2 `Capability`;与 DESIGN §1.2 的 9 个消费点一一对应)。
//
// 为什么单独成文件:store / 解析链 / 9 个消费点 / 路由都要引用这组 key,而它们之间存在
// 「store → model.ts → 消费点」的依赖方向;把纯类型与常量放在零依赖的叶子文件里,
// 任何一方 import 都不会把 DynamoDB / Bedrock SDK 拖进不该到的 bundle。
//
// 🔴 一期所有能力都走全局默认(DESIGN D3),capability 只用于
//   ① 缓存键 / 回显 `_meta.invocations[].capability`(可观测);
//   ② per-capability 覆盖的形参预留 —— `deriveScope()` 一处改动即可激活。
// 改这里 = 改全平台 AI 能力清单;新增消费点必须同步加 key,门禁单测会数它。

export const CAPABILITIES = [
  "genbi",
  "genbi-retrieval",
  "genbi-memory",
  "copilot",
  "copilot-planner",
  "net-advisor",
  "param-advisor",
  "flink-sql",
  "codegen",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(x: unknown): x is Capability {
  return typeof x === "string" && (CAPABILITIES as readonly string[]).includes(x);
}

// 系列 / 地理前缀 / 系列判定的**唯一作者**挪到零依赖的
//   `core/vendors.ts`(同一份由 core-prebuild 编进三个 AgentCore 容器的 core-dist/ai,容器与平台读同一份档案);
//   这里只 re-export,四个调用点(probe / 两条路由 / 目录)的 import 路径不变。
export { GEO_PREFIX_RE, stripGeoPrefix, familyOf, isOpenAIFamily } from "./core/vendors";
export type { Family } from "./core/vendors";

/**
 * 探测失败分类(51 SPEC §2 `ProbeError`;INTERACTION 场景二按此给友好文案)。
 * v2.0 新增 `NotAvailableForAccount`(SPEC §7.3):Bedrock 原话「<model> is not available for this account」——
 * 账号级未开放(2026-10-14 临时账号对 zai.glm-5.3 实测,三种 id 形态同报),与 region / IAM / Marketplace 都无关,分类放最前。
 */
// 新增 `Timeout` —— 探测在本系列预算(vendors.probeTimeoutMs)内没等到响应。
//   原来超时被归成 Throttle,页面说「探测被限流」,而 Kimi K3 真实首字延迟 3–39s 与限流无关 ⇒ 处方不同(稍候重试 / 换推理配置),单列一类。
export type ProbeError = "AccessDenied" | "NotFound" | "MarketplaceSCP" | "Throttle" | "NotAvailableForAccount" | "Timeout";

/**
 * 三层解析来源 + 陈旧态(51 SPEC §6.1②):
 *   runtime       = bgp-settings 运行时配置(页面可改)
 *   runtime-stale = 配置面读失败,沿用进程内 last-good(GET /model-config 的 `effective[].stale=true`)
 *   env           = 部署期 env `BEDROCK_MODEL_ID`
 *   ssot          = `platform/ai-model.json` 出厂默认
 */
export type SourceLayer = "runtime" | "runtime-stale" | "env" | "ssot";

/** 探测结果(51 SPEC §2 `ProbeResult`;`quotaHint` best-effort,绝不阻断保存)。 */
export interface ProbeResult {
  ok: boolean;
  error?: ProbeError;
  errorDetail?: string;
  /** Converse 下 tool-use 是否可用:档案 `toolUse:"probe"` 的系列(GPT / GLM 5 / Kimi K3)真探(DESIGN D9 / D11);Claude 系恒 true */
  toolUseOk?: boolean;
  quotaHint?: "ok" | "low" | "unknown";
  /** 探测发生时刻(epoch ms) */
  probedAt?: number;
  /** 二探(tool-use)失败的分类(Timeout = 预算内没等到,不等于模型不支持工具) */
  toolUseError?: ProbeError;
  /** 探测墙钟(ms;两探并行 ⇒ ≈ max),页面与缓存可观测 */
  elapsedMs?: number;
}

/** 只有「探测通过」的结果才能进保存路径(51 SPEC §6.1① 类型级 probe-before-save)。 */
export type ProbeOk = ProbeResult & { ok: true };

// 模型 id 的系列判定(短 id / inference profile id 均可;地理前缀按形态剥掉后看 provider 段)已随
// 整体搬到 `core/vendors.ts`(见文件头的 re-export):原 50-PROD-A-launch-hardening(h) 的
// 「前缀按形态认、不枚举地理段」口径不变,只是 provider 清单改由厂商档案的键生成,加一家不会再漏一家。
