// 🔴 敏感扫描**按区**:summary 盖落点章;「最近一次扫描」只看本区(存量无章 = 主控区)。
//   原来 summary 不带 targetId、getLatestScan 全表取最新 ⇒ 两个区各扫一次(定时扫描上线后是常态),
//   A 区视角读到 B 区的结果 —— 治理健康分也吃这一份,于是分数串区。
import { describe, it, expect, vi, beforeEach } from "vitest";

const puts: Array<Record<string, any>> = [];
let summaries: Array<Record<string, any>> = [];

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SENSITIVE_FINDINGS: "bgp-sensitive-findings", DATA_CLASSIFICATION: "bgp-data-classification" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const name = cmd.constructor.name;
      const i = cmd.input;
      if (name === "PutCommand") {
        puts.push(i.Item);
        return {};
      }
      if (name === "ScanCommand") {
        // 两页:验证翻页扫完(Filter 在读之后生效,只读第一页会漏掉更新的那次)
        if (!i.ExclusiveStartKey) return { Items: summaries.slice(0, 2), LastEvaluatedKey: { scanId: "p2" } };
        return { Items: summaries.slice(2) };
      }
      if (name === "QueryCommand") {
        if (i.TableName !== "bgp-sensitive-findings") return { Items: [] }; // 分级表:没有已有分级
        const id = i.ExpressionAttributeValues[":s"];
        const s = summaries.find((x) => x.scanId === id);
        return { Items: s ? [s] : [] };
      }
      throw new Error("unexpected " + name);
    }),
  },
}));
vi.mock("@/lib/redshift/direct-query", () => ({
  resolveDirectQueryPlaceSafe: vi.fn(async (scope: any) => ({
    capability: "available",
    place: { targetId: scope.targetId, region: "us-west-2", workgroup: "wg-usw2", database: "dev" },
  })),
  directQueryRaw: vi.fn(async () => ({ columns: ["phone"], records: [[{ stringValue: "13800138000" }]] })),
}));
vi.mock("@/lib/genbi/schema", () => ({
  introspectSchema: vi.fn(async () => [{ schema: "public", table: "users", columns: [{ name: "phone", type: "varchar" }] }]),
}));
// 🔴 分级模块是同目录兄弟 ⇒ **不 mock**(mock 卫生棘轮):它只读 DDB,而 DDB 上面已经替换成内存版。

import { runSensitiveScan, getLatestScan } from "@/lib/governance/sensitive/scan";

beforeEach(() => {
  puts.length = 0;
  summaries = [];
});

describe("敏感扫描按区(顺带修)", () => {
  it("summary 盖落点章(就是扫的那个区)", async () => {
    const r = await runSensitiveScan({ scope: { targetId: "tgt_usw2_a", projectId: "proj-x" } });
    if ("capability" in r) throw new Error("不该降级");
    expect(r.summary.targetId).toBe("tgt_usw2_a");
    const s = puts.find((p) => p.kind === "summary");
    expect(s?.targetId).toBe("tgt_usw2_a");
  });

  it("最近一次扫描只看本区;存量无章归主控区;翻页扫完", async () => {
    summaries = [
      { scanId: "01A", kind: "summary", sk: "__summary__" },                      // 存量:无章 ⇒ tgt_home
      { scanId: "01B", kind: "summary", sk: "__summary__", targetId: "tgt_usw2_a" },
      { scanId: "01C", kind: "summary", sk: "__summary__", targetId: "tgt_home" },
      { scanId: "01D", kind: "summary", sk: "__summary__", targetId: "tgt_usw2_a" }, // 第二页里更新的那次
    ];
    expect((await getLatestScan({ targetId: "tgt_usw2_a" }))?.summary.scanId).toBe("01D");
    expect((await getLatestScan({ targetId: "tgt_home" }))?.summary.scanId).toBe("01C");
    summaries = summaries.filter((x) => x.scanId === "01A");
    expect((await getLatestScan({ targetId: "tgt_home" }))?.summary.scanId).toBe("01A");
    expect(await getLatestScan({ targetId: "tgt_usw2_a" })).toBeNull();
  });
});
