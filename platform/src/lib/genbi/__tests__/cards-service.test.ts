// @kf-batch 54-genbi-session-cards
// 会话卡片编排层单测:测的是**顺序与分流**(落点解析用哪个入口、驻留门在第几步、失败怎么补偿),
// 底层三件(指针+配额 / 区域正文 / 记忆回灌)各有自己的套件。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const h = vi.hoisted(() => ({
  ready: true,                       // requireReadyTarget 是否放行
  rawTarget: true,                   // getTargetRaw 是否找得到
  auditCalls: [] as any[],
  bodyStore: new Map<string, any>(),
  bodyDeletes: [] as string[],
  bodyDeleteOk: true,
  pointer: null as any,
  saveThrows: null as any,
  release: "released" as string,
  reconciled: 0,
  replaced: [] as any[],
  maskNow: [] as string[],
  maskCalls: [] as any[],            // maskRows 的真实入参(断 sql/database 有没有传到)
  pointerInputs: [] as any[],        // saveCardPointer 的真实入参(断 cardId 就是写正文那个)
  pointerDeleted: false,             // deleteCardPointer 有没有被调(终态孤儿必须删指针)
  seq: [] as string[],   // 全局调用序:用来断「驻留门在写正文之前」
  headFails: false,      // 模拟「标题所在区域读不到」
}));

// 🔴 类必须在 `vi.mock` 工厂**内部**定义:mock 工厂会被提升到文件顶部,
//    引用后面才声明的 class 会 `Cannot access before initialization`(实测)。
vi.mock("@/lib/exec-env/registry", () => ({
  TargetNotReadyError: class TargetNotReadyError extends Error {
    constructor(readonly targetId: string, readonly why: string) { super(`${targetId}: ${why}`); this.name = "TargetNotReadyError"; }
  },
  requireReadyTarget: vi.fn(async (t: string) => {
    if (!h.ready) { const e: any = new Error(`${t}: 正在 draining`); e.name = "TargetNotReadyError"; e.targetId = t; e.why = "正在 draining"; throw Object.assign(e, { __ntr: true }); }
    return { targetId: t, region: "us-east-1", resources: {} };
  }),
  getTargetRaw: vi.fn(async (t: string) => (h.rawTarget ? { targetId: t, region: "us-east-1", resources: {} } : null)),
}));
// 🔴 **不 mock** `@/lib/exec-env/target-id`:它是纯模块,且被命名 SSOT 在**模块加载期**消费
//    (只导出 isHome 会让 HOME_TARGET_ID 变 undefined ⇒ `resourceName` 加载期抛,报错位置离真因很远)。
vi.mock("@/lib/exec-env/residency-audit", () => ({
  auditActorOrService: (a: any) => ({ actor: a, skipAck: false }),
  residencyAudit: vi.fn(async (i: any) => { h.auditCalls.push(i); h.seq.push("audit"); return null; }),
}));
vi.mock("@/lib/governance/masking", () => ({
  // 🔴 记下**真实入参**:重脱敏的成败全看有没有把 sql + database 传进来(2026-09-13 的真缺口)。
  maskRows: vi.fn(async (i: any) => { h.maskCalls.push(i); return { rows: i.rows, maskedColumns: h.maskNow }; }),
}));
vi.mock("@/lib/genbi/memory", () => ({
  replaceConversation: vi.fn(async (c: string, turns: any[]) => { h.replaced.push({ c, n: turns.length }); return { backend: "selfmanaged", cleared: 0, written: turns.length, skipped: false }; }),
}));
vi.mock("@/lib/genbi/cards-store", async (orig) => {
  const real = (await orig()) as any;
  return {
    ...real,
    listCardPointers: vi.fn(async () => (h.pointer ? [h.pointer] : [])),
    getCardPointer: vi.fn(async (_u: string, id: string) => (h.pointer && h.pointer.cardId === id ? h.pointer : null)),
    readQuota: vi.fn(async () => 7),
    // 🔴 记下入参:2026-09-13 的 P0 就在这个接缝上(service 用一个 id 写正文、store 又造了第二个写指针)。
    //    mock 必须**回传它收到的 cardId**,否则 mock 自己就把分叉抹平了 —— 那正是当初没被逮到的原因。
    saveCardPointer: vi.fn(async (_u: string, i: any) => {
      h.pointerInputs.push(i);
      if (h.saveThrows) throw h.saveThrows;
      return { cardId: i.cardId, created: !h.pointer, used: 8 };
    }),
    releaseCardQuota: vi.fn(async () => h.release),
    reconcileQuota: vi.fn(async () => { h.reconciled += 1; h.release = "released"; return 1; }),
    deleteCardPointer: vi.fn(async () => { h.pointerDeleted = true; }),
  };
});
vi.mock("@/lib/genbi/cards-body-store", async (orig) => {
  const real = (await orig()) as any;
  return {
    ...real,
    putCardBody: vi.fn(async (t: any, sub: string, body: any) => {
      h.seq.push("putBody");
      h.bodyStore.set(body.cardId, body);
      return { bucket: `bgp-datalake-x-${t.targetId.replace(/_/g, "-")}`, key: `genbi-cards/${sub}/${body.cardId}/body.json`, region: t.region, bytes: 1234, sha256: "abc" };
    }),
    getCardBody: vi.fn(async (_t: any, _s: string, id: string) => h.bodyStore.get(id) ?? null),
    getCardHead: vi.fn(async (_t: any, _s: string, id: string) => {
      if (h.headFails) throw Object.assign(new Error("AccessDenied"), { name: "AccessDenied" });
      const b = h.bodyStore.get(id);
      return b ? { v: 1, cardId: id, title: b.title, turnCount: b.turns.length, savedAt: b.savedAt } : null;
    }),
    deleteCardBody: vi.fn(async (_t: any, _s: string, id: string) => { h.bodyDeletes.push(id); if (h.bodyDeleteOk) h.bodyStore.delete(id); return h.bodyDeleteOk; }),
  };
});

