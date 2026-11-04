// 风格预览用的静态演示数据(取平台真实业务口径:同步/作业/GenBI 执行链路)。
// 纯静态、确定性(无 Math.random / Date.now,避免 SSR 水合不一致)。

export const SYNC_TREND = {
  labels: ["06-26", "06-27", "06-28", "06-29", "06-30", "07-01", "07-02"],
  glue: [42, 48, 45, 61, 58, 72, 86], // 万行/日
  dms: [18, 22, 30, 28, 35, 33, 41],
};

export const JOB_BARS = [
  { name: "订单入湖", v: 128 },
  { name: "汇率同步", v: 96 },
  { name: "SKU 维表", v: 74 },
  { name: "GMV 汇总", v: 62 },
  { name: "质量稽核", v: 45 },
];

// 任务状态分布(环形图 4 段)
export const STATUS_DONUT = [
  { name: "成功", v: 186, key: "ok" as const },
  { name: "运行中", v: 34, key: "running" as const },
  { name: "已停止", v: 12, key: "stopped" as const },
  { name: "排队", v: 22, key: "queue" as const },
];

export const TASK_ROWS = [
  { name: "ecom-lake-base-0702", type: "Glue 批同步", status: "成功", rows: "299,778", dur: "6.2 min" },
  { name: "parity-sync-dms-0702", type: "DMS 实时", status: "已停止", rows: "100,000", dur: "—" },
  { name: "parity-flink-0702", type: "Flink CDC", status: "运行中", rows: "实时流", dur: "—" },
  { name: "gmv-rollup-daily", type: "Redshift SQL", status: "成功", rows: "1,649", dur: "48 s" },
  { name: "parity-wf-0702", type: "workflow", status: "运行中", rows: "3 节点", dur: "9.8 min" },
];

// GenBI 执行链路(问数「近30日各渠道 GMV」的推理步骤)
export const GENBI_TRACE = [
  { i: 1, tool: "introspect", phase: "准备", ms: 320, ok: true, note: "载入 dwd/ads 表结构 12 张" },
  { i: 2, tool: "lookup_business_context", phase: "准备", ms: 210, ok: true, note: "命中口径:GMV=已支付订单额" },
  { i: 3, tool: "plan_query", phase: "推理", ms: 640, ok: true, note: "拆解:渠道维度 × 近30日窗口" },
  { i: 4, tool: "run_sql", phase: "推理", ms: 1180, ok: true, note: "SELECT channel, SUM(paid_gmv)…返回 6 行" },
  { i: 5, tool: "summarize", phase: "推理", ms: 430, ok: true, note: "生成结论 + 环比洞察" },
];
