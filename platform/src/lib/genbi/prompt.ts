// GenBI system prompt —— 逻辑已收敛进 @genbi/core（引擎无关纯字符串,容器/Lambda 共用）。
// 保留兼容入口(re-export),使现有 import 路径 "@/lib/genbi/prompt" 无需改动。
//当前阶段1:抽 core 纯逻辑。GenBiEngine 类型也从 core 导出(单一来源)。
export { systemPrompt } from "./core/prompt";
export type { GenBiEngine } from "./core/types";
