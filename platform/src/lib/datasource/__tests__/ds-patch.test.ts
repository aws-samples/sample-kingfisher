// 序 60 B-132 —— patchDataSourceRow 是数据源状态回写的唯一作者,调用方全是在途的 fire-and-forget 收口:
//   源在收口前被删 ⇒ DynamoDB UpdateItem 对不存在的键是 upsert ⇒ 原来凭空造出只有状态字段的幽灵行(2026-10-28 测试账号三条)。
//   判据:① 每次写都带 attribute_exists(datasourceId) 条件;② 条件不满足(源已删)⇒ 回 gone、不抛、不写;③ 别的错误照抛;④ 空 patch 不写。
//   只 mock 真外部(DDB docClient)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ sends: [] as any[], failWith: null as Error | null }));
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { DATASOURCES: "bgp-datasources" },
  docClient: { send: vi.fn(async (cmd: any) => { h.sends.push(cmd); if (h.failWith) throw h.failWith; return {}; }) },
}));

import { patchDataSourceRow } from "@/lib/datasource/ds-patch";

beforeEach(() => { h.sends.length = 0; h.failWith = null; });

describe("🔴 B-132 patchDataSourceRow 条件写", () => {
  it("① 写带 attribute_exists(datasourceId),键 / SET / updatedAt 与改前同形 ⇒ patched", async () => {
    const r = await patchDataSourceRow("ds-1", { status: "unreachable", heartbeat: { at: "t" } });
    expect(r).toBe("patched");
    expect(h.sends).toHaveLength(1);
    const input = h.sends[0].input;
    expect(input.TableName).toBe("bgp-datasources");
    expect(input.Key).toEqual({ userId: "default-user", datasourceId: "ds-1" });
    expect(input.ConditionExpression).toBe("attribute_exists(datasourceId)");
    expect(input.UpdateExpression).toBe("SET #k0 = :v0, #k1 = :v1, updatedAt = :now");
    expect(input.ExpressionAttributeNames).toEqual({ "#k0": "status", "#k1": "heartbeat" });
    expect(input.ExpressionAttributeValues[":v0"]).toBe("unreachable");
    expect(typeof input.ExpressionAttributeValues[":now"]).toBe("string");
  });
  it("② 源已删(ConditionalCheckFailedException)⇒ gone,不抛(在途结论丢弃,不造幽灵行)", async () => {
    h.failWith = Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
    await expect(patchDataSourceRow("ds-gone", { status: "unreachable" })).resolves.toBe("gone");
  });
  it("③ 别的错误(限流 / 权限)照抛,不许被吞成 gone", async () => {
    h.failWith = Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" });
    await expect(patchDataSourceRow("ds-1", { status: "x" })).rejects.toThrow(/throttled/);
  });
  it("④ 空 patch 不发任何写 ⇒ noop", async () => {
    expect(await patchDataSourceRow("ds-1", {})).toBe("noop");
    expect(h.sends).toHaveLength(0);
  });
});
