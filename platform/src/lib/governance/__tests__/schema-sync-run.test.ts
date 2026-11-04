// → —— 治理目录「同步列信息」运行记录(runSchemaSyncRecorded / readSchemaSyncRun)。
// 【缺陷原形】POST 同步长调用超 ALB 60s 墙 ⇒ 504,而工作在后台做完了(s38 复跑 71d)。
// 治理专用的「45s 内回应 / 202 running / 并入 joined」协议退役:等待与 202 由统一框架接管
//   (submitLongOp 45s 转 202;并发由对象租约 governance:schema-sync 挡成 409),本模块只剩**运行记录**:
//   条件写 running(别的实例已在跑 ⇒ 抛,不起第二份)→ 跑工作 → 落终态并返回;GET 读「最近一次同步」不变(stale 判定不变)。
// 【只 mock 真外部】DDB(settings 表)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rows: new Map<string, Record<string, any>>(),
  calls: [] as Array<{ cmd: string; input: Record<string, unknown> }>,
}));
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SETTINGS: "bgp-settings" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const input = cmd.input as Record<string, any>;
      h.calls.push({ cmd: cmd.constructor.name, input });
      const n = cmd.constructor.name;
      if (n === "GetCommand") { const it = h.rows.get(input.Key.sk); return it ? { Item: { ...it } } : {}; }
      if (n === "PutCommand") {
        const cur = h.rows.get(input.Item.sk);
        if (input.ConditionExpression && cur) {
          const vals = input.ExpressionAttributeValues || {};
          const notRunning = cur.state !== vals[":running"];
          const stale = String(cur.startedAt) < String(vals[":staleBefore"]);
          if (!(notRunning || stale)) { const e = new Error("The conditional request failed"); e.name = "ConditionalCheckFailedException"; throw e; }
        }
        h.rows.set(input.Item.sk, { ...input.Item });
        return {};
      }
      return {};
    }),
  },
}));

import * as mod from "@/lib/governance/schema-sync-run";
import { runSchemaSyncRecorded, readSchemaSyncRun, SCHEMA_SYNC_SK, SCHEMA_SYNC_STALE_MS } from "@/lib/governance/schema-sync-run";

const RESULT = { tables: 3, columns: 20, redshift: { tables: 1, columns: 5 }, s3tables: { tables: 2, columns: 15 } };
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const p = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { p, resolve, reject }; }

beforeEach(() => { h.rows.clear(); h.calls.length = 0; });

