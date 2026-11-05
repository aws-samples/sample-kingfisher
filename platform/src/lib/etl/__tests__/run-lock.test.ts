// 根治·裂缝C 的作业级运行锁单测。验证条件写抢锁/lease/释放/token 匹配语义(mock docClient)。
import { describe, it, expect, vi, beforeEach } from "vitest";

// mock docClient.send:模拟 DynamoDB 条件写。泛化后 run-lock 用占位名 #t(token属性)/#e(过期属性),
// 真实属性名在 ExpressionAttributeNames 里(如 runLockToken / runLock_nodeAToken)。mock 按占位名解析真实属性。
// store 行是 {属性名: 值} 的字典(支持任意锁属性名 → 覆盖 workflow 不同节点的 runLock_<node>Token)。
const store: Record<string, Record<string, any>> = {};
// 2026-11-04:标成「行不存在」的键 —— 抢锁条件带 attribute_exists(#pk) 时对它条件不满足(模拟作业行已删)
const missingRows = new Set<string>();

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

      // 2026-11-04:条件写被拒时 DDB 按 ReturnValuesOnConditionCheckFailure=ALL_OLD 带回旧行(行不存在 ⇒ 不带)—— mock 同形
      const ccf = (msg: string) => {
        const e = new ConditionalCheckFailedException(msg) as ConditionalCheckFailedException & { Item?: Record<string, any> };
        if (input.ReturnValuesOnConditionCheckFailure === "ALL_OLD" && !missingRows.has(rowKey)) e.Item = { ...row, userId: "default-user" };
        return e;
      };
      // 读行(lockRowPresence 的确认步):行不存在 ⇒ Item 缺
      if (cmd.constructor.name === "GetCommand" || input.ProjectionExpression) {
        return missingRows.has(rowKey) ? { Item: undefined } : { Item: { userId: "default-user" } };
      }
      // 抢锁:SET #t=:tok, #e=:exp  条件 attribute_not_exists(#t) OR #e < :now
      if (ue.startsWith("SET #t")) {
        if (cond.includes("attribute_exists(#pk)") && missingRows.has(rowKey)) throw ccf("row missing");
        const free = row[tokenAttr] === undefined;
        const expired = row[expAttr] !== undefined && now !== undefined && row[expAttr] < now;
        if (cond && !(free || expired)) throw ccf("locked");
        row[tokenAttr] = vals[":tok"];
        row[expAttr] = vals[":exp"];
        return {};
      }
      // 🆕 续租:SET #e = :exp  条件 #t = :tok(P0-6)。必须在"抢锁"分支之后判,
      // 且不能被 `SET #t` 前缀匹配吞掉 —— 否则 mock 会静默"成功"、测不出条件语义。
      if (ue.startsWith("SET #e")) {
        if (cond && (missingRows.has(rowKey) || row[tokenAttr] !== vals[":tok"])) throw ccf("token mismatch");
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
  renewRunLockIfDue, renewRunLockIfDueDetailed, keepRunLockForReconcile, runLockRecentlyRenewed, runLockLiveCutoff, heldJobRunLocks,
  jobLockAttrsOf, noLiveJobLockCondition, lockRowPresence, JobRowMissing, RUN_LOCK_LEASE_MS, RUN_LOCK_LIVE_WINDOW_MS } from "../run-lock";
import { docClient } from "@/lib/aws/dynamodb";

const T = "bgp-etl-jobs";
const K = (jobId: string) => ({ userId: "default-user", jobId });

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  missingRows.clear();
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


