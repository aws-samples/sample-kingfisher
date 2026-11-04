// 会话卡片「中央指针 + 配额」的单测。🔴 mock **真的实现** ConditionExpression 语义(照 run-lock.test.ts 的先例)——
// 只断「命令形状对不对」的测试挡不住「先 Count 再 Put」那种退化:形状看着一样,并发下写出 101。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";

// 🔴 注入钩子必须走 vi.hoisted:`docClient.send` 本身就是 vi.fn,`vi.spyOn` 会返回**同一个** mock
//    ⇒ 「先存原实现再 mockImplementation 里回调它」会无限递归(上一版实测 RangeError)。
const hooks = vi.hoisted(() => ({
  failTransactReasons: null as null | { Code: string }[],
  /** 🔴 **持续**注入争抢(一次性的那个不够:要验「一直撞 ⇒ 有界」)。 */
  failTransactAlways: null as null | { Code: string }[],
  /** 事务发了几次 —— 「恰好重试 N 次」这条判据的真值源。 */
  transactCalls: 0,
}));

const T = "bgp-genbi-cards";
/** 内存 DDB:key = `${pk}|${sk}` */
const store = new Map<string, Record<string, any>>();
const k = (pk: string, sk: string) => `${pk}|${sk}`;

/** 求值一条 ConditionExpression(只支持本模块真正用到的那几种形态;不认识的形态**抛**,不许静默放行)。 */
function condOk(cond: string, row: Record<string, any> | undefined, names: Record<string, string>, vals: Record<string, any>): boolean {
  const c = cond.trim();
  if (!c) return true;
  if (c === "attribute_not_exists(pk)") return row === undefined;
  if (c === "attribute_not_exists(#n) OR #n < :limit") {
    const n = row?.[names["#n"]];
    return n === undefined || n < vals[":limit"];
  }
  if (c === "#n > :zero") {
    const n = row?.[names["#n"]];
    return typeof n === "number" && n > vals[":zero"];
  }
  if (c === "attribute_exists(pk) AND #st = :ready") {
    return row !== undefined && row[names["#st"]] === vals[":ready"];
  }
  throw new Error(`mock 不认识这条 ConditionExpression:${c}(请把它的语义补进 mock,别让它静默放行)`);
}

