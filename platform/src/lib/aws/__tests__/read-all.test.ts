// 「读到完为止」的 Scan / Query:一页一页跟到没有下一页为止。
//
// 缺陷原形(2026-11-27):列表类读取只读了第一页;存储服务一次最多读 1MB,表里的内容加起来超过它之后,后面的行被无声丢掉。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { docClient } from "../dynamodb";
import { queryAll, scanAll } from "../read-all";

// 只拦住文档客户端真正发请求的那一步(真外部);唯一作者与它用的客户端模块之间不 mock —— 它拿到的就是产品里的那个客户端。
const send = vi.spyOn(docClient as unknown as { send: (cmd: unknown) => Promise<unknown> }, "send");

type Sent = { constructor: { name: string }; input: Record<string, unknown> };
const sent = () => send.mock.calls.map((c) => c[0] as Sent);

beforeEach(() => {
  send.mockReset();
  // 没有预设应答的调用一律抛:多读一次、或哪一次真的发出去,都当场红
  send.mockImplementation(async () => {
    throw new Error("这一次存储调用没有预设应答");
  });
});

describe("scanAll:把表读完", () => {
  it("没有下一页 ⇒ 只读一次,不带起读位置,条件原样发出去", async () => {
    send.mockResolvedValueOnce({ Items: [{ id: "a" }, { id: "b" }] });
    const input = { TableName: "t", FilterExpression: "x = :x", ExpressionAttributeValues: { ":x": 1 } };
    expect(await scanAll(input)).toEqual([{ id: "a" }, { id: "b" }]);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].constructor.name).toBe("ScanCommand");
    expect(sent()[0].input).toEqual(input);
    expect("ExclusiveStartKey" in sent()[0].input).toBe(false);
  });

  it("有下一页 ⇒ 拿上一页给的位置接着读,直到没有;各页的行按顺序接在一起", async () => {
    send
      .mockResolvedValueOnce({ Items: [{ id: "a" }], LastEvaluatedKey: { id: "a" } })
      .mockResolvedValueOnce({ Items: [{ id: "b" }, { id: "c" }], LastEvaluatedKey: { id: "c" } })
      .mockResolvedValueOnce({ Items: [{ id: "d" }] });
    expect(await scanAll({ TableName: "t" })).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]);
    expect(sent().map((c) => c.input.ExclusiveStartKey)).toEqual([undefined, { id: "a" }, { id: "c" }]);
    expect(sent().every((c) => c.input.TableName === "t")).toBe(true);
  });

  it("一页筛完一条不剩、但还有下一页 ⇒ 照样往下读(过滤是读完一页之后才筛的)", async () => {
    send
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { id: "k1" } })
      .mockResolvedValueOnce({ LastEvaluatedKey: { id: "k2" } })
      .mockResolvedValueOnce({ Items: [{ id: "z" }] });
    expect(await scanAll({ TableName: "t", FilterExpression: "env = :e", ExpressionAttributeValues: { ":e": "prod" } })).toEqual([{ id: "z" }]);
    expect(sent()).toHaveLength(3);
  });

  it("不改调用方传进来的条件对象;某一页读失败 ⇒ 抛出去,不回半截结果", async () => {
    const input = { TableName: "t" };
    send.mockResolvedValueOnce({ Items: [{ id: "a" }], LastEvaluatedKey: { id: "a" } }).mockRejectedValueOnce(new Error("throttled"));
    await expect(scanAll(input)).rejects.toThrow("throttled");
    expect(input).toEqual({ TableName: "t" });
  });
});

describe("queryAll:把一个分区键下的行读完", () => {
  it("逐页跟到没有下一页;排序方向等参数每一页都带着", async () => {
    send
      .mockResolvedValueOnce({ Items: [{ v: 3 }, { v: 2 }], LastEvaluatedKey: { pk: "p", v: 2 } })
      .mockResolvedValueOnce({ Items: [{ v: 1 }] });
    const input = { TableName: "t", KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": "p" }, ScanIndexForward: false };
    expect(await queryAll(input)).toEqual([{ v: 3 }, { v: 2 }, { v: 1 }]);
    expect(sent().map((c) => c.constructor.name)).toEqual(["QueryCommand", "QueryCommand"]);
    expect(sent().map((c) => c.input.ScanIndexForward)).toEqual([false, false]);
    expect(sent().map((c) => c.input.ExclusiveStartKey)).toEqual([undefined, { pk: "p", v: 2 }]);
  });

  it("没有行 ⇒ 空清单", async () => {
    send.mockResolvedValueOnce({});
    expect(await queryAll({ TableName: "t", KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": "none" } })).toEqual([]);
  });
});
