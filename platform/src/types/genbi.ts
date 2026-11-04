// GenBI (智能问数) shared types — used by both the API routes and the page.

// 契约类型的物理定义已下沉 @genbi/core（core 自包含,支撑独立编译成 CJS 给 Lambda/容器,
// 消除跨语言副本）。此处 import + 反向 re-export,保持所有消费方 import 路径不变,
// 且让本文件下方 GenBiResult/GenBiHistoryItem 能在本地作用域引用这些类型。
import type {
  ChartType,
  ChartSpec,
  GenBiStep,
  MatchedTable,
  UsedContextEntry,
} from "@/lib/genbi/core/types";
export type { ChartType, ChartSpec, GenBiStep, MatchedTable, UsedContextEntry };
import type { AiMeta } from "@/lib/ai/meta";

// The full answer returned to the client.
export interface GenBiResult {
  answer: string;
  sql: string | null; // last successful SQL (for display)
  columns: string[];
  rows: (string | null)[][];
  rowCount: number;
  chart: ChartSpec;
  steps: GenBiStep[];
  usage: { inputTokens: number; outputTokens: number };
  maskedColumns?: string[]; // columns masked for this caller (governance)
  matchedTables?: MatchedTable[]; // 语义检索命中的表 + 理由
  usedContext?: UsedContextEntry[]; // 语义层: 本次参考的业务口径(可观测,让口径生效可见)
  retrievalNote?: string;
  // SPEC §3.3a:模型回显块。同步分支随 apiOk 第三参回显,
  // 异步分支随 GenBiResult 持久化进任务项 ⇒ 轮询 GET /api/genbi/tasks/[taskId] 的 result._meta 自动带上。
  // invocations[] 覆盖无独立端点的 retrieval / memory 两条腿(memory 标 deferred:响应后才触发)。
  _meta?: AiMeta;
}

// A stored history entry (best-effort, DynamoDB bgp-genbi-history).
export interface GenBiHistoryItem {
  userId: string;
  historyId: string;
  question: string;
  answer: string;
  sql: string | null;
  rowCount: number;
  chartType: ChartType;
  createdAt: string;
}
