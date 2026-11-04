// 模块 55 长操作统一框架 —— 把路由层既有的「错误 ⇒ Response」映射器(targetNotReadyResponse / residencyErrorResponse /
// catalogDdlErrorResponse / placeErrorResponse …)吸收成可落库、可还原的 LongOpHttpError。
//
// 为什么不在执行体里把每种错误再翻译一遍:那些映射器已经是「错误 ⇒ 状态码 + 信封」的单一作者(各自文件头都这么写),
// 这里只是把它们的产物(一个 Response)原样装进错误对象 —— 同步分支由路由 `longOpErrorResponse` 原信封回,
// 异步分支落库 `errorStatus` / `errorBody` 后由客户端整形,两条分支逐字一致。

import { NextResponse } from "next/server";
import { apiError, type ApiErrorCode } from "@/lib/api-response";
import { LongOpHttpError } from "./store";

export type ErrorResponseMapper = (e: unknown) => Response | null;

/**
 * 路由 catch 的第一道:执行体 / 租约抛的 LongOpHttpError ⇒ 原状态码(带原信封就逐字还原,否则 apiError 同形);不是 ⇒ null 让路由走自己的映射。
 * (原在 driver.ts;改 / 删路由的租约守卫 guard.ts 也要用,搬到这里成唯一作者,driver 只 re-export。)
 */
export function longOpErrorResponse(e: unknown): NextResponse | null {
  if (!(e instanceof LongOpHttpError)) return null;
  if (e.body && typeof e.body === "object") return NextResponse.json(e.body, { status: e.status });
  return apiError(e.message, e.status, { ...(e.code ? { code: e.code as ApiErrorCode } : {}), ...(e.detail !== undefined ? { detail: e.detail } : {}) });
}

/** 依次试每个映射器;第一个认领的 Response 变成 LongOpHttpError;都不认领 ⇒ null(调用方原样上抛,路由走自己的兜底)。 */
export async function httpErrorFromMappers(e: unknown, mappers: readonly ErrorResponseMapper[]): Promise<LongOpHttpError | null> {
  if (e instanceof LongOpHttpError) return e;
  for (const mapper of mappers) {
    const res = mapper(e);
    if (res) return LongOpHttpError.fromResponse(res, e);
  }
  return null;
}

/** 执行体 catch 的惯用写法:映射得到就抛 LongOpHttpError,否则原样重抛。 */
export async function rethrowAsHttpError(e: unknown, mappers: readonly ErrorResponseMapper[]): Promise<never> {
  const mapped = await httpErrorFromMappers(e, mappers);
  throw mapped ?? e;
}
