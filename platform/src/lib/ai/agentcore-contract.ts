// AgentCore 模型回执校验(51 SPEC §6.1⑤;ACCEPTANCE M17)。
//
// 平台调 Runtime 时 payload 带 `{ modelId, releaseId }`;容器读 `payload.modelId ‖ env ‖ (无兜底,抛)` 并把**实际用的**
// 模型回显在 `output._meta.modelId`。平台侧 `assertAgentCoreModelMeta()`:回执缺 `_meta.modelId` 或 ≠ 期望 ⇒ 抛
// `AgentCoreModelMismatch` ⇒ 该次调用 **fail-closed 503**(不回落 inprocess 假装成功),`/settings`「AI 接线健康」卡红。
//
// 为什么不回落 inprocess:回落会用对的模型把结果做出来、页面报成功 —— 正是「页面切了、Runtime 还用旧的、平台照样报成功」
// 这个我方零覆盖的坑。回执不等 = Runtime 镜像陈旧 / 透传断了,必须被看见,而不是被兜底吞掉。
//
// ⚠️ copilot 的 Runtime 不在本仓(DESIGN D7 R1):其 client 只透传 payload,不做回执断言(否则该后端永久 503)。

export class AgentCoreModelMismatch extends Error {
  readonly name = "AgentCoreModelMismatch";
  constructor(
    public readonly capability: string,
    public readonly expected: string,
    public readonly actual: string | null
  ) {
    super(
      actual === null
        ? `AgentCore ${capability} 回执缺少 _meta.modelId(期望 ${expected});Runtime 镜像可能未含 _meta.modelId 透传,已 fail-closed`
        : `AgentCore ${capability} 回执模型 ${actual} ≠ 期望 ${expected};Runtime 未按 payload 切模型,已 fail-closed`
    );
  }
}

/** 最近一次不匹配(进程内;供 GET /api/system/wiring 把「AI 接线健康」卡点红)。 */
interface MismatchRecord {
  at: number;
  capability: string;
  expected: string;
  actual: string | null;
}
let _lastMismatch: MismatchRecord | null = null;
let _lastOk: { at: number; capability: string; modelId: string } | null = null;

export function _resetAgentCoreContractForTests(): void {
  _lastMismatch = null;
  _lastOk = null;
}

export function getAgentCoreMetaStatus(): { lastMismatch: MismatchRecord | null; lastOk: { at: number; capability: string; modelId: string } | null } {
  return { lastMismatch: _lastMismatch, lastOk: _lastOk };
}

/** 从容器回执里取 `_meta.modelId`(容错:`output._meta` 或顶层 `_meta`)。 */
export function agentCoreEchoedModelId(out: unknown): string | null {
  const o = out as { _meta?: { modelId?: unknown } } | null | undefined;
  const v = o?._meta?.modelId;
  return typeof v === "string" && v ? v : null;
}

/**
 * 回执校验。通过返回回显的 modelId;缺 / 不等 ⇒ 抛 `AgentCoreModelMismatch`(fail-closed)。
 * 调用方在 catch 里**必须**把它原样上抛(不进 inprocess 回落分支),路由层转 503。
 */
export function assertAgentCoreModelMeta(out: unknown, expectedModelId: string, capability: string, now = Date.now()): string {
  const actual = agentCoreEchoedModelId(out);
  if (actual === null || actual !== expectedModelId) {
    _lastMismatch = { at: now, capability, expected: expectedModelId, actual };
    throw new AgentCoreModelMismatch(capability, expectedModelId, actual);
  }
  _lastOk = { at: now, capability, modelId: actual };
  return actual;
}

/** 发布标识(payload.releaseId):CDK 目前不注入构建 id,缺省 "unknown"(收尾报告已登记)。 */
export function currentReleaseId(env: NodeJS.ProcessEnv = process.env): string {
  return (env.BGP_RELEASE_ID || env.IMAGE_TAG || "").trim() || "unknown";
}
