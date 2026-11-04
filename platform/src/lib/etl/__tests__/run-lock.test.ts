// 根治·裂缝C 的作业级运行锁单测。验证条件写抢锁/lease/释放/token 匹配语义(mock docClient)。
import { describe, it, expect, vi, beforeEach } from "vitest";

// mock docClient.send:模拟 DynamoDB 条件写。泛化后 run-lock 用占位名 #t(token属性)/#e(过期属性),
// 真实属性名在 ExpressionAttributeNames 里(如 runLockToken / runLock_nodeAToken)。mock 按占位名解析真实属性。
// store 行是 {属性名: 值} 的字典(支持任意锁属性名 → 覆盖 workflow 不同节点的 runLock_<node>Token)。
const store: Record<string, Record<string, any>> = {};

class ConditionalCheckFailedException extends Error {
  name = "ConditionalCheckFailedException";
}

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { ETL_JOBS: "bgp-etl-jobs", ENGINE_JOBS: "bgp-engine-jobs", WORKFLOWS: "bgp-workflows" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const input = cmd.input || cmd;
      const keyId = input.Key.jobId ?? input.Key.workflowId;
      const rowKey = `${input.TableName}#${keyId}`;
      const row = store[rowKey] || (store[rowKey] = {});
      const vals = input.ExpressionAttributeValues || {};
      const names = input.ExpressionAttributeNames || {};
      const cond = input.ConditionExpression || "";
      const now = vals[":now"];
      const tokenAttr = names["#t"]; // 真实 token 属性名(如 runLockToken)
      const expAttr = names["#e"];   // 真实过期属性名(如 runLockExpiresAt)
      const ue = input.UpdateExpression || "";

      // 抢锁:SET #t=:tok, #e=:exp  条件 attribute_not_exists(#t) OR #e < :now
      if (ue.startsWith("SET #t")) {
        const free = row[tokenAttr] === undefined;
        const expired = row[expAttr] !== undefined && now !== undefined && row[expAttr] < now;
        if (cond && !(free || expired)) throw new ConditionalCheckFailedException("locked");
        row[tokenAttr] = vals[":tok"];
        row[expAttr] = vals[":exp"];
        return {};
      }
      // 🆕 续租:SET #e = :exp  条件 #t = :tok(P0-6)。必须在"抢锁"分支之后判,
      // 且不能被 `SET #t` 前缀匹配吞掉 —— 否则 mock 会静默"成功"、测不出条件语义。
      if (ue.startsWith("SET #e")) {
        if (cond && row[tokenAttr] !== vals[":tok"]) throw new ConditionalCheckFailedException("token mismatch");
        row[expAttr] = vals[":exp"];
        return {};
      }
      // 释放:REMOVE #t, #e  条件 #t = :tok
      if (ue.startsWith("REMOVE #t")) {
        if (cond && row[tokenAttr] !== vals[":tok"]) throw new ConditionalCheckFailedException("token mismatch");
        delete row[tokenAttr];
        delete row[expAttr];
        return {};
      }
      return {};
    }),
  },
}));

import { tryAcquireRunLock, acquireRunLock, releaseRunLock, acquireJobRunLock, releaseJobRunLock,
  renewRunLockIfDue, keepRunLockForReconcile } from "../run-lock";