import { CardNotFound, CardQuotaExceeded, CardStoreUnavailable, attachTitles, deleteCard, openCard, resumeCard, saveCard, listCards } from "../cards-service";
import { CardInputInvalid } from "../cards-store";

const SUB = "sub-1";
const T2 = "tgt_use1_a";
const turn = (q: string, cols: string[] = ["region", "n"]) => ({
  i: 0, question: q, askedAt: "2026-09-12T10:00:00.000Z",
  result: { answer: `答:${q}`, sql: `select ${q}`, columns: cols, rows: [["华东", "1204"]], maskedColumns: [] as string[] },
});

const pointerOf = (over: any = {}) => ({
  cardId: "01CARD", conversationId: "conv-1", targetId: T2, region: "us-east-1", projectId: "proj-default",
  engine: "redshift", turnCount: 1, bytes: 1, bodyRef: { bucket: "b", key: "k" }, bodySha256: "abc",
  createdAt: "2026-09-12T10:00:00.000Z", updatedAt: "2026-09-12T10:00:00.000Z", state: "ready", ...over,
});

beforeEach(() => {
  h.ready = true; h.rawTarget = true; h.auditCalls = []; h.bodyStore.clear(); h.bodyDeletes = [];
  h.bodyDeleteOk = true; h.pointer = null; h.saveThrows = null; h.release = "released"; h.reconciled = 0;
  h.replaced = []; h.maskNow = []; h.seq = []; h.headFails = false; h.maskCalls = []; h.pointerInputs = []; h.pointerDeleted = false;
});

const save = (over: any = {}) => saveCard({
  userSub: SUB, identity: null, projectId: "proj-default", targetId: T2, engine: "redshift",
  database: "dev",
  conversationId: "conv-1", title: "华东区客户分布", turns: [turn("按地区统计客户数")] as any, ...over,
});