function applyUpdate(row: Record<string, any>, ue: string, names: Record<string, string>, vals: Record<string, any>) {
  for (const m of ue.matchAll(/ADD\s+(#?\w+)\s+(:\w+)/g)) {
    const attr = names[m[1]] ?? m[1];
    row[attr] = (typeof row[attr] === "number" ? row[attr] : 0) + vals[m[2]];
  }
  const setPart = ue.startsWith("SET ") ? ue.slice(4) : "";
  if (setPart) {
    for (const assign of setPart.split(",")) {
      const [lhs, rhs] = assign.split("=").map((x) => x.trim());
      if (!lhs || !rhs) continue;
      row[names[lhs] ?? lhs] = vals[rhs];
    }
  }
}

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { GENBI_CARDS: "bgp-genbi-cards" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const i = cmd.input;
      // ── TransactWrite:先全评条件,任一不过就整体取消(与真实语义一致)──
      if (i.TransactItems) {
        hooks.transactCalls += 1;
        if (hooks.failTransactAlways) {
          const e = new TransactionCanceledException({ $metadata: {}, message: "cancelled(always)" });
          (e as any).CancellationReasons = hooks.failTransactAlways;
          throw e;
        }
        if (hooks.failTransactReasons) {
          const injected = hooks.failTransactReasons;
          hooks.failTransactReasons = null;
          const e = new TransactionCanceledException({ $metadata: {}, message: "cancelled(injected)" });
          (e as any).CancellationReasons = injected;
          throw e;
        }
        const reasons: { Code: string }[] = [];
        let failed = false;
        for (const it of i.TransactItems) {
          const spec = it.Put ?? it.Update;
          const key = it.Put ? { pk: spec.Item.pk, sk: spec.Item.sk } : spec.Key;
          const row = store.get(k(key.pk, key.sk));
          const ok = condOk(spec.ConditionExpression || "", row, spec.ExpressionAttributeNames || {}, spec.ExpressionAttributeValues || {});
          reasons.push({ Code: ok ? "None" : "ConditionalCheckFailed" });
          if (!ok) failed = true;
        }
        if (failed) {
          const e = new TransactionCanceledException({ $metadata: {}, message: "cancelled" });
          (e as any).CancellationReasons = reasons;
          throw e;
        }
        for (const it of i.TransactItems) {
          if (it.Put) { store.set(k(it.Put.Item.pk, it.Put.Item.sk), { ...it.Put.Item }); continue; }
          const u = it.Update;
          const key = k(u.Key.pk, u.Key.sk);
          const row = store.get(key) ?? { ...u.Key };
          applyUpdate(row, u.UpdateExpression, u.ExpressionAttributeNames || {}, u.ExpressionAttributeValues || {});
          store.set(key, row);
        }
        return {};
      }
      // ── 单项 Update(幂等更新路径)──
      if (i.UpdateExpression) {
        const key = k(i.Key.pk, i.Key.sk);
        const row = store.get(key);
        if (!condOk(i.ConditionExpression || "", row, i.ExpressionAttributeNames || {}, i.ExpressionAttributeValues || {})) {
          const e = new Error("ConditionalCheckFailedException");
          e.name = "ConditionalCheckFailedException";
          throw e;
        }
        const r = row ?? { ...i.Key };
        applyUpdate(r, i.UpdateExpression, i.ExpressionAttributeNames || {}, i.ExpressionAttributeValues || {});
        store.set(key, r);
        return {};
      }
      if (i.Item) { store.set(k(i.Item.pk, i.Item.sk), { ...i.Item }); return {}; }
      if (i.Key && !i.KeyConditionExpression) {
        if (cmd.constructor.name.includes("Delete")) { store.delete(k(i.Key.pk, i.Key.sk)); return {}; }
        return { Item: store.get(k(i.Key.pk, i.Key.sk)) };
      }
      // ── Query:基表 begins_with(sk) / GSI byConversation ──
      if (i.KeyConditionExpression) {
        const u = i.ExpressionAttributeValues[":u"];
        const rows = Array.from(store.values()).filter((r) => r.pk === u);
        if (i.IndexName === "byConversation") {
          const c = i.ExpressionAttributeValues[":c"];
          return { Items: rows.filter((r) => r.conversationId === c) };
        }
        const p = i.ExpressionAttributeValues[":p"];
        return { Items: rows.filter((r) => String(r.sk).startsWith(p)) };
      }
      throw new Error(`mock 不认识这个命令:${JSON.stringify(i).slice(0, 120)}`);
    }),
  },
}));

import {
  CARD_LIMIT, MAX_TURNS, MAX_BODY_BYTES, CardQuotaExceeded, CardInputInvalid,
  assertNoDataValues, saveCardPointer, readQuota, listCardPointers, releaseCardQuota,
  deleteCardPointer, getCardPointer, findCardByConversation, reconcileQuota,
  CardStoreContended,
  CONTENTION_MAX_ATTEMPTS,
  isRetryableTransactionConflict,
} from "../cards-store";

const USER = "sub-abc";
// 🔴 `cardId` 是**必填**入参(2026-09-13 的 P0:store 原来自己 ulid() 了第二个 id)。
//    夹具刻意让 `bodyRef.key` 里的那一段与 `cardId` 一致 —— 真实调用方就是这么拼的。
/** 每段对话一个不同的 cardId(真实调用方就是一张卡一个 id;共用一个会撞主键)。 */
const cardIdFor = (conv: string) => `01M2CARD${conv.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}`;
const base = (conv: string, cardId?: string) => ({
  cardId: cardId ?? cardIdFor(conv),
  conversationId: conv, targetId: "tgt_use1_a", region: "us-east-1", projectId: "proj-default",
  engine: "redshift", turnCount: 3, bytes: 4096,
  bodyRef: { bucket: "bgp-datalake-000000000000-tgt-use1-a", key: `genbi-cards/${USER}/${cardId ?? cardIdFor(conv)}/body.json` },
  bodySha256: "deadbeef",
});

beforeEach(() => {
  store.clear();
  hooks.failTransactReasons = null;
  hooks.failTransactAlways = null;
  hooks.transactCalls = 0;
});

