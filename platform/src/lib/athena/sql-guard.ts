// 模块 24 — Athena 只读 SQL 守卫（应用层防御，深度防御之一）。
//
// SECURITY: 仅允许单条只读语句（SELECT / WITH / SHOW / DESCRIBE / EXPLAIN）到达 Athena。
// 对 SELECT / WITH 额外包一层有界子查询硬性限制返回行数（防扫全表导致高额扫描费用）；
// SHOW / DESCRIBE / EXPLAIN 这类语句不能被包裹，原样放行。这不替代底层访问控制——
// 平台对 S3 Tables 的访问仍由 IAM + Lake Formation 治理，且整条链路统一只读。
//
// 【已收敛进 @genbi/core】守卫逻辑下沉 core/sql-guard（与 Lambda genbi-skills 的 Athena
// 路径共用同一份），此处 re-export 保持现有 import 路径与 AthenaGuardResult 类型名不变。
import type { GuardResult } from "@/lib/genbi/core/sql-guard";
export { sanitizeReadOnly } from "@/lib/genbi/core/sql-guard";

// 类型别名保持向后兼容（历史消费方引用 AthenaGuardResult）。
export type AthenaGuardResult = GuardResult;