describe("54 会话卡片 · 编排层", () => {
  it("一轮都没有 ⇒ 拒(没有可保存的内容)", async () => {
    await expect(save({ turns: [] })).rejects.toBeInstanceOf(CardInputInvalid);
  });

  // ── 🔴🔴 2026-09-13 真环境首跑抓到的 P0:cardId 分叉 ⇒ **每张卡都打不开** ──
  // 病:`saveCard` 生成一个 ulid() 写**正文的 key**,而 `saveCardPointer` 又 ulid() 了**第二个**写指针。
  // 为什么单测全绿:service 的单测 mock 掉 store、store 的单测只看自己 ⇒ **接缝从没被测过**
  // (93 条单测 + 60 个变异全绿,而功能 100% 不可用)。这一条与 store 侧那条合起来把接缝封死。
  it("🔴🔴 传给指针的 cardId **就是**写正文用的那一个(两处分叉 = 每张卡都打不开)", async () => {
    const r = await save();
    expect(h.pointerInputs.length, "没调 saveCardPointer").toBe(1);
    const given = h.pointerInputs[0].cardId;
    expect(given, "service 没把 cardId 传给指针 ⇒ store 会自己造第二个").toBeTruthy();
    // 正文侧:bodyStore 的键就是真实 key,里面那一段必须是同一个 id
    const body = Array.from(h.bodyStore.values())[0] as any;
    expect(body.cardId, "正文里的 cardId 与传给指针的不一致").toBe(given);
    const key = Array.from(h.bodyStore.keys())[0] as string;
    expect(key, `正文 key=${key} 里没有那个 cardId`).toContain(given);
    // 回给调用方的也必须是同一个(否则页面拿着一个读不回来的 id)
    expect(r.cardId).toBe(given);
  });

  // ── 🔴🔴 2026-09-13 真环境撞到:执行环境被删掉之后,那个区的卡片**永远删不掉** ──
  // 改动前:`getTargetRaw` 回 null ⇒ bodyCleaned=false ⇒ **保留** deleting 指针 ⇒ 那一行永久卡在
  // 用户的卡片集合里(额度早已释放,留着它对用户只有害处:既删不掉、也做不了任何事),
  // 而「清理未完成 · 重试」这条提示重试一万次也不会成。序 15「删除执行环境」上线后这必然发生。
  describe("🔴 执行环境已不在注册表 = **终态**,不是可重试", () => {
    it("指针必须被删掉(用户列表恢复诚实),并回 bodyOrphaned 交给能处置的人", async () => {
      h.pointer = pointerOf();
      await save();
      h.rawTarget = false;                 // 该 target 已从注册表消失
      const r = await deleteCard(SUB, "01CARD");
      expect(r.deleted).toBe(true);
      expect(r.bodyCleaned, "够不到的区不许谎称清干净了").toBe(false);
      expect(r.bodyOrphaned, "🔴 没回 bodyOrphaned ⇒ 孤儿信息丢了,运维无从追").toBeTruthy();
      expect(r.bodyOrphaned!.targetId).toBe(T2);
      expect(r.bodyOrphaned!.key, "要带上落点,否则运维定位不到那个对象").toBeTruthy();
      expect(h.pointerDeleted, "🔴 指针没删 ⇒ 用户名下留下一行永远删不掉的卡").toBe(true);
    });

    it("target 还在、只是这次删失败 ⇒ 仍按**可重试**处理(保留 deleting 指针,不回 bodyOrphaned)", async () => {
      h.pointer = pointerOf();
      await save();
      h.bodyDeleteOk = false;              // 区还在,只是这次删不掉
      const r = await deleteCard(SUB, "01CARD");
      expect(r.bodyCleaned).toBe(false);
      expect(r.bodyOrphaned, "把可重试的失败说成终态 ⇒ 用户以为东西没了").toBeUndefined();
      expect(h.pointerDeleted, "可重试的失败必须保留指针(残留可见)").toBe(false);
    });
  });

  it("🔴🔴 指针写失败 ⇒ **任何**原因都要把刚写的正文删掉(不只是满额)", async () => {
    // 病史:改动前只在 CardQuotaExceeded 时补偿 ⇒ 并发争抢(真环境 100 次里 3 次)每发生一次
    //      就**静默留下一个孤儿正文对象**,而且永远没人会发现(没有指针指向它)。
    for (const err of [new Error("TransactionConflict 用尽"), new CardStoreUnavailable("表不可达")]) {
      h.bodyStore.clear(); h.bodyDeletes = []; h.saveThrows = err; h.pointer = null;
      await expect(save()).rejects.toBeTruthy();
      expect(h.bodyDeletes.length, `失败原因=${(err as Error).name} 时没有补偿删除 ⇒ 留下孤儿正文`).toBe(1);
    }
  });

  it("重存已有卡时指针写失败 ⇒ **不许**删正文(那是它自己的正文)", async () => {
    h.pointer = pointerOf();
    h.saveThrows = new Error("TransactionConflict 用尽");
    h.bodyDeletes = [];
    await expect(save()).rejects.toBeTruthy();
    expect(h.bodyDeletes.length, "把已有卡片的正文删了 = 用一次失败的保存毁掉用户原来那张卡").toBe(0);
  });

  it("🔴 重存同一段对话:沿用**原卡**的 cardId(换新 id 会让正文与指针都分叉 + 多吃一个额度)", async () => {
    h.pointer = pointerOf();
    await save();
    expect(h.pointerInputs[0].cardId).toBe("01CARD");
    const key = Array.from(h.bodyStore.keys())[0] as string;
    expect(key).toContain("01CARD");
  });

  // ── 🔴🔴 2026-09-13:重脱敏原来**恒为 no-op**(卡片成了绕过数据分级的后门)──
  // 病根:`maskRows` 先由「列元数据 / SQL」算出这次涉及哪些表,再查那些表的分级;卡片这条路
  // 两样都没传 ⇒ 参考表集合为空 ⇒ 它在第一个分支就 passthrough ⇒ 打开旧卡片永远拿到明文。
  describe("🔴🔴 重脱敏必须真的能判(sql + database 要传到 maskRows)", () => {
    it("保存缺 database ⇒ 拒(不给静默默认值:那会让这张卡的脱敏永久失效)", async () => {
      await expect(save({ database: "" })).rejects.toBeInstanceOf(CardInputInvalid);
      await expect(save({ database: undefined })).rejects.toBeInstanceOf(CardInputInvalid);
    });

    it("database 随正文存进该区(不是存中央指针)", async () => {
      await save({ database: "dev" });
      const body = Array.from(h.bodyStore.values())[0];
      expect(body.database).toBe("dev");
    });

    it("打开卡片:maskRows 拿到该轮的 sql 与正文里的 database", async () => {
      h.pointer = pointerOf();            // 🔴 必须先于 save:否则 save 用新 ulid,正文键对不上
      await save({ database: "analytics" });
      await openCard(SUB, "01CARD", null);
      expect(h.maskCalls.length, "一轮都没脱敏 ⇒ 重脱敏没跑").toBe(1);
      expect(h.maskCalls[0].sql, "🔴 没把 sql 传进去 ⇒ 解析不出涉及的表 ⇒ 直接放行明文").toBe("select 按地区统计客户数");
      expect(h.maskCalls[0].database, "🔴 没把 database 传进去 ⇒ 拼不出 FQN ⇒ 直接放行明文").toBe("analytics");
    });

    it("老卡片(正文里没 database)⇒ 回落平台默认库,而不是 undefined", async () => {
      h.pointer = pointerOf();
      await save({ database: "dev" });
      // 修复之前存下来的卡片就是这个形状(正文里压根没有 database 这个键)
      delete (Array.from(h.bodyStore.values())[0] as any).database;
      await openCard(SUB, "01CARD", null);
      expect(h.maskCalls[0].database, "老卡片就放弃脱敏 = 后门还在").toBeTruthy();
      expect(h.maskCalls[0].database).not.toBeUndefined();
    });
  });

  it("保存:落点用 requireReadyTarget(要往那个区写 ⇒ 必须可承接),正文进该区的桶", async () => {
    const r = await save();
    expect(r.created).toBe(true);
    expect(r.limit).toBe(100);
    const body = Array.from(h.bodyStore.values())[0];
    expect(body.targetId).toBe(T2);
    expect(body.turns.length).toBe(1);
    expect(body.turns[0].result.rows).toEqual([["华东", "1204"]]); // 数据行**原封不动**进正文
  });

  it("🔴 目标不可承接 ⇒ 保存直接抛,**一个字节都不写**(绝不改存主控区)", async () => {
    h.ready = false;
    await expect(save()).rejects.toMatchObject({ name: "TargetNotReadyError" });
    expect(h.bodyStore.size).toBe(0);
    expect(h.auditCalls.length).toBe(0);
  });

  it("🔴 驻留门在**写正文之前**过,且 entry/triggeredBy 用的是既有闭合词表 + 可区分的来源标记", async () => {
    await save();
    expect(h.auditCalls.length).toBe(1);
    expect(h.auditCalls[0].entry).toBe("result");
    expect(h.auditCalls[0].triggeredBy).toBe("genbi-card-save");
    expect(h.auditCalls[0].sqlText).toContain("select 按地区统计客户数");
    // 🔴 顺序可断:审计必须**先于**写正文 —— 反过来就是「先把数据落到该区、再去问能不能落」
    expect(h.seq).toEqual(["audit", "putBody"]);
    expect(h.auditCalls[0].knownJurisdiction).toBeUndefined(); // 非 home ⇒ 交给权威准入判
  });

  it("home 的卡片:法域直接告知为 home(不再多读一次注册表)", async () => {
    await save({ targetId: "tgt_home" });
    expect(h.auditCalls[0].knownJurisdiction).toBe("home");
  });

  it("🔴 满额(新卡)⇒ **把刚写的正文删掉**再抛,不留孤儿对象", async () => {
    h.saveThrows = new CardQuotaExceeded(100);
    await expect(save()).rejects.toBeInstanceOf(CardQuotaExceeded);
    expect(h.bodyDeletes.length, "满额却没补偿删除 ⇒ 每次撞上限都留一个孤儿").toBe(1);
    expect(h.bodyStore.size).toBe(0);
  });

  it("🔴 满额但这是**已存在的卡**(重存)⇒ **不许**删正文(那是它自己的正文,删了就把好卡片弄坏了)", async () => {
    h.pointer = pointerOf();
    h.saveThrows = new CardQuotaExceeded(100);
    await expect(save()).rejects.toBeInstanceOf(CardQuotaExceeded);
    expect(h.bodyDeletes.length).toBe(0);
  });

  it("重存同一段对话 ⇒ 沿用原 cardId(正文原地覆盖)", async () => {
    h.pointer = pointerOf();
    const r = await save();
    expect(r.cardId).toBe("01CARD");
    expect(h.bodyStore.has("01CARD")).toBe(true);
  });

  it("🔴🔴 打开(只读)用 getTargetRaw:目标**不可承接也能看**(「能不能看」≠「能不能承接」)", async () => {
    h.pointer = pointerOf();
    await save();
    h.ready = false; // 该区开始 draining
    const opened = await openCard(SUB, "01CARD", null);
    expect(opened.bodyMissing).toBe(false);
    expect(opened.body.turns.length).toBe(1);
  });

  it("打开:不是我的卡 ⇒ CardNotFound(路由转 404,不泄露存在性)", async () => {
    await expect(openCard(SUB, "01NOPE", null)).rejects.toBeInstanceOf(CardNotFound);
  });

  it("打开:target 已从注册表删掉 ⇒ 说人话 + 允许删卡(不是抛个看不懂的错)", async () => {
    h.pointer = pointerOf();
    h.rawTarget = false;
    await expect(openCard(SUB, "01CARD", null)).rejects.toBeInstanceOf(CardStoreUnavailable);
  });

  it("打开:正文对象不在了 ⇒ bodyMissing=true(不抛),轮次为空", async () => {
    h.pointer = pointerOf();
    const opened = await openCard(SUB, "01CARD", null);
    expect(opened.bodyMissing).toBe(true);
    expect(opened.body.turns).toEqual([]);
  });

  it("🔴 打开时**按当前分级重新脱敏**:新隐去的列进 maskedNow,存的与现在的取并集(更严)", async () => {
    h.pointer = pointerOf();
    await save();
    // 存的时候 `region` 就已脱敏;保存之后 `n` 也被标为敏感 ⇒ 并集必须是两列
    (Array.from(h.bodyStore.values())[0] as any).turns[0].result.maskedColumns = ["region"];
    h.maskNow = ["n"];
    const opened = await openCard(SUB, "01CARD", null);
    expect(opened.maskedNow, "只报**这次新隐去**的那一列").toEqual(["n"]);
    expect(
      ((opened.body.turns[0].result as any).maskedColumns as string[]).slice().sort(),
      "🔴 必须取并集(更严):改成「用新的替换旧的」会让当年脱过的列重新变明文"
    ).toEqual(["n", "region"]);
  });

  it("🔴 续聊要求**可承接**(要在那个区跑);不可承接 ⇒ 抛,页面据此只给「只读查看」", async () => {
    h.pointer = pointerOf();
    await save();
    h.ready = false;
    await expect(resumeCard(SUB, "01CARD", null)).rejects.toMatchObject({ name: "TargetNotReadyError" });
    expect(h.replaced.length, "不可承接却已经把记忆灌了 ⇒ 用户在错的区继续问").toBe(0);
  });

  it("续聊:回灌用**卡片原来的 conversationId**(换 id 会让再次保存找不到原卡、多吃一个额度)", async () => {
    h.pointer = pointerOf();
    await save();
    const r = await resumeCard(SUB, "01CARD", null);
    expect(r.conversationId).toBe("conv-1");
    expect(r.targetId).toBe(T2);
    expect(h.replaced[0].c).toBe("conv-1");
    expect(r.rehydratedTurns).toBe(1);
  });

  it("续聊:正文不在了 ⇒ 明确拒绝(而不是灌一段空上下文继续对话)", async () => {
    h.pointer = pointerOf();
    await expect(resumeCard(SUB, "01CARD", null)).rejects.toBeInstanceOf(CardStoreUnavailable);
    expect(h.replaced.length).toBe(0);
  });

  it("删卡:释放额度 → 删正文 → 删指针", async () => {
    h.pointer = pointerOf();
    await save();
    const r = await deleteCard(SUB, "01CARD");
    expect(r.deleted).toBe(true);
    expect(r.bodyCleaned).toBe(true);
    expect(h.bodyDeletes).toEqual(["01CARD"]);
  });

  it("🔴 删卡:正文清理失败 ⇒ `bodyCleaned:false` 且**指针保留**(残留可见,不假装删干净了)", async () => {
    h.pointer = pointerOf();
    await save();
    h.bodyDeleteOk = false;
    const r = await deleteCard(SUB, "01CARD");
    expect(r.bodyCleaned).toBe(false);
  });

  it("🔴 删卡遇到「计数器坏了」⇒ 对账后重试一次,不把用户卡在一张永远删不掉的卡上", async () => {
    h.pointer = pointerOf();
    await save();
    h.release = "quota-broken";
    const r = await deleteCard(SUB, "01CARD");
    expect(h.reconciled).toBe(1);
    expect(r.deleted).toBe(true);
  });

  // ── 「标题也留区」的列表行为(用户 2026-09-12 拍板)──
  it("列表标题从**该卡自己的区域**取(中央指针里压根没有 title)", async () => {
    h.pointer = pointerOf();
    await save();
    expect("title" in (h.pointer as any), "中央指针不该有 title").toBe(false);
    const rows = await attachTitles(SUB, [pointerOf() as any]);
    expect(rows[0].title).toBe("华东区客户分布");
    expect(rows[0].titleUnavailable).toBe(false);
  });

  it("🔴🔴 标题所在区域读不到 ⇒ **降级不消失**:该行仍在列表里,title=null + titleUnavailable=true", async () => {
    h.pointer = pointerOf();
    await save();
    h.headFails = true;
    const rows = await attachTitles(SUB, [pointerOf() as any]);
    expect(rows.length, "把读不到标题的卡片从列表里去掉 = 用户以为卡片丢了,比看不到标题严重得多").toBe(1);
    expect(rows[0].title).toBeNull();
    expect(rows[0].titleUnavailable).toBe(true);
    expect(rows[0].targetId).toBe(T2);   // 区域/时间/轮数都来自中央,仍然可见
    expect(rows[0].turnCount).toBe(1);
  });

  it("target 已从注册表删掉 ⇒ 同样降级列出(不抛、不丢行)", async () => {
    h.pointer = pointerOf();
    h.rawTarget = false;
    const rows = await attachTitles(SUB, [pointerOf() as any]);
    expect(rows.length).toBe(1);
    expect(rows[0].titleUnavailable).toBe(true);
  });

  it("列表回 used/limit", async () => {
    h.pointer = pointerOf();
    const r = await listCards(SUB);
    expect(r.limit).toBe(100);
    expect(r.used).toBe(7);
    expect(r.items.length).toBe(1);
  });
});

