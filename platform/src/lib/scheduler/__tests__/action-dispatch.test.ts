// 🔴🔴 平台动作命令的**消费端状态机**:pending → running → succeeded | failed。
//
// 判据钉的是**收口**,不是「动作被调用了」(记忆 verify-must-assert-settled-state):
//   ① 正常路径:命令最终是 succeeded + 摘要,`startedAt`/`finishedAt` 都盖了;
//   ② 执行体抛错 ⇒ failed + 真因(不许停在 running,DAG 那头会白等到租约);
//   ③ 重复投递(Streams 至少一次)⇒ 只有一个抢得到;第二个是 not-pending,不重复执行;
//   ④ 非法命令(白名单外 / 缺项目 / 空参数)⇒ 当场 failed,执行体一次都不调;
//   ⑤ 终态只能从 running 写(不覆盖别人的结果);
//   ⑥ 白名单里每一条动作都有执行体,执行体不多出白名单之外的 id。
// 🔴 mock 只替换真外部(DynamoDB),并**真的实现** ConditionExpression 语义 —— 只断命令形状的 mock
//    挡不住「先读再写」的退化(形状一样,并发下两个都抢到)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, Record<string, any>>();

function condOk(cond: string | undefined, row: Record<string, any> | undefined, names: Record<string, string>, vals: Record<string, any>): boolean {
  if (!cond) return true;
  const c = cond.trim();
  if (c === "#s = :pending") return row !== undefined && row[names["#s"]] === vals[":pending"];
  if (c === "#s = :running") return row !== undefined && row[names["#s"]] === vals[":running"];
  throw new Error(`mock 不认识这条 ConditionExpression:${c}`);
}

function applySet(row: Record<string, any>, ue: string, names: Record<string, string>, vals: Record<string, any>) {
  const setPart = ue.replace(/^SET\s+/, "");
  for (const assign of setPart.split(",")) {
    const [lhs, rhs] = assign.split("=").map((x) => x.trim());
    row[names[lhs] ?? lhs] = vals[rhs];
  }
}

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { ACTION_COMMANDS: "bgp-action-commands" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const i = cmd.input;
      const name = cmd.constructor.name;
      if (name === "GetCommand") {
        const row = store.get(i.Key.commandId);
        return { Item: row ? JSON.parse(JSON.stringify(row)) : undefined };
      }
      if (name === "UpdateCommand") {
        const row = store.get(i.Key.commandId);
        if (!condOk(i.ConditionExpression, row, i.ExpressionAttributeNames || {}, i.ExpressionAttributeValues || {})) {
          const e = new Error("The conditional request failed");
          (e as any).name = "ConditionalCheckFailedException";
          throw e;
        }
        applySet(row!, i.UpdateExpression, i.ExpressionAttributeNames || {}, i.ExpressionAttributeValues || {});
        return {};
      }
      throw new Error(`mock 不认识的命令 ${name}`);
    }),
  },
}));

import { dispatchCommand, finishCommand, type ActionHandlers } from "@/lib/scheduler/action-dispatch";
import { ACTION_HANDLERS } from "@/lib/scheduler/action-handlers";
import { DISPATCHABLE_ACTIONS } from "@/lib/scheduler/action-commands";

function seed(over: Record<string, unknown> = {}) {
  const row = {
    commandId: "0001-aaaa",
    action: "governance.quality-check",
    targetId: "tgt_usw2_a",
    projectId: "proj-default",
    params: { fqns: ["bgp-redshift.dev.public.orders"] },
    runId: "ex_1#tgt_usw2_a",
    taskId: "gov_01TEST",
    requestedAt: "2026-10-10T00:00:00.000Z",
    status: "pending",
    ttl: 1,
    ...over,
  };
  store.set(String(row.commandId), row);
  return row;
}

beforeEach(() => store.clear());

