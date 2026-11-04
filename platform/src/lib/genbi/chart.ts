// GenBI 图表建议 —— 逻辑已收敛进 @genbi/core（引擎无关纯函数,容器/Lambda 共用）。
// 保留兼容入口(re-export),使现有 import 路径 "@/lib/genbi/chart" 无需改动。
// 模块46 阶段1:抽 core 纯逻辑。
export { suggestChart } from "./core/chart";