describe("schema-sync-run(只剩运行记录)", () => {
  it("治理专用 202 协议已退役:模块不再导出 startOrJoinSchemaSync / SCHEMA_SYNC_RESPOND_WITHIN_MS;15 分钟判过期不变", () => {
    expect((mod as Record<string, unknown>).startOrJoinSchemaSync).toBeUndefined();
    expect((mod as Record<string, unknown>).SCHEMA_SYNC_RESPOND_WITHIN_MS).toBeUndefined();
    expect(SCHEMA_SYNC_STALE_MS).toBe(15 * 60_000);
  });
  it("工作做完 ⇒ 回 succeeded 带结果;记录落 settings 表(pk system / sk governance#schema-sync),先 running 后终态两次写", async () => {
    const run = await runSchemaSyncRecorded({ work: async () => RESULT, startedBy: "admin" });
    expect(run).toMatchObject({ state: "succeeded", result: RESULT, startedBy: "admin" });
    expect(typeof run.finishedAt).toBe("string");
    const stored = h.rows.get(SCHEMA_SYNC_SK)!;
    expect(stored).toMatchObject({ pk: "system", state: "succeeded", runId: run.runId });
    const puts = h.calls.filter((c) => c.cmd === "PutCommand").map((c) => (c.input.Item as { state: string }).state);
    expect(puts).toEqual(["running", "succeeded"]);
    // 第一笔是条件写(别的实例在跑就写不进)
    expect(String(h.calls.find((c) => c.cmd === "PutCommand")!.input.ConditionExpression)).toContain("attribute_not_exists(sk)");
  });
  it("工作进行中 ⇒ GET 读到 running(同一 runId);做完后读到 succeeded 带结果", async () => {
    const d = deferred<typeof RESULT>();
    const inflight = runSchemaSyncRecorded({ work: () => d.p, startedBy: "admin" });
    await new Promise((r) => setTimeout(r, 5));
    const during = await readSchemaSyncRun();
    expect(during?.state).toBe("running");
    d.resolve(RESULT);
    const run = await inflight;
    const after = await readSchemaSyncRun();
    expect(after).toMatchObject({ state: "succeeded", runId: run.runId, result: RESULT });
    expect(during?.runId).toBe(run.runId);
  });
  it("🔴 已有一次在跑(别的实例写了 running)⇒ 抛「已有一次同步正在进行」,工作一次都不起;那条记录不被覆盖", async () => {
    h.rows.set(SCHEMA_SYNC_SK, { pk: "system", sk: SCHEMA_SYNC_SK, runId: "sr_other", state: "running", startedAt: new Date().toISOString(), startedBy: "other" });
    const work = vi.fn(async () => RESULT);
    await expect(runSchemaSyncRecorded({ work, startedBy: "me" })).rejects.toThrow(/已有一次同步正在进行/);
    expect(work).not.toHaveBeenCalled();
    expect(h.rows.get(SCHEMA_SYNC_SK)).toMatchObject({ runId: "sr_other", state: "running" });
  });
  it("工作报错 ⇒ failed 带原话(不是 running 也不是成功),且**返回**而不是抛(执行体据此回 500「同步失败: …」)", async () => {
    const run = await runSchemaSyncRecorded({ work: async () => { throw new Error("OpenMetadata 503"); }, startedBy: "admin" });
    expect(run).toMatchObject({ state: "failed", error: "OpenMetadata 503" });
    expect(h.rows.get(SCHEMA_SYNC_SK)!.state).toBe("failed");
  });
  it("running 超过 15 分钟没结束 ⇒ 读出来是 failed(stale=true,说清「没有结束」),并允许重新起一次", async () => {
    const old = new Date(Date.now() - SCHEMA_SYNC_STALE_MS - 60_000).toISOString();
    h.rows.set(SCHEMA_SYNC_SK, { pk: "system", sk: SCHEMA_SYNC_SK, runId: "sr_old", state: "running", startedAt: old, startedBy: "x" });
    const read = await readSchemaSyncRun();
    expect(read).toMatchObject({ state: "failed", stale: true, runId: "sr_old" });
    expect(String(read!.error)).toContain("没有结束");
    const run = await runSchemaSyncRecorded({ work: async () => RESULT, startedBy: "admin" });
    expect(run.state).toBe("succeeded");
    expect(run.runId).not.toBe("sr_old");
  });
  it("两个实例同时起(条件写撞上)⇒ 后到的抛、不跑工作;非条件撞车的写失败原样上抛", async () => {
    const sendReal = (await import("@/lib/aws/dynamodb")).docClient.send as unknown as ReturnType<typeof vi.fn>;
    const orig = sendReal.getMockImplementation()!;
    let puts = 0;
    sendReal.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === "PutCommand" && puts++ === 0) {
        // 写的那一刻别的实例已把 running 写进去 ⇒ 条件写失败
        h.rows.set(SCHEMA_SYNC_SK, { pk: "system", sk: SCHEMA_SYNC_SK, runId: "sr_other", state: "running", startedAt: new Date().toISOString(), startedBy: "other" });
      }
      return orig(cmd);
    });
    const work = vi.fn(async () => RESULT);
    await expect(runSchemaSyncRecorded({ work, startedBy: "me" })).rejects.toThrow(/已有一次同步正在进行/);
    expect(work).not.toHaveBeenCalled();
    sendReal.mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === "PutCommand") throw new Error("ProvisionedThroughputExceeded");
      return orig(cmd);
    });
    await expect(runSchemaSyncRecorded({ work, startedBy: "me" })).rejects.toThrow(/ProvisionedThroughputExceeded/);
    expect(work).not.toHaveBeenCalled();
    sendReal.mockImplementation(orig);
  });
});
