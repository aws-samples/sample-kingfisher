// @kf-batch 54-genbi-session-cards
// 会话卡片**正文**(区域侧 S3)的单测。
// 🔴 只 mock `s3ClientFor`,**保留真实的 `resolveTargetGlue`** —— 本文件最要证的事就是
//    「正文落该 target 自己的桶、绝不回落主控区」,把落点解析也 mock 掉就等于把判据本身挖空。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sent: any[] = [];
const askedRegions: string[] = [];

vi.mock("@/lib/exec-env/target-clients", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    s3ClientFor: vi.fn(async (region: string) => {
      askedRegions.push(region);
      return {
        send: vi.fn(async (cmd: any) => {
          sent.push(cmd);
          if (cmd.__fail) throw Object.assign(new Error(cmd.__fail), { name: cmd.__fail });
          const name = cmd.constructor.name;
          if (name.includes("Get")) {
            const stored = store.get(`${cmd.input.Bucket}/${cmd.input.Key}`);
            if (stored === undefined) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
            return { Body: { transformToString: async () => stored } };
          }
          if (name.includes("Put")) { store.set(`${cmd.input.Bucket}/${cmd.input.Key}`, String(cmd.input.Body)); return {}; }
          if (name.includes("Delete")) { store.delete(`${cmd.input.Bucket}/${cmd.input.Key}`); return {}; }
          return {};
        }),
      };
    }),
  };
});

const store = new Map<string, string>();

import {
  CARD_BODY_VERSION, CARD_BODY_PREFIX, CardBodyUnreadable, MAX_TITLE_LEN, CARD_BODY_PLACE_VIA,
  cardBodyKey, cardHeadKey, cardBodyLocation, putCardBody, getCardBody, getCardHead, deleteCardBody, assertTitle,
} from "../cards-body-store";
import type { CardBody } from "../cards-body-store";
// 序 31 第二刀 ②:账本走真实现(请求存储用最小替身)
import { __setRequestStoreProvider, decisionsOfCurrentRequest } from "@/lib/place/context";

const SUB = "11111111-2222-3333-4444-5555aaaabbbb";
const CARD = "01M2AM32XSEWGF9ZTWXYN2YMZJ";

const nonHome: any = {
  targetId: "tgt_use1_a",
  region: "us-east-1",
  resources: {
    datalakeBucket: "bgp-datalake-000000000000-tgt-use1-a",
    scriptsBucket: "bgp-glue-scripts-000000000000-tgt-use1-a",
    tableBucket: "bgp-table-bucket-tgt-use1-a",
    glueRoleArn: "arn:aws:iam::000000000000:role/BgpExecEnv-tgt-use1-a-glue-role",
  },
};
const home: any = { targetId: "tgt_home", region: "us-east-1", resources: {} };

const body = (over: Partial<CardBody> = {}): CardBody => ({
  v: CARD_BODY_VERSION, cardId: CARD, conversationId: "conv-1", targetId: "tgt_use1_a",
  projectId: "proj-default", engine: "redshift", title: "华东区客户分布",
  savedAt: "2026-09-12T10:31:00.000Z", savedBy: { sub: SUB, name: "admin" },
  turns: [{ i: 0, question: "按地区统计客户数", askedAt: "2026-09-12T10:30:00.000Z",
            result: { answer: "华东 1204 人", sql: "select …", columns: ["region", "n"], rows: [["华东", "1204"]] } }],
  ...over,
});

beforeEach(() => { store.clear(); sent.length = 0; askedRegions.length = 0; });