const T = "bgp-etl-jobs";
const K = (jobId: string) => ({ userId: "default-user", jobId });

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe("run-lock 运行锁(根治裂缝C)", () => {
  it("空闲实体:抢锁成功,返回 token", async () => {
    const lock = await tryAcquireRunLock(T, K("job1"));
    expect(lock).not.toBeNull();
    expect(lock!.key.jobId).toBe("job1");
    expect(lock!.table).toBe(T);
    expect(typeof lock!.token).toBe("string");
  });

  it("已被占用(lease 未过期):第二次抢锁返回 null(串行化的核心)", async () => {
    const first = await tryAcquireRunLock(T, K("job2"));
    expect(first).not.toBeNull();
    const second = await tryAcquireRunLock(T, K("job2"));
    expect(second).toBeNull(); // 同实体并发第二个 run 拿不到锁 → 不会并发写同表
  });

  it("释放后可再抢(正常串行:前一个跑完→后一个接上)", async () => {
    const first = await tryAcquireRunLock(T, K("job3"));
    await releaseRunLock(first);
    const second = await tryAcquireRunLock(T, K("job3"));
    expect(second).not.toBeNull(); // 释放后后续 run 能接上
  });

  it("lease 过期(僵尸锁)可被抢占:进程崩溃/轮询丢失兜底", async () => {
    // 手动把 job4 的 lease 设为已过期(模拟持锁进程崩溃,锁未释放)。默认 attr="runLock" → runLockToken/ExpiresAt。
    store[`${T}#job4`] = { runLockToken: "stale-token", runLockExpiresAt: 1 };
    const lock = await tryAcquireRunLock(T, K("job4"));
    expect(lock).not.toBeNull(); // lease 过期 → 可抢占,不会永久卡死
    expect(lock!.token).not.toBe("stale-token");
  });

  it("释放 token 不匹配:不误释放别人续上的锁", async () => {
    const real = await tryAcquireRunLock(T, K("job5"));
    // 用一个假 lock(token 不同)去释放 → 条件写失败,真锁仍在
    await releaseRunLock({ table: T, key: K("job5"), attr: "runLock", token: "fake-token" });
    const stolen = await tryAcquireRunLock(T, K("job5"));
    expect(stolen).toBeNull(); // 真锁未被误释放,仍占用
    await releaseRunLock(real); // 用真 lock 释放才生效
    const after = await tryAcquireRunLock(T, K("job5"));
    expect(after).not.toBeNull();
  });

  it("不同 attr(如 workflow 不同节点)互不干扰:同实体行不同锁属性可各自持有", async () => {
    const nodeA = await tryAcquireRunLock(T, K("wf1"), "runLock_nodeA");
    const nodeB = await tryAcquireRunLock(T, K("wf1"), "runLock_nodeB");
    expect(nodeA).not.toBeNull();
    expect(nodeB).not.toBeNull(); // 同 workflow 不同节点 → 不同锁属性 → 都能持有(并行)
    const nodeA2 = await tryAcquireRunLock(T, K("wf1"), "runLock_nodeA");
    expect(nodeA2).toBeNull(); // 但同节点第二次仍拿不到(串行)
  });

  it("releaseRunLock(null) 安全无操作(手动 run 抢锁失败时 lock=null)", async () => {
    await expect(releaseRunLock(null)).resolves.toBeUndefined();
    await expect(releaseRunLock(undefined)).resolves.toBeUndefined();
  });

  it("便捷包装 acquireJobRunLock waitMs=0:占用时立即返回 null(手动 run 不排队,快速失败)", async () => {
    await acquireJobRunLock(T, "job6"); // 先占锁(默认 waitMs=0)
    const lock = await acquireJobRunLock(T, "job6", 0);
    expect(lock).toBeNull(); // 不等待,立即失败
    await releaseJobRunLock(lock); // null 安全
  });
});


// ── P0-6(2026-08-29 外部审核):严格互斥此前不成立 ──────────────────────────────
//
// 原缺陷:4 个轮询循环在 `finally` 里**无条件释放**锁,无论是"到达终态"还是"轮询轮次跑完"。
// 而轮询窗口(Redshift≈4min / Glue≈40min / EMR≈60min / backfill≈5min)远短于作业可能的时长
// ⇒ 后端还在跑就放锁,第二个 run 进来 DROP+CTAS 同一张表 = 裂缝C 的 OID 事故复现。
// 这组测试把新语义钉死,防后人"为了不等 lease"再把它改回去。
describe("P0-6 续租 + 轮询耗尽不释放", () => {
  it("续租延长 lease,且不改变持有者", async () => {
    const lock = (await tryAcquireRunLock(T, K("j-renew")))!;
    const row = store[`${T}#j-renew`];
    const before = row.runLockExpiresAt;
    // 把 lease 手动往回拨,模拟"快过期",再续租应把它顶回未来
    row.runLockExpiresAt = Date.now() + 1000;
    const ok = await renewRunLockIfDue(lock);
    expect(ok).toBe(true);
    expect(row.runLockExpiresAt).toBeGreaterThan(Date.now() + 60_000);
    expect(row.runLockToken).toBe(lock.token); // 持有者不变
    expect(before).toBeGreaterThan(0);
  });

  it("🔴 锁已被他人抢走时,续租返回 false(调用方据此停止回写终态)", async () => {
    const lock = (await tryAcquireRunLock(T, K("j-lost")))!;
    // 模拟 lease 曾过期、被另一个 run 抢走:token 变成别人的
    store[`${T}#j-lost`].runLockToken = "someone-else";
    const ok = await renewRunLockIfDue(lock);
    expect(ok).toBe(false);
  });

  it("🔴🔴 轮询耗尽调 keepRunLockForReconcile:锁必须【仍然存在】(绝不释放)", async () => {
    const lock = (await tryAcquireRunLock(T, K("j-keep")))!;
    const row = store[`${T}#j-keep`];
    await keepRunLockForReconcile(lock, { jobId: "j-keep", runId: "r1", engine: "glue" });
    // 关键断言:token 还在 ⇒ 第二个 run 抢不到 ⇒ 不会与仍在跑的后端并发
    expect(row.runLockToken).toBe(lock.token);
    const second = await tryAcquireRunLock(T, K("j-keep"));
    expect(second).toBeNull();
  });

  it("对照:确认终态才释放 —— release 后第二个 run 立刻可抢", async () => {
    const lock = (await tryAcquireRunLock(T, K("j-done")))!;
    await releaseRunLock(lock);
    const second = await tryAcquireRunLock(T, K("j-done"));
    expect(second).not.toBeNull();
  });
});
