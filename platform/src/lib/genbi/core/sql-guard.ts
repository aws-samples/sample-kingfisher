// @genbi/core — Read-only guard for GenBI model-generated SQL（引擎无关纯逻辑）。
//
// SECURITY: this module is defense-in-depth at the application layer. Only a single
// SELECT / WITH statement is allowed to reach Redshift, and the row count is hard-capped
// by wrapping the query in a bounded sub-select. This does NOT replace database-level
// controls — the platform should ALSO run GenBI under a read-only Redshift user/role.
//
// 【core 契约】零第三方依赖、零 IO、纯正则。可被 platform / 容器 / Lambda 三处复用
// （阶段1:platform 经 re-export；阶段2/3:容器/Lambda 编译成 CJS 后 require）。
// 与 Lambda infra/lambda/genbi-skills/rs.js 的 sanitizeSelect 曾逐字重复,收敛于此。

import { stripSqlComments } from "./sql-comments";

const FORBIDDEN = [
  "insert", "update", "delete", "drop", "create", "alter", "truncate",
  "grant", "revoke", "merge", "call", "copy", "unload", "vacuum", "analyze",
  "comment", "lock", "set", "reset", "begin", "commit", "rollback", "prepare", "execute",
];

export interface GuardResult {
  ok: boolean;
  sql?: string; // sanitized + row-capped SQL safe to execute
  error?: string;
}

// 注释剥除唯一作者 ./sql-comments(与 SQL 血缘解析共用;块注释下标扫描,不用会多项式回溯的正则)。
const stripComments = stripSqlComments;

/**
 * 只读判定(单条 + SELECT/WITH 开头 + 写类关键字整词扫描)。返回规整后的 SQL 或拒因。
 * 问数(sanitizeSelect)与数仓直查的非管理员只读闸(生产上线批次 A)共用这一份,不另写第二套词表。
 */
export function readOnlySelect(raw: string): { ok: true; sql: string } | { ok: false; error: string } {
  if (!raw || !raw.trim()) return { ok: false, error: "空 SQL" };

  let sql = stripComments(raw).trim();
  sql = sql.replace(/;+\s*$/g, "").trim(); // drop trailing semicolons

  if (!sql) return { ok: false, error: "空 SQL" };
  if (sql.includes(";")) return { ok: false, error: "只允许单条查询语句" };

  const lower = sql.toLowerCase();
  if (!/^(select|with)\b/.test(lower)) {
    return { ok: false, error: "只允许 SELECT / WITH 查询" };
  }

  // Whole-word scan for write/DDL keywords (column names like "created_at" are safe
  // because of the word boundaries).
  for (const kw of FORBIDDEN) {
    if (new RegExp(`\\b${kw}\\b`, "i").test(lower)) {
      return { ok: false, error: `查询包含禁止的关键字: ${kw}` };
    }
  }
  return { ok: true, sql };
}

export function sanitizeSelect(raw: string, maxRows: number): GuardResult {
  const ro = readOnlySelect(raw);
  if (!ro.ok) return { ok: false, error: ro.error };
  const sql = ro.sql;

  // Hard row cap, regardless of any LIMIT the model added. A WITH/SELECT query is a
  // valid sub-select in Redshift (PostgreSQL dialect).
  const capped = `SELECT * FROM (\n${sql}\n) AS genbi_q LIMIT ${maxRows}`;
  return { ok: true, sql: capped };
}

// ── Athena / Trino 方言只读守卫（）──
// 与 Redshift 版 sanitizeSelect 的区别：Athena 额外放行 SHOW / DESCRIBE / DESC / EXPLAIN
// 这类元数据/解释语句（无法被子查询包裹，原样放行）；FORBIDDEN 词表按 Trino 方言调整
// （+optimize/msck/load/deallocate，-lock/execute/copy 等 Redshift 专有）。SELECT/WITH
// 仍统一包一层有界子查询硬限行（防扫全表高额扫描费）。
// 收敛于 core：platform(athena/sql-guard) 与 Lambda(genbi-skills Athena 路径) 共用同一份。
const ATHENA_FORBIDDEN = [
  "insert", "update", "delete", "drop", "create", "alter", "truncate",
  "grant", "revoke", "merge", "call", "vacuum", "analyze", "optimize",
  "comment", "set", "reset", "begin", "commit", "rollback", "prepare", "deallocate",
  "msck", "unload", "load",
];

// SELECT / WITH 会被包裹限行；SHOW / DESCRIBE / DESC / EXPLAIN 原样放行（无法被子查询包裹）。
const ATHENA_WRAPPABLE = /^(select|with)\b/;
const ATHENA_PASSTHROUGH = /^(show|describe|desc|explain)\b/;

export function sanitizeReadOnly(raw: string, maxRows: number): GuardResult {
  if (!raw || !raw.trim()) return { ok: false, error: "空 SQL" };

  let sql = stripComments(raw).trim();
  sql = sql.replace(/;+\s*$/g, "").trim(); // 去掉结尾分号

  if (!sql) return { ok: false, error: "空 SQL" };
  if (sql.includes(";")) return { ok: false, error: "只允许单条查询语句" };

  const lower = sql.toLowerCase();
  const isWrappable = ATHENA_WRAPPABLE.test(lower);
  const isPassthrough = ATHENA_PASSTHROUGH.test(lower);
  if (!isWrappable && !isPassthrough) {
    return { ok: false, error: "只允许 SELECT / WITH / SHOW / DESCRIBE / EXPLAIN 只读查询" };
  }

  // 整词扫描写/DDL 关键字（列名如 created_at 因词边界而安全）。
  for (const kw of ATHENA_FORBIDDEN) {
    if (new RegExp(`\\b${kw}\\b`, "i").test(lower)) {
      return { ok: false, error: `查询包含禁止的关键字: ${kw}` };
    }
  }

  if (isPassthrough) return { ok: true, sql };

  // SELECT / WITH：无论模型/用户是否已写 LIMIT，统一包一层有界子查询硬限行（Trino/Athena 方言）。
  const capped = `SELECT * FROM (\n${sql}\n) AS bgp_athena_q LIMIT ${maxRows}`;
  return { ok: true, sql: capped };
}
