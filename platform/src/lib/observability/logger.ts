// 模块 27 (WS0) — 结构化日志 + 全链路 correlation-id 关联。
//
// 生产化加固的可观测底座。设计约束:
//  - **Edge + Node 双运行时安全**:middleware 跑在 Edge runtime(不支持 node:async_hooks /
//    AsyncLocalStorage),API 路由跑在 Node runtime。因此本模块**不依赖 ALS**——correlation-id
//    由 middleware 生成、经请求头 `x-correlation-id` 下传给路由、由路由显式取出传入 logger。
//  - 输出**单行 JSON**(便于 CloudWatch Logs Insights / 日志聚合按字段检索),绝不抛异常。
//  - **绝不记录敏感值**(token / 密钥 / 口令 / SQL 字面量),与红线②一致;调用方负责不传敏感字段。
//
// 用法:
//   import { logger, getCorrelationId } from "@/lib/observability/logger";
//   const cid = getCorrelationId(req);            // 路由内从请求头取
//   logger.info("sync.start", { correlationId: cid, projectId, taskId });
//   logger.error("sync.start.failed", err, { correlationId: cid, taskId });

export const CORRELATION_HEADER = "x-correlation-id";

export type LogLevel = "debug" | "info" | "warn" | "error";

// 字段顺序固定:ts/level/event 在前,便于人读;其余结构化字段平铺。
export interface LogFields {
  correlationId?: string;
  actor?: string; // 调用者(username / sub),不含敏感信息
  projectId?: string;
  route?: string;
  latencyMs?: number;
  // 任意附加的结构化字段(调用方保证非敏感)。
  [k: string]: unknown;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// LOG_LEVEL 环境变量控制最低输出级别(默认 info)。dev 可设 debug。
function minLevel(): LogLevel {
  const v = (process.env.LOG_LEVEL || "info").toLowerCase();
  return (["debug", "info", "warn", "error"] as LogLevel[]).includes(v as LogLevel)
    ? (v as LogLevel)
    : "info";
}

// crypto.randomUUID 在 Node18+ 与 Edge runtime 均可用;退化到时间无关的伪随机(不依赖 Date.now
// 之外的全局),保证永不抛错。生产路径优先用 UUID。
export function newCorrelationId(): string {
  try {
    const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
    if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `cid-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

// 从请求头取 correlation-id;缺失则生成一个(便于直接打到路由、无 middleware 的场景)。
export function getCorrelationId(req: { headers: { get(name: string): string | null } }): string {
  return req.headers.get(CORRELATION_HEADER) || newCorrelationId();
}

// 把 Error 归一为可序列化的结构(保留 message + name + stack 首若干行,去掉噪声)。
function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      errName: err.name,
      errMessage: err.message,
      // 仅保留前 8 行堆栈,避免日志爆量;堆栈不含敏感值。
      stack: (err.stack || "").split("\n").slice(0, 8).join("\n"),
    };
  }
  return { errMessage: typeof err === "string" ? err : safeString(err) };
}

function safeString(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function emit(level: LogLevel, event: string, fields: LogFields): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel()]) return;
  // ts 用 ISO 字符串;此处允许 new Date()(运行时日志,非 workflow 脚本环境)。
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const line = safeString(record);
  // 用对应的 console 通道,便于 CloudWatch 按 stream 区分;绝不抛错。
  try {
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  } catch {
    /* never throw from logging */
  }
}

export const logger = {
  debug(event: string, fields: LogFields = {}): void {
    emit("debug", event, fields);
  },
  info(event: string, fields: LogFields = {}): void {
    emit("info", event, fields);
  },
  warn(event: string, fields: LogFields = {}): void {
    emit("warn", event, fields);
  },
  // error 接受一个 Error(或任意值)+ 结构化字段;堆栈被安全截断后并入。
  error(event: string, err?: unknown, fields: LogFields = {}): void {
    emit("error", event, err === undefined ? fields : { ...fields, ...serializeError(err) });
  },
};
