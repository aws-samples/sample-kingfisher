// 模块 55 长操作统一框架 —— 执行体的类型(各域执行体只 import 这里与 ./kinds;框架不 import 业务)。
//
// 执行体 = 原路由的「主体」原样搬入:鉴权 / 入参校验 / 落点点名(`requestedTargetId`)/ prod 审批分流**留在路由**,
// 这里只做「拿到已校验的入参 → 调外部系统到终态 → 记审计 → 回 data(+ 可选 meta / 状态码)」。
// ctx.req 是**承载这次执行的请求**:同步分支就是那次 POST / GET;异步分支被别的轮询 GET 接管时就是那次 GET ——
// 两者都带同一用户的 Authorization ⇒ 需要用户 token 的执行体(Copilot)从这里取,不落库。

import type { NextRequest } from "next/server";
import type { Identity } from "@/lib/auth/identity";
import type { AiModelUse } from "@/lib/ai/meta";
import type { LongOpKind, LongOpParamsByKind } from "./kinds";

export interface LongOpExecContext {
  /** 承载这次执行的请求(POST / GET 本身或接管的 GET 轮询);审计 actor 与 Copilot token 都从它取。 */
  req: NextRequest;
  /** 已校验身份(= 任务行 userId 的那个人;路由 / 轮询端点都已核过)。 */
  identity: Identity;
  /** 到天花板时由驱动器 abort;能听的执行体就停算力,听不到的由状态机兜底。 */
  abortSignal?: AbortSignal;
}

/** 终态 `_meta` 的来源(AI 类 kind 有 `model`;建模 / 目录类无)。 */
export interface LongOpMeta {
  model?: AiModelUse;
}

export interface LongOpExecOutput {
  /** 响应 data(与接入前同步路由 `apiOk(data)` 的 data 逐字相同)。 */
  data: unknown;
  meta?: LongOpMeta;
  /** 同步分支成功时用的 HTTP 状态(目录建表 201;缺省 200)。 */
  resultStatus?: number;
  /**
   * 第二批:`data` 就是**整个响应体**,不再包 `apiOk` 信封(编排四条路由的历史响应是 `NextResponse.json({ success, dagId, … })`
   * 这种摊平形状,页面与验收脚本读的是顶层字段;包一层 data 就是一次静默的契约变更)。同步 / 异步两条分支都按原样交回。
   */
  rawBody?: boolean;
}

export type LongOpExecutor<K extends LongOpKind> = (params: LongOpParamsByKind[K], ctx: LongOpExecContext) => Promise<LongOpExecOutput>;
export type LongOpExecutorRegistry = { [K in LongOpKind]: LongOpExecutor<K> };
