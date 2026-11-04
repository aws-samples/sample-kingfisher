// GenBI SQL 只读守卫 —— 逻辑已收敛进 @genbi/core（引擎无关纯逻辑,容器/Lambda 共用同一份）。
// 此文件保留为兼容入口(re-export),使现有 import 路径 "@/lib/genbi/sql-guard" 无需改动。
// 模块46 阶段1:抽 core 纯逻辑,消除跨语言副本(此前与 infra/lambda/genbi-skills/rs.js 逐字重复)。
export { sanitizeSelect } from "./core/sql-guard";
export type { GuardResult } from "./core/sql-guard";
