// 故障注入 seam(51 SPEC §3.4a 卡点③;机制与 50 ACCEPTANCE §8ter.2 一致
// **运行期 env 门 + 仅非生产 target 生效**,不是构建期剔除 —— 验收跑的必须是发布镜像)。
//
// 目前唯一一条缝:`FAULT_THROTTLE_MODEL=<modelId>` —— `invokeWithFallback` 对该 modelId 强制抛
// ThrottlingException,验退避 + 降级回落(M9)。
//
// 🔴「仅非生产 target」怎么判(开包勘定:全仓没有任何 stage / 生产标识 env,`ExecutionTarget.stage`
// 是自由串无生产语义;NODE_ENV 在 ECS 上恒 production 不能用):
//   缝要真正**打开**,除 `FAULT_*` 本身外还必须带 **`BGP_NONPROD_TARGET=1`**(非生产部署的显式标记)。
//   两者缺一 ⇒ 缝**惰性**(即使 FAULT_* 设了也不生效)。这是 fail-closed 方向:忘了标非生产 = 什么都不注入,
//   而不是「忘了标 = 生产被注入」。两个 env 都由主会话在 temp env 的 ECS 上一起设。
//   ⚠️ `BGP_NONPROD_TARGET` 是本包新增的契约标识符,需登记进 50 ACCEPTANCE §8ter.4 的一致性清单(收尾报告已列)。
//
// 启用状态呈现在 `GET /api/system/wiring`(不是不存在的 /api/system/health)。

export const FAULT_THROTTLE_MODEL_ENV = "FAULT_THROTTLE_MODEL";
export const NONPROD_MARKER_ENV = "BGP_NONPROD_TARGET";

export interface FaultSeamStatus {
  /** 非生产标记是否在 */
  nonprod: boolean;
  /** FAULT_THROTTLE_MODEL 的原始值(空串 = 未设) */
  throttleModel: string;
  /** 缝是否真正打开(nonprod && throttleModel 非空) */
  armed: boolean;
}

export function isNonProdTarget(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[NONPROD_MARKER_ENV] || "").trim() === "1";
}

export function faultSeamStatus(env: NodeJS.ProcessEnv = process.env): FaultSeamStatus {
  const nonprod = isNonProdTarget(env);
  const throttleModel = (env[FAULT_THROTTLE_MODEL_ENV] || "").trim();
  return { nonprod, throttleModel, armed: nonprod && throttleModel.length > 0 };
}

/** 该 modelId 是否被注入限流(缝未打开 ⇒ 恒 false)。 */
export function isThrottleInjected(modelId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const s = faultSeamStatus(env);
  return s.armed && s.throttleModel === modelId;
}

/** 造一个与 Bedrock SDK 同名的限流异常(`invokeWithFallback` 的 isThrottle 按 name 识别)。 */
export function injectedThrottleError(modelId: string): Error {
  const e = new Error(`FAULT_THROTTLE_MODEL 注入:对 ${modelId} 强制限流`);
  e.name = "ThrottlingException";
  (e as Error & { $metadata?: { httpStatusCode: number }; injected?: boolean }).$metadata = { httpStatusCode: 429 };
  (e as Error & { injected?: boolean }).injected = true;
  return e;
}