describe("平台动作命令的消费端状态机", () => {
  it("① 正常路径收口到 succeeded + 摘要;执行体拿到的落点 / 项目 / 参数都来自命令行本身", async () => {
    seed();
    const seen: any[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handlers: ActionHandlers = {
      "governance.quality-check": async (cmd) => {
        seen.push(cmd);
        await gate; // 执行体还在跑:此刻行必须是 running
        return { tables: 1 };
      },
    };
    const out = await dispatchCommand("0001-aaaa", handlers);
    expect(out.kind).toBe("accepted");
    // 同步部分已抢单:此刻是 running
    expect(store.get("0001-aaaa")!.status).toBe("running");
    expect(store.get("0001-aaaa")!.startedAt).toBeTruthy();
    release();
    if (out.kind === "accepted") await out.execution;
    const row = store.get("0001-aaaa")!;
    expect(row.status).toBe("succeeded");
    expect(row.summary).toEqual({ tables: 1 });
    expect(row.finishedAt).toBeTruthy();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ targetId: "tgt_usw2_a", projectId: "proj-default", taskId: "gov_01TEST", params: { fqns: ["bgp-redshift.dev.public.orders"] } });
  });

  it("② 执行体抛错 ⇒ failed + 真因(不许停在 running)", async () => {
    seed();
    const out = await dispatchCommand("0001-aaaa", {
      "governance.quality-check": async () => {
        throw new Error("该表暂无启用的质量规则");
      },
    });
    if (out.kind === "accepted") await out.execution;
    const row = store.get("0001-aaaa")!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("该表暂无启用的质量规则");
  });

  it("③ 重复投递只执行一次:并发两次 dispatch,恰好一个 accepted,另一个 not-pending", async () => {
    seed();
    let calls = 0;
    const handlers: ActionHandlers = { "governance.quality-check": async () => ({ n: ++calls }) };
    const [a, b] = await Promise.all([dispatchCommand("0001-aaaa", handlers), dispatchCommand("0001-aaaa", handlers)]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["accepted", "not-pending"]);
    for (const o of [a, b]) if (o.kind === "accepted") await o.execution;
    expect(calls).toBe(1);
    // 已终态再来一次:not-pending,执行体不再被调
    const c = await dispatchCommand("0001-aaaa", handlers);
    expect(c.kind).toBe("not-pending");
    expect(calls).toBe(1);
  });

  it("④ 非法命令当场判 failed,执行体一次都不调", async () => {
    const handler = vi.fn(async () => ({}));
    const handlers: ActionHandlers = { "governance.quality-check": handler, "admin.delete-everything": handler };
    // 白名单外
    seed({ commandId: "c-bad-action", action: "admin.delete-everything" });
    // 缺项目
    seed({ commandId: "c-no-project", projectId: undefined });
    // 空参数(空清单跑起来就是「成功地什么都没检查」)
    seed({ commandId: "c-empty", params: { fqns: [] } });
    for (const id of ["c-bad-action", "c-no-project", "c-empty"]) {
      const out = await dispatchCommand(id, handlers);
      expect(out.kind, id).toBe("rejected");
      expect(store.get(id)!.status, id).toBe("failed");
      expect(String(store.get(id)!.error || ""), id).not.toBe("");
    }
    expect(handler).not.toHaveBeenCalled();
    expect((await dispatchCommand("nope", handlers)).kind).toBe("missing");
  });

  it("④b 白名单里有、但部署里没有执行体 ⇒ failed(不许当成功)", async () => {
    seed();
    const out = await dispatchCommand("0001-aaaa", {});
    if (out.kind === "accepted") await out.execution;
    expect(store.get("0001-aaaa")!.status).toBe("failed");
    expect(store.get("0001-aaaa")!.error).toMatch(/没有执行体/);
  });

  it("⑤ 终态只能从 running 写:pending / 已终态的行不会被覆盖", async () => {
    seed({ commandId: "c-pending" });
    expect(await finishCommand("c-pending", { status: "succeeded", summary: {} })).toBe(false);
    expect(store.get("c-pending")!.status).toBe("pending");
    seed({ commandId: "c-done", status: "failed", error: "原因 A" });
    expect(await finishCommand("c-done", { status: "succeeded", summary: {} })).toBe(false);
    expect(store.get("c-done")!.status).toBe("failed");
    expect(store.get("c-done")!.error).toBe("原因 A");
  });

  it("⑥ 白名单 ↔ 执行体一一对应(多一个少一个都红)", () => {
    expect(Object.keys(ACTION_HANDLERS).sort()).toEqual(DISPATCHABLE_ACTIONS.map((a) => a.id).sort());
  });
});
