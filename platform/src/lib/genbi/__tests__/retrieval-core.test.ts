import { describe, it, expect } from "vitest";
import { buildSemanticCatalog, selectRelevantTables } from "../core/retrieval-core";
import type { ModelClient } from "../core/model-client";
import type { SchemaTable, PublishedHint } from "../core/types";

// core 检索逻辑单测:用 fake ModelClient 注入,不依赖真实 Bedrock —— 验证 core 抽取后
// selectRelevantTables 的选择/回退/固化优先逻辑不变(阶段1c 引入 ModelClient 接口)。

const tables: SchemaTable[] = [
  { schema: "public", table: "players", columns: [{ name: "player_id", type: "int" }, { name: "channel", type: "varchar" }] },
  { schema: "public", table: "payments", columns: [{ name: "player_id", type: "int" }, { name: "amount", type: "decimal" }] },
  { schema: "public", table: "game_sessions", columns: [{ name: "session_id", type: "int" }, { name: "duration", type: "int" }] },
];

// fake ModelClient:返回预设的 JSON 文本,断言 core 如何解析。
function fakeModel(text: string): ModelClient {
  return { async converse() { return { text, usage: { inputTokens: 1, outputTokens: 1 } }; } };
}

describe("buildSemanticCatalog", () => {
  it("挂上 OM 描述与固化表标记", () => {
    const pub: PublishedHint[] = [{ targetTable: "payments", title: "付费汇总", question: "各渠道付费" }];
    const cat = buildSemanticCatalog(tables, { players: "玩家主表" }, pub);
    expect(cat.find((e) => e.table === "players")?.description).toBe("玩家主表");
    expect(cat.find((e) => e.table === "payments")?.published?.title).toBe("付费汇总");
    expect(cat.find((e) => e.table === "game_sessions")?.description).toBeUndefined();
  });
});

describe("selectRelevantTables", () => {
  it("空目录 → usedFallback", async () => {
    const r = await selectRelevantTables("q", [], [], {}, fakeModel("{}"));
    expect(r.usedFallback).toBe(true);
    expect(r.selected).toEqual([]);
  });

  it("唯一表 → 直接选中不走模型", async () => {
    const r = await selectRelevantTables("q", [tables[0]], [], {}, fakeModel("SHOULD_NOT_BE_USED"));
    expect(r.usedFallback).toBe(false);
    expect(r.selected).toHaveLength(1);
    expect(r.matches[0].reason).toBe("唯一可用表");
  });

  it("模型选出有效表 → 命中 matches", async () => {
    const model = fakeModel(JSON.stringify({ tables: [{ schema: "public", table: "payments", reason: "含金额", preferred: false }] }));
    const r = await selectRelevantTables("各渠道付费多少", tables, [], {}, model);
    expect(r.usedFallback).toBe(false);
    expect(r.selected.map((e) => e.table)).toContain("payments");
    expect(r.matches[0].reason).toContain("金额");
  });

  it("preferred 只认真实固化表(e.published),不轻信模型自报", async () => {
    const pub: PublishedHint[] = [{ targetTable: "payments", title: "付费汇总" }];
    // 模型对 players 谎报 preferred=true,但 players 非固化表 → 应为 false
    const model = fakeModel(JSON.stringify({ tables: [
      { schema: "public", table: "players", reason: "x", preferred: true },
      { schema: "public", table: "payments", reason: "y", preferred: false },
    ] }));
    const r = await selectRelevantTables("q", tables, pub, {}, model);
    const players = r.matches.find((m) => m.table === "players");
    const payments = r.matches.find((m) => m.table === "payments");
    expect(players?.preferred).toBe(false);      // 非固化,模型谎报无效
    expect(payments?.preferred).toBe(true);       // 真实固化表
  });

  it("模型没选出有效表 → 回退全部", async () => {
    const model = fakeModel(JSON.stringify({ tables: [{ schema: "public", table: "不存在的表", reason: "x" }] }));
    const r = await selectRelevantTables("q", tables, [], {}, model);
    expect(r.usedFallback).toBe(true);
    expect(r.selected).toHaveLength(3);
  });

  it("模型抛异常 → 回退全部不中断", async () => {
    const model: ModelClient = { async converse() { throw new Error("bedrock down"); } };
    const r = await selectRelevantTables("q", tables, [], {}, model);
    expect(r.usedFallback).toBe(true);
    expect(r.selected).toHaveLength(3);
    expect(r.note).toContain("检索异常");
  });

  it("非法 JSON → 回退全部", async () => {
    const r = await selectRelevantTables("q", tables, [], {}, fakeModel("模型胡言乱语没有JSON"));
    expect(r.usedFallback).toBe(true);
    expect(r.selected).toHaveLength(3);
  });
});
