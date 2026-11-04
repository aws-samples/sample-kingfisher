import { describe, it, expect } from "vitest";
import { sanitizeSelect } from "../sql-guard";
import { sanitizeReadOnly } from "../core/sql-guard";

// SECURITY-CRITICAL: this guard is the application-layer defense that keeps model-generated
// SQL read-only. These tests pin its contract so a refactor can't silently weaken it.
describe("sanitizeSelect", () => {
  it("allows a simple SELECT and applies a hard row cap", () => {
    const r = sanitizeSelect("SELECT id, name FROM customers", 100);
    expect(r.ok).toBe(true);
    expect(r.sql).toContain("SELECT id, name FROM customers");
    expect(r.sql).toMatch(/LIMIT 100\s*$/);
    // wrapped in a bounded sub-select
    expect(r.sql).toContain("AS genbi_q");
  });

  it("allows a WITH (CTE) query", () => {
    const r = sanitizeSelect("WITH t AS (SELECT 1 AS x) SELECT x FROM t", 50);
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/LIMIT 50\s*$/);
  });

  it("caps even when the model already added a LIMIT (defense in depth)", () => {
    const r = sanitizeSelect("SELECT * FROM orders LIMIT 999999", 10);
    expect(r.ok).toBe(true);
    // outer cap wins regardless of inner LIMIT
    expect(r.sql).toMatch(/LIMIT 10\s*$/);
  });

  it.each([
    ["INSERT", "INSERT INTO t VALUES (1)"],
    ["UPDATE", "UPDATE t SET a=1"],
    ["DELETE", "DELETE FROM t"],
    ["DROP", "DROP TABLE t"],
    ["CREATE", "CREATE TABLE t (a int)"],
    ["ALTER", "ALTER TABLE t ADD COLUMN a int"],
    ["TRUNCATE", "TRUNCATE t"],
    ["GRANT", "GRANT SELECT ON t TO u"],
    ["MERGE", "MERGE INTO t USING s ON t.id=s.id"],
    ["COPY", "COPY t FROM 's3://x'"],
    ["UNLOAD", "UNLOAD ('select 1') TO 's3://x'"],
  ])("rejects a leading %s statement", (_kw, sql) => {
    const r = sanitizeSelect(sql, 100);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("rejects DML smuggled inside a CTE (single statement — caught by keyword scan, not the ';' check)", () => {
    // Redshift/Postgres support writable CTEs; this is a real read-only-bypass vector.
    // It starts with WITH and has no semicolon, so only the whole-word keyword scan stops it.
    const r = sanitizeSelect("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", 100);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("delete");
  });

  it("rejects multiple statements (stacked queries)", () => {
    const r = sanitizeSelect("SELECT 1 ; SELECT 2", 100);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("单条");
  });

  it("strips trailing semicolons from an otherwise single statement", () => {
    const r = sanitizeSelect("SELECT 1 ;", 100);
    expect(r.ok).toBe(true);
  });

  it("does NOT trip on column names that merely contain keywords (word boundaries)", () => {
    // created_at / update_time are legitimate identifiers, not the UPDATE/CREATE keywords
    const r = sanitizeSelect("SELECT created_at, update_time, dropped FROM events", 100);
    expect(r.ok).toBe(true);
  });

  it("ignores forbidden keywords hidden in comments", () => {
    const r = sanitizeSelect("SELECT 1 -- drop table t\n", 100);
    expect(r.ok).toBe(true);
  });

  it("rejects empty / whitespace-only input", () => {
    expect(sanitizeSelect("", 100).ok).toBe(false);
    expect(sanitizeSelect("   \n  ", 100).ok).toBe(false);
  });

  it("rejects a non-SELECT/WITH leading token", () => {
    expect(sanitizeSelect("EXPLAIN SELECT 1", 100).ok).toBe(false);
    expect(sanitizeSelect("SHOW TABLES", 100).ok).toBe(false);
  });
});

// SECURITY-CRITICAL: Athena/Trino 方言只读守卫。与 Redshift 版的关键差异 = 放行
// SHOW/DESCRIBE/EXPLAIN 元数据语句(无副作用),但写/DDL/多语句仍全拒。§5 安全性验证的沉淀。
describe("sanitizeReadOnly (Athena/Trino 方言)", () => {
  it("SELECT/WITH 放行并硬限行(包 bgp_athena_q 子查询)", () => {
    const r = sanitizeReadOnly("SELECT * FROM orders", 100);
    expect(r.ok).toBe(true);
    expect(r.sql).toContain("AS bgp_athena_q");
    expect(r.sql).toMatch(/LIMIT 100\s*$/);
  });

  it.each([
    ["SHOW TABLES"],
    ["SHOW DATABASES"],
    ["DESCRIBE orders"],
    ["DESC orders"],
    ["EXPLAIN SELECT 1"],
  ])("放行只读元数据/解释语句(原样,不包裹): %s", (sql) => {
    const r = sanitizeReadOnly(sql, 100);
    expect(r.ok).toBe(true);
    expect(r.sql).toBe(sql); // passthrough，不包裹
  });

  it.each([
    ["INSERT INTO t VALUES (1)"],
    ["UPDATE t SET a=1"],
    ["DELETE FROM t"],
    ["DROP TABLE t"],
    ["CREATE TABLE t (a int)"],
    ["ALTER TABLE t ADD COLUMN a int"],
    ["UNLOAD ('select 1') TO 's3://x'"],
    ["optimize orders"],       // Trino 专有写操作
    ["msck repair table t"],   // 分区修复
  ])("安全红线:写/DDL/Trino 副作用语句仍全拒: %s", (sql) => {
    expect(sanitizeReadOnly(sql, 100).ok).toBe(false);
  });

  it("安全红线:多语句注入仍拒(stacked queries)", () => {
    expect(sanitizeReadOnly("SHOW TABLES ; DROP TABLE t", 100).ok).toBe(false);
    expect(sanitizeReadOnly("SELECT 1 ; SELECT 2", 100).ok).toBe(false);
  });

  it("安全红线:CTE 内藏写操作仍拒(词扫描)", () => {
    expect(sanitizeReadOnly("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", 100).ok).toBe(false);
  });

  it("列名含关键字词根不误伤(词边界)", () => {
    expect(sanitizeReadOnly("SELECT created_at, load_time FROM events", 100).ok).toBe(true);
  });
});