describe("54 会话卡片 · 区域正文(落该 target 自己的区)", () => {
  it("🔴 key 片段做路径穿越防护(它会成为 S3 key 的一段)", () => {
    expect(() => cardBodyKey("../../etc", CARD)).toThrow(CardBodyUnreadable);
    expect(() => cardBodyKey(SUB, "a/b")).toThrow(CardBodyUnreadable);
    expect(() => cardBodyKey("", CARD)).toThrow(CardBodyUnreadable);
    expect(() => cardBodyKey(SUB, "")).toThrow(CardBodyUnreadable);
    expect(() => cardBodyKey(SUB, "x".repeat(200))).toThrow(CardBodyUnreadable);
    expect(cardBodyKey(SUB, CARD)).toBe(`${CARD_BODY_PREFIX}/${SUB}/${CARD}/body.json`);
  });

  it("🔴 非 home 的落点 = **该 target 描述符里的桶 + 它自己的 region**", () => {
    const loc = cardBodyLocation(nonHome, SUB, CARD);
    expect(loc.bucket).toBe("bgp-datalake-000000000000-tgt-use1-a");
    expect(loc.region).toBe("us-east-1");
    expect(loc.bucket).not.toContain("bgp-datalake-000000000000/"); // 不是 home 那个裸名
  });

  it("🔴🔴 非 home 描述符缺 datalakeBucket ⇒ **抛**,绝不回落主控区(这条是本文件的命门)", () => {
    const broken = { ...nonHome, resources: { ...nonHome.resources, datalakeBucket: undefined } };
    expect(() => cardBodyLocation(broken as any, SUB, CARD)).toThrow();
    const noRegion = { ...nonHome, region: "" };
    expect(() => cardBodyLocation(noRegion as any, SUB, CARD)).toThrow(/region/);
  });

  it("home 的落点走 home 自己的 env 值(规则对 home 不是特例,只是「该区」恰好是主控区)", () => {
    const loc = cardBodyLocation(home, SUB, CARD);
    expect(loc.bucket).toMatch(/^bgp-datalake-/);
    expect(loc.bucket).not.toContain("tgt-use1-a");
  });

  it("写正文:落到该 target 的桶,且**用该 region 的客户端**", async () => {
    const r = await putCardBody(nonHome, SUB, body());
    expect(r.bucket).toBe("bgp-datalake-000000000000-tgt-use1-a");
    expect(r.key).toBe(`${CARD_BODY_PREFIX}/${SUB}/${CARD}/body.json`);
    expect(askedRegions).toEqual(["us-east-1"]);
    expect(r.bytes).toBeGreaterThan(100);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    // 正文里**必须**有数据行(「原封不动」的实质);中央指针那边则相反(GC-7)
    expect(store.get(`${r.bucket}/${r.key}`)).toContain("1204");
  });

  it("🔴 正文的 targetId 与落点 target 不一致 ⇒ 当场拒(错位写进别的区,事后没人查得出来)", async () => {
    await expect(putCardBody(nonHome, SUB, body({ targetId: "tgt_home" }))).rejects.toThrow(/不一致/);
    expect(sent.length).toBe(0); // 拒的时候一个字节都没写出去
  });

  it("🔴 schema 版本不对 ⇒ 读写都拒,不猜字段", async () => {
    await expect(putCardBody(nonHome, SUB, body({ v: 2 }))).rejects.toThrow(CardBodyUnreadable);
    const loc = cardBodyLocation(nonHome, SUB, CARD);
    store.set(`${loc.bucket}/${loc.key}`, JSON.stringify({ ...body(), v: 99 }));
    await expect(getCardBody(nonHome, SUB, CARD)).rejects.toThrow(/不是当前版本/);
  });

  it("读回来逐字段一致(轮次 / 问题 / 结论 / SQL / 列 / **全部行**)", async () => {
    await putCardBody(nonHome, SUB, body());
    const got = await getCardBody(nonHome, SUB, CARD);
    expect(got?.turns.length).toBe(1);
    expect(got?.turns[0].question).toBe("按地区统计客户数");
    expect((got?.turns[0].result as any).rows).toEqual([["华东", "1204"]]);
    expect((got?.turns[0].result as any).sql).toBe("select …");
    expect(got?.title).toBe("华东区客户分布");
  });

  // 序 41 验收页面化(2026-10-23):硬门段 gbc GC-1 原来用 API 直存两轮刁钻内容做逐字段深比;改成页面真存后,
  //   页面造不出指定内容的对话 ⇒ 「刁钻值往返保真」这一半收进单测:null(不是空串)/ 负小数 / 前导 0 字符串(不许变数字)/
  //   中文 + emoji + 半角引号 / 嵌套图表规格 / 集合型字段 / 多轮。深比用 toEqual(键序无关;rows 是序列、按序比)。
  it("🔴 刁钻值往返保真:null / 负小数 / 前导 0 字符串 / 中文 emoji 半角引号 / 嵌套图表规格 / 集合型字段 / 两轮,逐字段全等", async () => {
    const turns = [0, 1].map((i) => ({
      i,
      question: `第${i + 1}问:按地区统计客户数 🧭 «gbc»`,
      askedAt: `2026-09-13T0${i}:00:00.000Z`,
      elapsedMs: 1234 + i,
      result: {
        answer: `华东最多,占比 41.7%(第${i + 1}轮)—— 含'半角引号'与 emoji 🎯`,
        sql: "select region, count(*) as n from public.customers /* gbc */ group by 1 order by 2 desc",
        columns: ["region", "n", "ratio", "note", "code"],
        rows: [
          ["华东", "1204", "0.417", null, "007"],
          ["华南", "882", "-0.5", "含 null 的下一行", "080"],
          ["西北", "0", "0.0", "", "000"],
        ],
        rowCount: 3,
        chart: { type: "bar", x: "region", y: ["n"], opts: { stack: false, legend: { show: true, pos: "top" } } },
        steps: [{ k: "retrieve", detail: "命中 2 张表" }, { k: "gen-sql", detail: "生成 SQL" }, { k: "exec", detail: "执行" }],
        usage: { inputTokens: 100 + i, outputTokens: 200 + i },
        maskedColumns: [],
        matchedTables: [{ fqn: "bgp-redshift.dev.public.customers", why: "语义命中" }, { fqn: "bgp-redshift.dev.public.orders", why: "join 需要" }],
        usedContext: [{ name: "客户数口径", body: "去重后的客户主键计数" }],
        retrievalNote: "两张表",
      },
      error: null,
    }));
    await putCardBody(nonHome, SUB, body({ turns: turns as any, title: "刁钻值 🧭 «gbc»" }));
    const got = await getCardBody(nonHome, SUB, CARD);
    expect(got?.turns).toEqual(turns);
    expect(got?.title).toBe("刁钻值 🧭 «gbc»");
    // 前导 0 仍是字符串、null 仍是 null、负小数原样(JSON 往返没把它们弄坏)
    const rows = (got?.turns[1].result as any).rows as unknown[][];
    expect(rows[0][4]).toBe("007");
    expect(rows[0][3]).toBeNull();
    expect(rows[1][2]).toBe("-0.5");
  });

  it("对象不存在 ⇒ null(指针悬空由调用方按「清理未完成」呈现)", async () => {
    expect(await getCardBody(nonHome, SUB, CARD)).toBeNull();
  });

  it("🔴🔴 AccessDenied 等**不是**「不存在」⇒ 必须原样上抛(绝不把「读不到」当成「没有」)", async () => {
    const { s3ClientFor } = (await import("@/lib/exec-env/target-clients")) as any;
    (s3ClientFor as any).mockImplementationOnce(async () => ({
      send: async () => { throw Object.assign(new Error("AccessDenied"), { name: "AccessDenied" }); },
    }));
    await expect(getCardBody(nonHome, SUB, CARD)).rejects.toThrow(/AccessDenied/);
  });

  it("正文里的 cardId 与请求的不一致 ⇒ 拒(串卡比读不到更危险)", async () => {
    const loc = cardBodyLocation(nonHome, SUB, CARD);
    store.set(`${loc.bucket}/${loc.key}`, JSON.stringify(body({ cardId: "01OTHER" })));
    await expect(getCardBody(nonHome, SUB, CARD)).rejects.toThrow(/与请求的/);
  });

  it("不是合法 JSON ⇒ 拒", async () => {
    const loc = cardBodyLocation(nonHome, SUB, CARD);
    store.set(`${loc.bucket}/${loc.key}`, "{ 半个对象");
    await expect(getCardBody(nonHome, SUB, CARD)).rejects.toThrow(/不是合法 JSON/);
  });

  it("删正文:成功 / 本来就没有 ⇒ true;🔴 真失败 ⇒ **false**(绝不吞成 true 把「清理失败」说成「已清理」)", async () => {
    await putCardBody(nonHome, SUB, body());
    expect(await deleteCardBody(nonHome, SUB, CARD, [])).toBe(true);
    expect(await deleteCardBody(nonHome, SUB, CARD, [])).toBe(true); // NoSuchKey = 已清理
    const { s3ClientFor } = (await import("@/lib/exec-env/target-clients")) as any;
    (s3ClientFor as any).mockImplementationOnce(async () => ({
      send: async () => { throw Object.assign(new Error("AccessDenied"), { name: "AccessDenied" }); },
    }));
    expect(await deleteCardBody(nonHome, SUB, CARD, [])).toBe(false);
  });

  // ── 「标题也留区」(用户 2026-09-12 拍板;否掉了「标题存中央」那个默认)──
  it("🔴 标题只存在区域侧:写正文时**同时**写一个轻量 head.json(列表唯一的标题来源)", async () => {
    const r = await putCardBody(nonHome, SUB, body());
    const headKey = cardHeadKey(SUB, CARD);
    expect(headKey).toBe(`${CARD_BODY_PREFIX}/${SUB}/${CARD}/head.json`);
    const raw = store.get(`${r.bucket}/${headKey}`);
    expect(raw, "没写 head ⇒ 列表里这张卡永远没有标题,而没人会想到查这里").toBeTruthy();
    const head = JSON.parse(raw as string);
    expect(head).toMatchObject({ v: CARD_BODY_VERSION, cardId: CARD, title: "华东区客户分布", turnCount: 1 });
    // head 是**轻量**的:不许把数据行塞进去(否则等于把结果搬进了一个「列表都会读」的对象)
    expect(JSON.stringify(head)).not.toContain("1204");
  });

  it("读 head:拿得到标题;不存在 ⇒ null(调用方据此显示占位,**不是**把卡片丢掉)", async () => {
    expect(await getCardHead(nonHome, SUB, CARD)).toBeNull();
    await putCardBody(nonHome, SUB, body());
    expect((await getCardHead(nonHome, SUB, CARD))?.title).toBe("华东区客户分布");
  });

  it("🔴 标题校验在区域侧(它只存在这里):空 / 超 80 字都拒,并说清超了多少", () => {
    expect(() => assertTitle("")).toThrow(/标题不能为空/);
    expect(() => assertTitle("   ")).toThrow(/标题不能为空/);
    expect(() => assertTitle("x".repeat(MAX_TITLE_LEN + 3))).toThrow(/83 字.*上限 80 字.*超出 3 字/);
    expect(assertTitle("  华东区  ")).toBe("华东区");
  });

  it("写正文时标题非法 ⇒ 拒,且**一个字节都没写出去**", async () => {
    await expect(putCardBody(nonHome, SUB, body({ title: "" }))).rejects.toThrow(/标题不能为空/);
    expect(sent.length).toBe(0);
  });

  it("🔴 删卡要把**两个**对象都删(少删一个就残留一个带标题的孤儿 head)", async () => {
    const r = await putCardBody(nonHome, SUB, body());
    expect(store.has(`${r.bucket}/${r.key}`)).toBe(true);
    expect(store.has(`${r.bucket}/${cardHeadKey(SUB, CARD)}`)).toBe(true);
    expect(await deleteCardBody(nonHome, SUB, CARD, [])).toBe(true);
    expect(store.has(`${r.bucket}/${r.key}`)).toBe(false);
    expect(store.has(`${r.bucket}/${cardHeadKey(SUB, CARD)}`), "head 没删掉 ⇒ 标题还留在那个区域").toBe(false);
  });

  it("🔴 结构性:本文件不许出现主控区默认值 / 模块级 S3 客户端(WP-17 元缺陷的同款防护)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../cards-body-store.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1"); // 先剥注释
    expect(src).not.toMatch(/HOME_TARGET_ID/);
    expect(src).not.toMatch(/targetId\s*\?\s*:/);          // 落点不许是可选参数
    expect(src).not.toMatch(/new\s+S3Client\s*\(/);        // 客户端一律经 s3ClientFor(region)
    expect(src).toMatch(/resolveTargetGlue\(/);            // 落点解析走单一作者
  });

  // @kf-batch 50-WP31-place-first-class —— 序 31 第二刀 ②:正文落点的唯一作者记落点决策。第四十轮 observe:卡片正文的
  //   S3 Get / Put 落在该区桶上(没越区),却因读侧只经 getTargetRaw(看得见即可,不记决策)⇒ 未归因。
  describe("🔴 cardBodyLocation 记落点决策(读 / 写 / 删正文、head、快照都经它 ⇒ 一处记齐)", () => {
    const decided = () => decisionsOfCurrentRequest().decisions.filter((d) => d.via === CARD_BODY_PLACE_VIA).map((d) => d.targetId);
    // 🔴 账本按「请求存储对象」挂(WeakMap)⇒ 替身必须是同一个对象,每次回新对象 = 每次都是新请求
    beforeEach(() => {
      const store = { headers: new Headers() };
      __setRequestStoreProvider(() => store);
    });
    afterEach(() => __setRequestStoreProvider(null));

    it("非 home / home 各记自己的 targetId", () => {
      cardBodyLocation(nonHome, SUB, CARD);
      cardBodyLocation(home, SUB, CARD);
      expect(decided()).toEqual(["tgt_use1_a", "tgt_home"]);
    });

    it("写正文 + 读正文 + 读 head + 删:每一步的决策都是该 target(一张卡片的全部 S3 调用都归得了属)", async () => {
      await putCardBody(nonHome, SUB, body());
      await getCardBody(nonHome, SUB, CARD);
      await getCardHead(nonHome, SUB, CARD);
      await deleteCardBody(nonHome, SUB, CARD, []);
      const ids = decided();
      expect(ids.length).toBeGreaterThanOrEqual(4);
      expect(new Set(ids)).toEqual(new Set(["tgt_use1_a"]));
    });

    it("描述符缺桶 ⇒ 抛在记账之前(拒掉的落点不是落点)", () => {
      const broken = { ...nonHome, resources: { ...nonHome.resources, datalakeBucket: undefined } };
      expect(() => cardBodyLocation(broken as any, SUB, CARD)).toThrow();
      expect(decided()).toEqual([]);
    });
  });
});