// @kf-batch 50-WP26b-region-derive
// 🔴 **region 一律从活的 target 派生,存下来的那份只作回落。**
//
// 【怎么现形的】2026-09-20 一张截图:`读取 tgt_euw1_a(us-west-2)的卡片正文失败…`
//   —— 而 `tgt_euw1_a` 在 **eu-west-1**。拼这句话用的是 `pointer.region`(保存那一刻的**快照**)。
//   🔴 诚实地说:生产路径上 `targetId` 与 target 的 region 都不可变 ⇒ 两者**不会**自然分叉,
//     那次分叉是判据的夹具改了指针造成的。所以这不是「生产可达的缺陷」,
//     而是**同一件事两个作者**的一处不一致 —— 同一个文件里 `resumeCard` 早就写成
//     `target.region ?? opened.pointer.region`(派生),只有报错这一句还在用快照。
//   修它的理由是:一句会把「一个区的东西说成另一个区」的话,**不该有能力**说错
//   (记忆 stale-response-race-shows-wrong-region:界面说错区这一族,本项目已经改过三刀)。
describe("卡片的 region 只能从活的 target 派生(WP-26b)", () => {
  const src = readFileSync(resolve(__dirname, "../cards-service.ts"), "utf8");

  it("读正文失败那句话里的 region 取自 target,不是指针里的快照", () => {
    expect(src, "又回到 pointer.region 了 ⇒ 这句话有能力把一个区说成另一个区").not.toMatch(
      /读取 \$\{pointer\.targetId\}\(\$\{pointer\.region\}\)/
    );
    expect(src).toContain("const liveRegion = String((target as { region?: unknown }).region ?? pointer.region");
  });

  it("续聊回的 region 也是派生的(这一处本来就对,钉住不许退回去)", () => {
    expect(src).toMatch(/region: String\(target\.region \?\? opened\.pointer\.region\)/);
  });
});
