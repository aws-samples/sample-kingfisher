import { describe, it, expect } from "vitest";
import { guard } from "../guard";

// 对抗性 fuzz(复核 agent 曾用同类思路命中 706 例静默损坏)。验证修复后:
// 任意"真违规 + 字符串/注释内 anti-pattern 共存"组合下,单引号字符串内容原样保留、且幂等。
describe("cookbook guard — 对抗性 fuzz(零损坏 + 幂等)", () => {
  const violations = ["CREATE TABLE IF NOT EXISTS mart AS ", "CREATE OR REPLACE TABLE t AS ", ""];
  const frags = [
    "SELECT x FROM t WHERE note='a `b` c'",
    "SELECT 1 WHERE s='CREATE TABLE IF NOT EXISTS fake AS z'",
    "SELECT `realcol`, 'lit `x` lit' FROM t",
    "SELECT 1 /* `cmt` CREATE TABLE IF NOT EXISTS c AS */ FROM t",
    "SELECT `a`, `b`, 'has ''quoted'' text'",
    "SELECT `c` -- don't use `backtick`\n FROM t",
  ];
  it("所有组合:单引号字符串内容原样保留 + 幂等", () => {
    let checked = 0;
    for (const v of violations) {
      for (const s of frags) {
        const sql = v + s + ";";
        const r = guard("redshift", sql);
        checked++;
        // 单引号字符串字面量必须原样存在于输出(未被 fix 改动)。
        const strLits = sql.match(/'(?:[^']|'')*'/g) || [];
        for (const lit of strLits) {
          expect(r.code, `字符串被改坏: IN=${sql} OUT=${r.code}`).toContain(lit);
        }
        // 幂等:二次 guard 结果不变。
        expect(guard("redshift", r.code).code, `非幂等: ${r.code}`).toBe(r.code);
      }
    }
    expect(checked).toBe(violations.length * frags.length);
  });
});