describe("54 会话卡片 · 中央指针 + 配额(单一作者)", () => {
  // ── 🔴🔴 2026-09-13:并发争抢被当成故障甩给用户(真环境 100 次里 3 次 500)──
  // `TransactionConflict` 是 DynamoDB 说「你重试就行」;而配额是**按人的单个 item**,
  // 同一个人并发保存必然撞它。改动前它掉进 500「保存卡片失败,请稍后重试」——
  // 平台把自己该做的重试推给了点保存的人。
  describe("🔴 争抢由平台吸收,确定性结论不许重试", () => {
    /** 造一个 TransactionCanceledException,`codes` 是逐项取消原因。 */
    function cancelled(codes: Array<string | undefined>) {
      const e = new TransactionCanceledException({ $metadata: {}, message: "cancelled" });
      (e as any).CancellationReasons = codes.map((c) => (c ? { Code: c } : { Code: "None" }));
      return e;
    }

    it("判别:只含 TransactionConflict ⇒ 可重试;掺了 ConditionalCheckFailed ⇒ **不可**重试", () => {
      expect(isRetryableTransactionConflict(cancelled([undefined, "TransactionConflict"]))).toBe(true);
      expect(isRetryableTransactionConflict(cancelled(["TransactionConflict", "TransactionConflict"]))).toBe(true);
      // 🔴 满额 / 撞 id 是**答案**,重试它只会把「满了」拖成「超时」
      expect(isRetryableTransactionConflict(cancelled([undefined, "ConditionalCheckFailed"]))).toBe(false);
      expect(isRetryableTransactionConflict(cancelled(["ConditionalCheckFailed", "TransactionConflict"]))).toBe(false);
      expect(isRetryableTransactionConflict(new Error("boom"))).toBe(false);
    });

    it("🔴 争抢一次 ⇒ 自动重试后**成功**(用户看不到任何错误)", async () => {
      hooks.failTransactReasons = [{ Code: "None" }, { Code: "TransactionConflict" }];
      const r = await saveCardPointer(USER, base("c-retry"));
      expect(r.created).toBe(true);
      expect(hooks.transactCalls, "没有真的重试过(只发了一次事务)").toBeGreaterThan(1);
      expect(await readQuota(USER), "重试成功后计数器必须恰好 +1(不是 +2)").toBe(1);
    });

    it("🔴 一直争抢 ⇒ 有界(用完预算抛 CardStoreContended,**不是**无限重试、也不是 500)", async () => {
      hooks.failTransactAlways = [{ Code: "None" }, { Code: "TransactionConflict" }];
      await expect(saveCardPointer(USER, base("c-busy"))).rejects.toBeInstanceOf(CardStoreContended);
      expect(hooks.transactCalls, "重试次数必须恰好等于预算(既不少试也不无限试)").toBe(CONTENTION_MAX_ATTEMPTS);
    });

    // ══════════════════════════════════════════════════════════════════════
    // 🔴🔴 2026-09-21 第五轮全量硬门 **GC-3a 实测红**:8 路并发造满 100 张时冒出一个 **503**
    //   (配额本身精确到 100/100、第 101 次 409 —— 正确性是对的,坏的是「平台没把瞬态争抢吸收干净」)。
    //   根因两处,而**第二处才是要命的**:预算是拍出来的 `6` 次(总退避 ~1.2s);
    //   而退避是「指数点 ±50%」⇒ 并发写者的重试落在几乎同一个窗口、继续互撞(thundering herd),
    //   光加次数治不了它。⇒ full jitter + 由最坏并发**推导**预算。
    // ⇒ 这两条判据钉的是**形状**,因为这类缺陷只在尾部概率性出现,行为判据抓不稳:
    //   ① 预算必须是推导出来的(改 CARD_LIMIT 它要跟着动,而不是留在 6);
    //   ② 退避必须是 full jitter(源码里不许再出现那个相关抖动的形状)。
    // ══════════════════════════════════════════════════════════════════════
    it("🔴 预算由**最坏并发**推导,不是字面量(改 CARD_LIMIT 它必须跟着动)", async () => {
      const { CONTENTION_BUDGET_MS, CARD_LIMIT: LIMIT } = await import("@/lib/genbi/cards-store");
      // 预算 = 最坏并发(= 一个人最多几张卡)× 单次事务耗时上限 ⇒ 与 CARD_LIMIT 成正比
      expect(CONTENTION_BUDGET_MS % LIMIT, "预算不是按 CARD_LIMIT 推导的(它被拍成了一个常数?)").toBe(0);
      expect(CONTENTION_BUDGET_MS).toBeGreaterThanOrEqual(LIMIT * 10);
      // 次数必须足以在**悲观侧**(full jitter 期望 = 上限一半)撑过预算
      let acc = 0;
      for (let n = 0; n < CONTENTION_MAX_ATTEMPTS - 1; n++) acc += Math.min(40 * 2 ** n, 800) / 2;
      expect(acc, `重试次数 ${CONTENTION_MAX_ATTEMPTS} 撑不过预算 ${CONTENTION_BUDGET_MS}ms`).toBeGreaterThanOrEqual(
        CONTENTION_BUDGET_MS
      );
      // 🔴 有界:绝不许被改成无限重试(那是「请求挂住」,比 503 更坏)
      expect(Number.isFinite(CONTENTION_MAX_ATTEMPTS) && CONTENTION_MAX_ATTEMPTS < 40).toBe(true);
    });

    it("🔴 退避必须是 **full jitter**(源码里不许再出现相关抖动 `0.5 + Math.random()`)", async () => {
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const src = readFileSync(resolve(__dirname, "../cards-store.ts"), "utf8");
      // 🔴 负向文本断言前先剥注释 —— 上面那段注释里**引用了**那个坏形状当反面教材
      const code = src
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
        })
        .map((l) => (l.indexOf("//") >= 0 ? l.slice(0, l.indexOf("//")) : l))
        .join("\n");
      expect(/0\.5\s*\+\s*Math\.random\(\)/.test(code), "退避又变回「指数点 ±50%」⇒ 并发重试继续互撞").toBe(false);
      expect(/Math\.random\(\)\s*\*\s*cap/.test(code), "没看到 full jitter(`Math.random() * cap`)").toBe(true);
    });

    it("🔴 满额仍然是 CardQuotaExceeded(绝不被当成争抢去重试)", async () => {
      hooks.failTransactAlways = [{ Code: "None" }, { Code: "ConditionalCheckFailed" }];
      await expect(saveCardPointer(USER, base("c-full"))).rejects.toBeInstanceOf(CardQuotaExceeded);
      expect(hooks.transactCalls, "🔴 确定性结论被当成争抢重试了(会把「满了」拖成超时)").toBe(1);
    });

    it("🔴 删卡的争抢同样被吸收(一次删多张 / 双击也会撞计数器)", async () => {
      const a = await saveCardPointer(USER, base("c-del"));
      hooks.transactCalls = 0;
      hooks.failTransactReasons = [{ Code: "None" }, { Code: "TransactionConflict" }];
      expect(await releaseCardQuota(USER, a.cardId)).toBe("released");
      expect(hooks.transactCalls).toBeGreaterThan(1);
      expect(await readQuota(USER)).toBe(0);
    });
  });

  // ── 🔴🔴 2026-09-13 P0 的看守:cardId **只能有一个作者** ──
  // 病:`saveCard` 生成一个 ulid() 写**正文 key**,`saveCardPointer` 又 ulid() 了**第二个**写指针
  //    ⇒ 两个 id 永远不同 ⇒ 读正文恒 NoSuchKey ⇒ **每张卡都打不开**。
  // 为什么原来没被逮到:service 的单测 mock 掉了 store、store 的单测只看自己 ⇒ **接缝从没被测过**。
  // ⇒ 这条判据钉的正是那个接缝不变量:**写进去的 cardId == 调用方给的 == 正文 key 里那一段**。
  it("🔴 saveCardPointer 绝不自己生成 cardId:写入的 id == 入参 == bodyRef.key 里那一段", async () => {
    const given = "01M2SEAMTEST00000000000000";
    const r = await saveCardPointer(USER, base("c-seam", given));
    expect(r.cardId, "store 自己造了一个 id ⇒ 指针与正文分叉").toBe(given);
    const row = await getCardPointer(USER, given);
    expect(row, "按调用方给的 id 应当取得到那一行").toBeTruthy();
    expect(row!.cardId).toBe(given);
    // 🔴 承重:指针里的 id 必须与正文 key 里那一段**逐字相同** —— 不同就等于指针指向读不回来的位置
    const seg = row!.bodyRef.key.split("/")[2];
    expect(seg, `bodyRef.key=${row!.bodyRef.key} 里的 id 段与 cardId 不一致`).toBe(given);
  });

  it("🔴 cardId 缺失 ⇒ 拒(不许悄悄补一个:那正是 P0 的形状)", async () => {
    await expect(saveCardPointer(USER, { ...base("c-nocard"), cardId: "" } as never)).rejects.toThrow(/cardId/);
    await expect(saveCardPointer(USER, { ...base("c-nocard"), cardId: undefined } as never)).rejects.toThrow(/cardId/);
  });

  it("上限常量就是用户拍的 100 / 200 轮 / 20MB", () => {
    expect(CARD_LIMIT).toBe(100);
    expect(MAX_TURNS).toBe(200);
    expect(MAX_BODY_BYTES).toBe(20 * 1024 * 1024);
  });

  it("🔴 数据值字段进不来(A4 让非法状态无法表达):rows/columns/answer/sql/steps/result/turns 逐个被拒", () => {
    for (const key of ["rows", "columns", "answer", "sql", "steps", "result", "turns", "chart", "title"]) {
      expect(() => assertNoDataValues({ [key]: 1 }, "t"), key).toThrow(CardInputInvalid);
    }
    expect(() => assertNoDataValues({ bytes: 1, turnCount: 2 }, "t")).not.toThrow();
  });

  it("🔴 保存路径也过同一道黑名单(不是只有 assertNoDataValues 自己被测)", async () => {
    await expect(saveCardPointer(USER, { ...base("c1"), answer: "1204 人" } as any)).rejects.toThrow(/数据值字段 answer/);
    // 🔴 用户 2026-09-12 拍板「标题也留区」⇒ `title` 进中央指针也要被拒(否掉了「标题存中央」那个默认)
    await expect(saveCardPointer(USER, { ...base("c1"), title: "华东区客户分布" } as any)).rejects.toThrow(/数据值字段 title/);
  });

  it("第一张卡:事务写入指针 + 计数器 = 1", async () => {
    const r = await saveCardPointer(USER, base("c1"));
    expect(r.created).toBe(true);
    expect(r.used).toBe(1);
    expect(await readQuota(USER)).toBe(1);
    const p = await getCardPointer(USER, r.cardId);
    expect(p?.state).toBe("ready");
    expect(p?.targetId).toBe("tgt_use1_a");
  });

  it("🔴 指针行里不许出现任何数据值字段(GC-7 的单测版:扫真正写进去的那一行)", async () => {
    const r = await saveCardPointer(USER, base("c1"));
    const row = store.get(`${USER}|card#${r.cardId}`)!;
    for (const key of ["rows", "columns", "answer", "sql", "steps", "result", "turns", "title"]) {
      expect(key in row, `指针行出现了数据值字段 ${key}`).toBe(false);
    }
    expect(row.bodyRef.bucket).toContain("tgt-use1-a"); // 正文指向该区的桶
  });

  it("🔴 同一段对话重复保存 = 更新同一张卡,配额只 +1(否则点三次吃 3 个额度)", async () => {
    const a = await saveCardPointer(USER, base("c1"));
    const b = await saveCardPointer(USER, { ...base("c1"), turnCount: 5 });
    expect(b.cardId).toBe(a.cardId);
    expect(b.created).toBe(false);
    // 覆盖式更新:第二次的标题与轮数都要真的落下去(不是「没报错就算更新了」)
    let p = await getCardPointer(USER, a.cardId);
    expect(p?.turnCount).toBe(5);
    expect(p?.updatedAt >= (p?.createdAt as string)).toBe(true);

    const c = await saveCardPointer(USER, { ...base("c1"), turnCount: 7 });
    expect(c.cardId).toBe(a.cardId);
    p = await getCardPointer(USER, a.cardId);
    expect(p?.turnCount).toBe(7); // 后写覆盖前写
    // 点了三次,配额只 +1、只有一张卡
    expect(await readQuota(USER)).toBe(1);
    expect((await listCardPointers(USER)).length).toBe(1);
  });

  it("🔴 上限是真的:第 101 张抛 CardQuotaExceeded 且带真实 used", async () => {
    for (let i = 0; i < CARD_LIMIT; i++) await saveCardPointer(USER, base(`c${i}`));
    expect(await readQuota(USER)).toBe(CARD_LIMIT);
    await expect(saveCardPointer(USER, base("overflow"))).rejects.toBeInstanceOf(CardQuotaExceeded);
    try {
      await saveCardPointer(USER, base("overflow2"));
    } catch (e) {
      expect((e as CardQuotaExceeded).used).toBe(100);
      expect((e as CardQuotaExceeded).limit).toBe(100);
      expect(String(e)).toContain("100");
    }
    expect(store.has(`${USER}|card#overflow`)).toBe(false); // 满额时**没有**留下半张卡
  });

  it("🔴 并发:99 张时同时来 5 个新对话,只成功 1 个,计数器恰好 100(不是 104)", async () => {
    for (let i = 0; i < CARD_LIMIT - 1; i++) await saveCardPointer(USER, base(`c${i}`));
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((i) => saveCardPointer(USER, base(`race${i}`))));
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(ok.length).toBe(1);
    expect(rejected.length).toBe(4);
    expect(rejected.every((r) => (r as PromiseRejectedResult).reason instanceof CardQuotaExceeded)).toBe(true);
    expect(await readQuota(USER)).toBe(CARD_LIMIT);
  });

  it("🔴 cardId 撞了**不许**报成「配额满」(两种取消原因必须分得开)", async () => {
    // 造一个「指针那一项条件失败、计数器那一项没问题」的事务取消:预先占住 ulid 会生成的那个键做不到,
    // 于是直接验分流逻辑 —— 计数器项没失败时,异常必须原样上抛而不是变成 CardQuotaExceeded。
    // 🔴 只拦**事务**那一次(钩子)。上一版用 mockImplementationOnce 拦「第一个 send」,而第一个 send 是
    //    幂等查的 Query ⇒ 异常从 findCardByConversation 抛出、测试**因错误原因通过** —— 变异 M5 存活正是这么暴露的。
    hooks.failTransactReasons = [{ Code: "ConditionalCheckFailed" }, { Code: "None" }];
    const err = await saveCardPointer(USER, base("collide")).then(() => null, (e) => e);
    hooks.failTransactReasons = null;
    expect(err).toBeInstanceOf(TransactionCanceledException);
    expect(err, "cardId 撞了被报成「配额满」= 用户看到一句完全错误的原因").not.toBeInstanceOf(CardQuotaExceeded);
  });

  it("🔴 删卡释放额度、幂等、且绝不扣穿", async () => {
    const a = await saveCardPointer(USER, base("c1"));
    await saveCardPointer(USER, base("c2"));
    expect(await readQuota(USER)).toBe(2);

    expect(await releaseCardQuota(USER, a.cardId)).toBe("released");
    expect(await readQuota(USER)).toBe(1);
    expect((await getCardPointer(USER, a.cardId))?.state).toBe("deleting");

    // 幂等:再释放一次不再扣
    expect(await releaseCardQuota(USER, a.cardId)).toBe("not-ready");
    expect(await readQuota(USER)).toBe(1);
    // 不存在的卡:回 false,不扣
    expect(await releaseCardQuota(USER, "01NOPE")).toBe("not-ready");
    expect(await readQuota(USER)).toBe(1);

    await deleteCardPointer(USER, a.cardId);
    expect(await getCardPointer(USER, a.cardId)).toBeNull();
    expect(await readQuota(USER)).toBe(1);
  });

  it("🔴 计数器绝不为负:把两张全删完再多删一次,n 停在 0", async () => {
    const a = await saveCardPointer(USER, base("c1"));
    const b = await saveCardPointer(USER, base("c2"));
    await releaseCardQuota(USER, a.cardId);
    await releaseCardQuota(USER, b.cardId);
    expect(await readQuota(USER)).toBe(0);
    const c = await saveCardPointer(USER, base("c3"));
    await releaseCardQuota(USER, c.cardId);
    expect(await readQuota(USER)).toBe(0);
  });

  it("🔴 计数器与指针不一致(卡片 ready 但 n=0)⇒ 回 quota-broken,**绝不把 n 扣成负数**", async () => {
    const a = await saveCardPointer(USER, base("c1"));
    // 人为造出真实会发生的脏状态:指针还在、计数器被抹成 0(两个 item 本来就能各自漂移)
    store.set(`${USER}|quota#`, { pk: USER, sk: "quota#", n: 0 });
    expect(await releaseCardQuota(USER, a.cardId)).toBe("quota-broken");
    expect(await readQuota(USER)).toBe(0); // 不是 -1
    expect((await getCardPointer(USER, a.cardId))?.state).toBe("ready"); // 事务整体取消,卡片没被半删
    // 自愈通道:对账后重试一次就能删掉(不让用户卡死在一张永远删不掉的卡上)
    expect(await reconcileQuota(USER)).toBe(1);
    expect(await releaseCardQuota(USER, a.cardId)).toBe("released");
    expect(await readQuota(USER)).toBe(0);
  });

  it("列表包含 deleting 的卡(残留可见,口径)且按 updatedAt 倒序", async () => {
    const a = await saveCardPointer(USER, base("c1"));
    await new Promise((r) => setTimeout(r, 2));
    const b = await saveCardPointer(USER, base("c2"));
    await releaseCardQuota(USER, a.cardId);
    const list = await listCardPointers(USER);
    expect(list.length).toBe(2);
    expect(list.map((x) => x.state)).toContain("deleting");
    expect(list[0].updatedAt >= list[1].updatedAt).toBe(true);
    expect(list.some((x) => x.cardId === b.cardId)).toBe(true);
  });

  it("幂等查只认 ready(正在删的那张不该被复用)", async () => {
    const a = await saveCardPointer(USER, base("c1"));
    expect((await findCardByConversation(USER, "c1"))?.cardId).toBe(a.cardId);
    await releaseCardQuota(USER, a.cardId);
    expect(await findCardByConversation(USER, "c1")).toBeNull();
    // 🔴 真实调用方在这一步会生成一个**新的** ulid(旧那张还在 deleting、正文也还在它自己的 key 上)
    //    ⇒ 复用旧 id 会撞主键,而且会让新卡片的正文覆盖正在被清理的那一份。
    const again = await saveCardPointer(USER, base("c1", "01M2CARDSECONDONE00000000"));
    expect(again.created).toBe(true);
    expect(again.cardId).not.toBe(a.cardId);
  });

  it("卡片按用户隔离:另一个 sub 的列表与配额互不影响", async () => {
    await saveCardPointer(USER, base("c1"));
    await saveCardPointer("sub-other", base("c1"));
    expect(await readQuota(USER)).toBe(1);
    expect(await readQuota("sub-other")).toBe(1);
    expect((await listCardPointers(USER)).length).toBe(1);
  });

  it("🔴 拒绝时必须说清超在哪、超多少(不静默截断)", async () => {
    await expect(saveCardPointer(USER, { ...base("c1"), turnCount: 201 })).rejects.toThrow(/201 轮.*上限 200 轮.*超出 1 轮/s);
    await expect(saveCardPointer(USER, { ...base("c1"), bytes: MAX_BODY_BYTES + 1024 * 1024 })).rejects.toThrow(/21\.0MB.*上限 20\.0MB.*超出 1\.0MB/s);
    // 标题的校验已随「标题也留区」移到区域侧(`cards-body-store` 的 `assertTitle`),见那套单测
    await expect(saveCardPointer(USER, { ...base("c1"), targetId: "" })).rejects.toThrow(/落点是必填.*绝不回落主控区/);
    await expect(saveCardPointer(USER, { ...base("c1"), bodyRef: { bucket: "", key: "" } })).rejects.toThrow(/指针不许指向空/);
    await expect(saveCardPointer("", base("c1"))).rejects.toThrow(/Cognito sub/);
  });

  it("reconcileQuota 按真实 ready 张数重置(修复通道,不是常规路径)", async () => {
    const a = await saveCardPointer(USER, base("c1"));
    await saveCardPointer(USER, base("c2"));
    await releaseCardQuota(USER, a.cardId);
    store.set(`${USER}|quota#`, { pk: USER, sk: "quota#", n: 77 }); // 人为把计数器搞坏
    expect(await reconcileQuota(USER)).toBe(1);
    expect(await readQuota(USER)).toBe(1);
  });
});
