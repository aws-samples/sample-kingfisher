"use strict";
// @kf-batch 51-v2-multi-vendor(模块 51 v2.0 多厂商模型通道;51 SPEC §7.2b / DESIGN §12 D17)
// 🔴 模型调用的**瞬态流错误**判定 + 有界抖动退避 —— 单一作者,编进三个 AgentCore 容器的 core-dist/ai,
//   容器的 Strands agent 循环与平台侧共用同一张清单(写第二份清单 = 迟早漂移)。
//
// 为什么存在(2026-10-14 临时账号 …7698 真环境,页面驱动段 p51b):全局默认切到 Kimi K3 后问数容器在第 6 轮模型调用时
//   收到 `Stream ended without completing a message`(Bedrock ConverseStream 的 HTTP 事件流在一帧中间被对端关掉;
//   @smithy/eventstream-codec 的原话),整次问数以「问数执行异常」收场;**同一问题紧接着再问两次都成功**(1/3 偶发)。
//   SDK 级 retryStrategy 管的是「请求没发出去 / 5xx」,管不到「200 已回、流中途断」这一类 ⇒ 只能在 agent 循环层兜:
//   认出这一类就**重试一次**(有界、带全幅抖动,记忆 bounded-retry-needs-full-jitter),其它错误原样抛,不吞。
// 🔴 零依赖、纯函数:不 import SDK,不读 env;容器与平台都能 require。
Object.defineProperty(exports, "__esModule", { value: true });
exports.TRANSIENT_MAX_RETRIES = exports.TRANSIENT_MODEL_ERROR_RE = void 0;
exports.isTransientModelError = isTransientModelError;
exports.transientBackoffMs = transientBackoffMs;
exports.describeModelError = describeModelError;
/** 一眼就能认出来的瞬态模型调用错误(原话 / 错误名 / 底层 socket)。闭合清单,加一条要带真环境实证。 */
exports.TRANSIENT_MODEL_ERROR_RE = /Stream ended without completing a message|ModelStreamErrorException|ServiceUnavailableException|ThrottlingException|InternalServerException|ModelNotReadyException|ECONNRESET|socket hang up|EPIPE|ETIMEDOUT/i;
/** 只认清单内的;`null` / 字符串 / 没 message 的对象都如实判 false。 */
function isTransientModelError(e) {
    if (e == null)
        return false;
    const anyE = e;
    const name = typeof anyE.name === "string" ? anyE.name : "";
    const msg = typeof anyE.message === "string" ? anyE.message : typeof e === "string" ? e : "";
    const code = typeof anyE.code === "string" ? anyE.code : "";
    const status = anyE.$metadata && typeof anyE.$metadata.httpStatusCode === "number" ? anyE.$metadata.httpStatusCode : 0;
    return exports.TRANSIENT_MODEL_ERROR_RE.test(name) || exports.TRANSIENT_MODEL_ERROR_RE.test(msg) || exports.TRANSIENT_MODEL_ERROR_RE.test(code)
        || status === 429 || status === 503;
}
/** 重试最多几次(不含首发)。有界:1 次 —— 再多就是把偶发当常态,成本翻倍还掩盖真故障。 */
exports.TRANSIENT_MAX_RETRIES = 1;
/** 全幅抖动退避:[0, min(cap, base × 2^attempt)];attempt 从 0 起。`rand` 可注入(测试用)。 */
function transientBackoffMs(attempt, rand = Math.random, baseMs = 600, capMs = 2400) {
    const ceil = Math.min(capMs, baseMs * Math.pow(2, Math.max(0, attempt)));
    const r = Math.min(1, Math.max(0, rand()));
    return Math.floor(r * ceil);
}
/** 给日志 / `_meta` 用的一行事实(不带堆栈;堆栈由调用方另打)。 */
function describeModelError(e) {
    const anyE = (e ?? {});
    return {
        name: typeof anyE.name === "string" ? anyE.name : typeof e,
        message: (typeof anyE.message === "string" ? anyE.message : String(e)).slice(0, 400),
        status: anyE.$metadata && typeof anyE.$metadata.httpStatusCode === "number" ? anyE.$metadata.httpStatusCode : null,
        transient: isTransientModelError(e),
    };
}
