// 参数目录 — 每通道的参数定义,对齐托管服务 console 创建页与平台表单字段。
// [[full-param-parity-with-managed-consoles]] 的机器可读化:key=平台表单/payload 字段名(点路径),
// consoleRef=AWS console 创建页出处,platformDefault=平台当前默认(与表单 initialValue 一致)。
//
// 这是推荐引擎(heuristics.ts)与 prompt 的【单一事实源】:引擎只对目录内的参数出推荐,
// 模型只能解释目录内的参数——目录外的值一律不出现(反幻觉)。
//
// 【模块47 L2】目录逻辑已下沉 @paramadvisor/core(./core/catalog),供容器 agent import core-dist
// (消 CATALOG_TEXT 6401 字手抄)。本文件反向 re-export,进程内消费方(prompt/heuristics/skills-handler)
// API 逐字不变。core 内联了 worker/EMR 常量(零 @/),其与平台真源一致性由 __tests__/core-catalog-drift 守卫。

export { catalogFor, renderCatalogForPrompt } from "./core/catalog";
