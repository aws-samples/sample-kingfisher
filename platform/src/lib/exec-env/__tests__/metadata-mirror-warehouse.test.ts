// 数仓目录采集的截断判定。🔴 差集删除(镜像 + OM 对账)只在「不截断」时做 ⇒
// 「超过上限」必须**真的可被看见**:SQL 要多取一行,结果处理要在第 MAX+1 行上报截断。
// 两条一起才成立 —— 只改一半(SQL 仍 LIMIT MAX,或处理不看第 MAX+1 行)都会让截断永远报不出来。
import { describe, it, expect } from "vitest";
import { WAREHOUSE_TABLES_SQL, warehouseRowsToOutcome } from "@/lib/exec-env/metadata-mirror-warehouse";
import { MIRROR_MAX_ENTRIES } from "@/lib/exec-env/metadata-mirror";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ["dev", "public", `t${i}`, "BASE TABLE"]);

describe("🔴 数仓采集:截断必须可被看见", () => {
  it("SQL 多取一行(LIMIT = MAX + 1),否则第 MAX+1 行永远读不到", () => {
    const m = WAREHOUSE_TABLES_SQL.match(/LIMIT\s+(\d+)\s*$/);
    expect(m && Number(m[1])).toBe(MIRROR_MAX_ENTRIES + 1);
  });
  it("恰好 MAX 行 ⇒ 不截断(完整)", () => {
    const r = warehouseRowsToOutcome(rows(MIRROR_MAX_ENTRIES), false);
    expect(r.truncated).toBe(false);
    expect(r.tables).toBe(MIRROR_MAX_ENTRIES);
  });
  it("🔴 MAX + 1 行 ⇒ 截断,且只收 MAX 张", () => {
    const r = warehouseRowsToOutcome(rows(MIRROR_MAX_ENTRIES + 1), false);
    expect(r.truncated).toBe(true);
    expect(r.tables).toBe(MIRROR_MAX_ENTRIES);
  });
  it("分页读到上限还没读完 ⇒ 截断;数仓没有局部读失败 ⇒ unreadDatabases 恒空", () => {
    const r = warehouseRowsToOutcome(rows(3), true);
    expect(r.truncated).toBe(true);
    expect(r.unreadDatabases).toEqual([]);
    expect(r.entries.filter((e) => e.kind === "db").map((e) => e.fqn)).toEqual(["redshift.dev.public"]);
  });
});