// ── 2026-11-04:锁只许落在存在的作业行上;从作业行反读「谁还持着锁、是不是刚续租」 ──────────────
describe("2026-11-04 作业行锁的存在性条件 + 反读", () => {
  const lastAcquire = () => {
    const calls = (docClient.send as unknown as { mock: { calls: Array<[{ input: any }]> } }).mock.calls;
    return calls.map((c) => c[0].input).filter((i) => String(i.UpdateExpression) === "SET #t = :tok, #e = :exp").at(-1)!;
  };

  it("acquireJobRunLock(作业行锁):条件带 attribute_exists(#pk)(#pk = userId)+ ReturnValuesOnConditionCheckFailure;作业行不存在 ⇒ 抛 JobRowMissing(S4:不是 RunLockBusy、不排队)且**不写任何属性**(不造幽灵行)", async () => {
    missingRows.add(`${T}#job-gone`);
    await expect(acquireJobRunLock(T, "job-gone", 0, "tgt_usw2_a")).rejects.toBeInstanceOf(JobRowMissing);
    await expect(acquireJobRunLock(T, "job-gone", 0, "tgt_usw2_a")).rejects.toThrow("作业已被删除,无法运行(作业行不存在)");
    expect(lastAcquire().ConditionExpression).toBe("attribute_exists(#pk) AND (attribute_not_exists(#t) OR #e < :now)");
    expect(lastAcquire().ExpressionAttributeNames).toEqual({ "#t": "runLock-tgt_usw2_aToken", "#e": "runLock-tgt_usw2_aExpiresAt", "#pk": "userId" });
    expect(lastAcquire().ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD");
    expect(store[`${T}#job-gone`]).toEqual({});
    // 排队语义(补数 / 定时 waitMs>0)也当场抛,不再等 45–60 分钟
    await expect(acquireJobRunLock(T, "job-gone", 60 * 60 * 1000, "tgt_usw2_a")).rejects.toBeInstanceOf(JobRowMissing);
    // 行存在 ⇒ 与原来逐字节同样抢到;被占 ⇒ 仍是 null(忙),不是 JobRowMissing
    const ok = await acquireJobRunLock(T, "job-here", 0, "tgt_usw2_a");
    expect(ok).not.toBeNull();
    expect(store[`${T}#job-here`]["runLock-tgt_usw2_aToken"]).toBe(ok!.token);
    expect(await acquireJobRunLock(T, "job-here", 0, "tgt_usw2_a")).toBeNull();
  });

  it("续租失败三分(S3 / S5):行在、token 不是我的 ⇒ lost-taken-over;行已删 ⇒ lost-row-gone(DDB 没带回旧行 + 读行确认);布尔版两者都是 false", async () => {
    const taken = (await acquireJobRunLock(T, "j-taken", 0))!;
    store[`${T}#j-taken`].runLockToken = "someone-else";
    expect(await renewRunLockIfDueDetailed(taken)).toBe("lost-taken-over");
    expect(await renewRunLockIfDue({ ...taken, token: taken.token + "x" })).toBe(false);
    const gone = (await acquireJobRunLock(T, "j-gone-later", 0))!;
    missingRows.add(`${T}#j-gone-later`);
    expect(await renewRunLockIfDueDetailed(gone)).toBe("lost-row-gone");
    expect(await lockRowPresence(T, K("j-gone-later"))).toBe("absent");
    expect(await lockRowPresence(T, K("j-taken"))).toBe("present");
    expect(await renewRunLockIfDueDetailed(null)).toBe("ok");
  });

  it("noLiveJobLockCondition / jobLockAttrsOf:home + 绑定区 + 行上残留的作业级锁属性,每把都「不存在 或 ExpiresAt < 刚续租下界」;与 runLockRecentlyRenewed 同一个数", () => {
    const now = 1_800_000_000_000;
    const row = { "runLock-tgt_eu1Token": "x", "runLock-tgt_eu1ExpiresAt": now + 1, runLock_nodeAToken: "n", name: "j" };
    expect(jobLockAttrsOf(row, ["tgt_home", "tgt_usw2_a"])).toEqual(["runLock", "runLock-tgt_eu1", "runLock-tgt_usw2_a"]);
    const cond = noLiveJobLockCondition(row, ["tgt_usw2_a"], now);
    expect(cond.ConditionExpression).toBe(
      "(attribute_not_exists(#lk0) OR #le0 < :liveCutoff) AND (attribute_not_exists(#lk1) OR #le1 < :liveCutoff) AND (attribute_not_exists(#lk2) OR #le2 < :liveCutoff)"
    );
    expect(cond.ExpressionAttributeNames).toEqual({
      "#lk0": "runLockToken", "#le0": "runLockExpiresAt",
      "#lk1": "runLock-tgt_eu1Token", "#le1": "runLock-tgt_eu1ExpiresAt",
      "#lk2": "runLock-tgt_usw2_aToken", "#le2": "runLock-tgt_usw2_aExpiresAt",
    });
    expect(cond.ExpressionAttributeValues).toEqual({ ":liveCutoff": runLockLiveCutoff(now) });
    expect(runLockLiveCutoff(now)).toBe(now + RUN_LOCK_LEASE_MS - RUN_LOCK_LIVE_WINDOW_MS);
    // 同一个数:内存判据 ⇔ ExpiresAt > cutoff
    expect(runLockRecentlyRenewed(runLockLiveCutoff(now) + 1, now)).toBe(true);
    expect(runLockRecentlyRenewed(runLockLiveCutoff(now), now)).toBe(false);
  });

  it("泛化 tryAcquireRunLock 不开 requireRowExists ⇒ 条件串逐字不变(工作流节点锁 / MWAA Python 镜像的口径不动)", async () => {
    missingRows.add(`${T}#wf-gone`);
    const lock = await tryAcquireRunLock(T, K("wf-gone"), "runLock_nodeA");
    expect(lock).not.toBeNull();
    expect(lastAcquire().ConditionExpression).toBe("attribute_not_exists(#t) OR #e < :now");
    expect(lastAcquire().ExpressionAttributeNames).toEqual({ "#t": "runLock_nodeAToken", "#e": "runLock_nodeAExpiresAt" });
  });

  it("runLockRecentlyRenewed:刚抢 / 一个续租间隔前续过 ⇒ true;两个间隔没人续 ⇒ false;lease 已过期 / 非数 ⇒ false", () => {
    const now = 1_800_000_000_000;
    expect(runLockRecentlyRenewed(now + RUN_LOCK_LEASE_MS, now)).toBe(true);
    expect(runLockRecentlyRenewed(now + RUN_LOCK_LEASE_MS - 60_000, now)).toBe(true);
    expect(runLockRecentlyRenewed(now + RUN_LOCK_LEASE_MS - RUN_LOCK_LIVE_WINDOW_MS + 1, now)).toBe(true);
    expect(runLockRecentlyRenewed(now + RUN_LOCK_LEASE_MS - RUN_LOCK_LIVE_WINDOW_MS, now)).toBe(false);
    expect(runLockRecentlyRenewed(now - 1, now)).toBe(false);
    expect(runLockRecentlyRenewed(undefined, now)).toBe(false);
    expect(runLockRecentlyRenewed("abc", now)).toBe(false);
    expect(RUN_LOCK_LIVE_WINDOW_MS).toBe(120_000);
    expect(RUN_LOCK_LEASE_MS).toBe(90 * 60 * 1000);
  });

  it("heldJobRunLocks:home 锁 ⇒ tgt_home;runLock-<target> ⇒ 反解 target;过期 / 工作流节点锁 / 没 token 的不算;真抢到的锁反读得到自己", async () => {
    const now = 1_800_000_000_000;
    const row = {
      runLockToken: "a", runLockExpiresAt: now + RUN_LOCK_LEASE_MS,
      "runLock-tgt_usw2_aToken": "b", "runLock-tgt_usw2_aExpiresAt": now + RUN_LOCK_LEASE_MS - 5 * 60_000,
      "runLock-tgt_eu1Token": "c", "runLock-tgt_eu1ExpiresAt": now - 1,
      "runLock_nodeAToken": "d", "runLock_nodeAExpiresAt": now + RUN_LOCK_LEASE_MS,
      "runLock-tgt_apsToken": "e", // 没有 ExpiresAt ⇒ 不算
      name: "x",
    };
    expect(heldJobRunLocks(row, now)).toEqual([
      { attr: "runLock", targetId: "tgt_home", expiresAt: now + RUN_LOCK_LEASE_MS, renewedAgoMs: 0, recentlyRenewed: true },
      { attr: "runLock-tgt_usw2_a", targetId: "tgt_usw2_a", expiresAt: now + RUN_LOCK_LEASE_MS - 5 * 60_000, renewedAgoMs: 5 * 60_000, recentlyRenewed: false },
    ]);
    expect(heldJobRunLocks(null)).toEqual([]);
    const lock = (await acquireJobRunLock(T, "job-rt", 0, "tgt_usw2_a"))!;
    const held = heldJobRunLocks(store[`${T}#job-rt`]);
    expect(held.map((l) => [l.attr, l.targetId, l.recentlyRenewed])).toEqual([["runLock-tgt_usw2_a", "tgt_usw2_a", true]]);
    await releaseRunLock(lock);
    expect(heldJobRunLocks(store[`${T}#job-rt`])).toEqual([]);
  });
});
