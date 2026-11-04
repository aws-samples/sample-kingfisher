// 审计的区章(派生规则 + 显式传)与**按区读必须翻页**。
//
// 🔴 承重的两条:
//  ① 派生规则:`resourceType==="exec-env"` 时 `resourceId` 就是 targetId ——
//     这条让 12 条 exec-env 路由一次全部盖上章,而不必去改 138 个 recordAudit 调用点;
//  ② 翻页:DDB 的 Limit 是**过滤之前**的量。不翻页 ⇒「最近 500 条里恰好属于这个区的那几条」,
//     而审计日志被静默截断的后果是复盘时那条动作根本不存在。
import { describe, it, expect, vi, beforeEach } from "vitest";

let pages: Array<{ Items: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> }> = [];
let sentLimits: number[] = [];

vi.mock("@/lib/aws/dynamodb", () => ({
  docClient: {
    send: vi.fn(async (cmd: { input?: Record<string, unknown> }) => {
      sentLimits.push(Number(cmd?.input?.Limit ?? 0));
      return pages.shift() ?? { Items: [] };
    }),
  },
  TABLES: { AUDIT: "bgp-audit" },
}));

import { buildAuditItem, queryAuditLog } from "../audit";

describe("区章的派生规则", () => {
  it("🔴 exec-env 类动作:resourceId 就是 targetId(一处派生覆盖 12 条路由)", () => {
    const { item } = buildAuditItem({ actor: "u" }, "exec-env.deploy", { resourceType: "exec-env", resourceId: "tgt_usw2_a" });
    expect(item.targetId).toBe("tgt_usw2_a");
  });
  it("显式传的优先(数据面动作自己知道真落点)", () => {
    const { item } = buildAuditItem({ actor: "u" }, "quality.run", { resourceType: "quality-run", resourceId: "public.t", targetId: "tgt_usw2_a" });
    expect(item.targetId).toBe("tgt_usw2_a");
  });
  it("🔴 非 exec-env 类且没显式传 ⇒ **不盖章**(不猜;读侧统一按主控区回落)", () => {
    const { item } = buildAuditItem({ actor: "u" }, "datasource.create", { resourceType: "datasource", resourceId: "ds1" });
    expect("targetId" in item).toBe(false);
  });
  it("🔴 resourceId 形态不是合法 targetId ⇒ 不盖章(不把一个随便的 id 当区)", () => {
    const { item } = buildAuditItem({ actor: "u" }, "exec-env.x", { resourceType: "exec-env", resourceId: "not-a-target" });
    expect("targetId" in item).toBe(false);
  });
});

describe("按区读", () => {
  beforeEach(() => {
    pages = [];
    sentLimits = [];
  });

  it("不传 scope ⇒ 单页、Limit 与改动前逐字节相同(回滚点)", async () => {
    pages = [{ Items: [{ ts: "1" }, { ts: "2" }] }];
    const out = await queryAuditLog(200);
    expect(out).toHaveLength(2);
    expect(sentLimits).toEqual([200]);
  });

  it("🔴 传 scope ⇒ 翻页直到凑够(不翻页就会静默截断审计日志)", async () => {
    // 第一页 3 条全是主控区的,第二页才有 usw2 的两条
    pages = [
      { Items: [{ ts: "1", targetId: "tgt_home" }, { ts: "2" }, { ts: "3", targetId: "tgt_home" }], LastEvaluatedKey: { ts: "3" } },
      { Items: [{ ts: "4", targetId: "tgt_usw2_a" }, { ts: "5", targetId: "tgt_usw2_a" }] },
    ];
    const out = await queryAuditLog(2, { scope: { kind: "target", targetId: "tgt_usw2_a" } });
    expect(out.map((r) => r.ts)).toEqual(["4", "5"]);
    expect(sentLimits.length, "只发了一次 Query ⇒ 没翻页").toBeGreaterThan(1);
  });

  it("🔴 存量无章条目归主控区(与全平台统一回落一致)", async () => {
    pages = [{ Items: [{ ts: "1", targetId: "tgt_usw2_a" }, { ts: "2" }] }];
    const out = await queryAuditLog(500, { scope: { kind: "target", targetId: "tgt_home" } });
    expect(out.map((r) => r.ts)).toEqual(["2"]);
  });

  it("凑够就停(不无谓翻到表尾)", async () => {
    pages = [
      { Items: [{ ts: "1", targetId: "tgt_usw2_a" }], LastEvaluatedKey: { ts: "1" } },
      { Items: [{ ts: "2", targetId: "tgt_usw2_a" }] },
    ];
    const out = await queryAuditLog(1, { scope: { kind: "target", targetId: "tgt_usw2_a" } });
    expect(out).toHaveLength(1);
    expect(sentLimits).toHaveLength(1);
  });
});
