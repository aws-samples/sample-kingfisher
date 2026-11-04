// Glue Worker 规格 — 对齐 Glue console 创建页全量选项(G 通用 / R 内存优化)。
// 单一事实源:etl-jobs 页、sync 表单、param-advisor catalog 都从这里取;
// infra/agent/paramadvisor/agent.js 的 CATALOG_TEXT 为纯 JS 需手动同步。
export const GLUE_WORKER_TYPES: { value: string; label: string }[] = [
  { value: "G.1X", label: "G.1X(4vCPU/16GB)" },
  { value: "G.2X", label: "G.2X(8vCPU/32GB)" },
  { value: "G.4X", label: "G.4X(16vCPU/64GB)" },
  { value: "G.8X", label: "G.8X(32vCPU/128GB)" },
  { value: "G.12X", label: "G.12X(48vCPU/192GB)" },
  { value: "G.16X", label: "G.16X(64vCPU/256GB)" },
  { value: "R.1X", label: "R.1X(4vCPU/32GB 内存优化)" },
  { value: "R.2X", label: "R.2X(8vCPU/64GB 内存优化)" },
  { value: "R.4X", label: "R.4X(16vCPU/128GB 内存优化)" },
  { value: "R.8X", label: "R.8X(32vCPU/256GB 内存优化)" },
];

export const GLUE_WORKER_VALUES = GLUE_WORKER_TYPES.map((w) => w.value);

// FLEX 执行类仅 G.1X / G.2X 支持(AWS 约束)。
export const FLEX_CAPABLE_WORKER_TYPES = ["G.1X", "G.2X"];

// Worker 数量上限:AWS 账号级 DPU 配额默认 1000,平台放开到 1000 由配额兜底。
export const GLUE_MAX_WORKERS = 1000;
