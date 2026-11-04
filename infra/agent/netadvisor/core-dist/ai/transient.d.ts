/** 一眼就能认出来的瞬态模型调用错误(原话 / 错误名 / 底层 socket)。闭合清单,加一条要带真环境实证。 */
export declare const TRANSIENT_MODEL_ERROR_RE: RegExp;
/** 只认清单内的;`null` / 字符串 / 没 message 的对象都如实判 false。 */
export declare function isTransientModelError(e: unknown): boolean;
/** 重试最多几次(不含首发)。有界:1 次 —— 再多就是把偶发当常态,成本翻倍还掩盖真故障。 */
export declare const TRANSIENT_MAX_RETRIES = 1;
/** 全幅抖动退避:[0, min(cap, base × 2^attempt)];attempt 从 0 起。`rand` 可注入(测试用)。 */
export declare function transientBackoffMs(attempt: number, rand?: () => number, baseMs?: number, capMs?: number): number;
/** 给日志 / `_meta` 用的一行事实(不带堆栈;堆栈由调用方另打)。 */
export declare function describeModelError(e: unknown): {
    name: string;
    message: string;
    status: number | null;
    transient: boolean;
};
