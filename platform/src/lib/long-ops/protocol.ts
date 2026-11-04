// 长操作统一框架 —— 协议常量(🔴 零 import:浏览器拦截器、判据与服务端共用这一份)。
//
// 为什么要一个「协议记号」:平台里已有三种 202 —— GenBI `{taskId,status:"pending",async:true}`、`{status:"warming"}`、
// 治理 schema-sync `{runId,state:"running"}`。客户端传输层只认带 `protocol:"long-op/1"` 的 202,其余原样放行,互不干扰。

export const LONG_OP_PROTOCOL = "long-op/1" as const;
export const LONG_OPS_API = "/api/long-ops" as const;
/** 终态 error 字段的超时记号(页面 / 判据据此给「超过 5 分钟已终止」文案;与 GenBI 的 `GENBI_TIMEOUT` 同形)。 */
export const LONG_OP_TIMEOUT_ERROR = "LONG_OP_TIMEOUT" as const;
/** 客户端拦截器把轮询终态整形成同步响应时附带的响应头(值 = taskId;判据据此证明这次响应走的是 202 路径)。 */
export const LONG_OP_RESPONSE_HEADER = "x-bgp-long-op" as const;
/** 终态 timeout / 前端预算耗尽时整形出的文案(全平台一句)。 */
export const LONG_OP_TIMEOUT_MESSAGE = "操作超过 5 分钟已自动终止,请缩小范围后重试" as const;

export type LongOpStatus = "pending" | "running" | "succeeded" | "failed" | "timeout";

/** 已接入路由在等待预算内未终态时回的 202 载荷(`apiOk(data, 202)` 的 data)。 */
export interface LongOpAcceptedBody {
  taskId: string;
  kind: string;
  /** 中文标签(`LONG_OP_LABELS[kind]`,给全局提示「正在后台执行:<label>」;浏览器侧经 t() 翻) */
  label: string;
  status: "running";
  async: true;
  protocol: typeof LONG_OP_PROTOCOL;
}

/** `GET /api/long-ops/[taskId]` 的 data。 */
export interface LongOpStateBody {
  taskId: string;
  kind: string;
  label: string;
  status: LongOpStatus;
  /** succeeded:执行体的响应 data(与同步响应的 data 逐字相同) */
  result?: unknown;
  /** succeeded:同步分支成功时用的 HTTP 状态(目录建表 201;缺省 200) */
  resultStatus?: number;
  /** succeeded:`result` 就是整个响应体(不包 `{success,data}` 信封;第二批编排四条路由) */
  resultRaw?: boolean;
  /** failed / timeout:失败文案(timeout 恒 LONG_OP_TIMEOUT) */
  error?: string;
  /** failed:同步分支会回的 HTTP 状态(执行体抛 LongOpHttpError 时才有) */
  errorStatus?: number;
  /** failed:同步分支会回的完整错误信封(路由既有「错误 ⇒ Response」映射器的产物;有它就逐字还原) */
  errorBody?: unknown;
  elapsedMs: number;
  heartbeatAt?: string;
}
