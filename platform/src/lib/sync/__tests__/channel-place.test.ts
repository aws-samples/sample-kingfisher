// 「哪个同步通道在哪个执行区可用」的唯一规则(lib/sync/channel-place.ts)与「禁止跨区取数」的判法(lib/sync/cross-region-source.ts)。
//   纯函数判据,零 mock。规则的三个消费者(通道推荐路由 / 新建与修改保存 / Copilot 建草稿)的接线在
//   app/api/sync/__tests__/channel-place-route.test.ts。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyChannelPlace, channelUnavailableReason, CHANNEL_NOT_AVAILABLE_CODE, type ChannelRecommendation } from "@/lib/sync/channel-place";
import { crossRegionSource } from "@/lib/sync/cross-region-source";
import { recommendChannel } from "@/lib/sync/sync-service";

const HOME = "tgt_home";
const WEST = "tgt_usw2";

describe("通道 × 执行区:规则表", () => {
  it("Glue 与 DMS 每个执行区都提供;Zero-ETL 只在主控区,执行区给出原因并指路改用哪个通道", () => {
    for (const t of [HOME, WEST]) {
      expect(channelUnavailableReason("glue", t)).toBeNull();
      expect(channelUnavailableReason("dms", t)).toBeNull();
    }
    expect(channelUnavailableReason("zero-etl", HOME)).toBeNull();
    const why = channelUnavailableReason("zero-etl", WEST);
    expect(why).toContain("只在主控区提供");
    expect(why).toContain(WEST);
    expect(why).toContain("DMS");
    expect(why).toContain("Glue");
  });

  it("不认识的通道 / 空值 ⇒ null(通道合不合法由各自的校验管,这里只管落点);继承来的键名不算通道", () => {
    for (const v of ["flink-cdc", "", undefined, null, 7, "constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(channelUnavailableReason(v, WEST)).toBeNull();
      expect(channelUnavailableReason(v, HOME)).toBeNull();
    }
  });

  it("按通道名取规则:不拿名字做对象下标,查出来的值调用前先核是函数(名字来自请求体;静态扫描把「按请求里的名字取出来就调用」判为未校验的动态调用)", () => {
    const src = readFileSync(resolve(__dirname, "../channel-place.ts"), "utf8");
    expect(src).not.toMatch(/CHANNEL_PLACE_RULES\s*\[/);
    expect(src).toMatch(/new Map\(Object\.entries\(CHANNEL_PLACE_RULES\)\)/);
    // 调用点只有一处,且紧跟在「不是函数就返回」之后(真值判断不算校验:扫描器只认 typeof … "function")。
    expect(src).toMatch(/if \(typeof rule !== "function"\) return null;\n\s*return rule\(targetId\);/);
    expect(src.match(/\brule\(/g)).toHaveLength(1);
  });

  it("错误码是登记在案的那一个", () => {
    expect(CHANNEL_NOT_AVAILABLE_CODE).toBe("CHANNEL_NOT_AVAILABLE_IN_REGION");
    const codes = readFileSync(resolve(__dirname, "../../api-response.ts"), "utf8");
    expect(codes).toContain('"CHANNEL_NOT_AVAILABLE_IN_REGION"');
  });

  it("规则表以通道闭合清单为键(类型上新增通道不填规则即编译错);每个通道都有一条", () => {
    const src = readFileSync(resolve(__dirname, "../channel-place.ts"), "utf8");
    expect(src).toMatch(/const CHANNEL_PLACE_RULES: Record<SyncChannel, \(targetId: string\) => string \| null> = \{/);
    for (const ch of ["glue", "dms", "zero-etl"]) expect(channelUnavailableReason(ch, HOME)).toBeNull();
  });
});

describe("通道推荐按数据源所在的执行区再过一遍", () => {
  const incremental = () => recommendChannel("mysql", "redshift", "incremental") as ChannelRecommendation;

  it("前提:MySQL → Redshift 增量,不看落点时推荐的是 Zero-ETL(所以执行区必须把它换掉)", () => {
    const rec = incremental();
    expect(rec.recommended).toBe("zero-etl");
    expect(rec.options.find((o) => o.channel === "dms")?.supported).toBe(true);
  });

  it("主控区 ⇒ 原样(逐字不变)", () => {
    expect(applyChannelPlace(incremental(), HOME)).toEqual(incremental());
  });

  it("执行区 ⇒ Zero-ETL 标不支持并写明原因,推荐改成 DMS;其余选项不动;不改入参", () => {
    const input = incremental();
    const frozen = JSON.parse(JSON.stringify(input));
    const out = applyChannelPlace(input, WEST);
    expect(input).toEqual(frozen);
    expect(out.recommended).toBe("dms");
    const z = out.options.find((o) => o.channel === "zero-etl")!;
    expect(z).toMatchObject({ supported: false, recommended: false });
    expect(z.reason).toContain("只在主控区提供");
    expect(out.options.find((o) => o.channel === "dms")).toMatchObject({ supported: true, recommended: true });
    expect(out.options.filter((o) => o.recommended)).toHaveLength(1);
    const glueBefore = frozen.options.find((o: { channel: string }) => o.channel === "glue");
    expect(out.options.find((o) => o.channel === "glue")).toEqual(glueBefore);
  });

  it("被换掉的推荐没有 DMS 可接 ⇒ 改推第一个仍支持的;一个都不支持 ⇒ 推荐为空(不硬塞一个用不了的)", () => {
    const noDms: ChannelRecommendation = { recommended: "zero-etl", options: [
      { channel: "glue", supported: true, recommended: false, reason: "g" },
      { channel: "zero-etl", supported: true, recommended: true, reason: "z" },
      { channel: "dms", supported: false, recommended: false, reason: "d" },
    ] };
    expect(applyChannelPlace(noDms, WEST).recommended).toBe("glue");
    const none: ChannelRecommendation = { recommended: "zero-etl", options: [
      { channel: "glue", supported: false, recommended: false, reason: "g" },
      { channel: "zero-etl", supported: true, recommended: true, reason: "z" },
    ] };
    const out = applyChannelPlace(none, WEST);
    expect(out.recommended).toBe("");
    expect(out.options.some((o) => o.recommended)).toBe(false);
  });

  it("执行区、推荐的本来就不是 Zero-ETL(全量 ⇒ Glue;实时 ⇒ DMS)⇒ 推荐不变,只把 Zero-ETL 标成该区不提供", () => {
    for (const mode of ["full", "realtime"]) {
      const rec = recommendChannel("mysql", "redshift", mode) as ChannelRecommendation;
      const out = applyChannelPlace(rec, WEST);
      expect(out.recommended).toBe(rec.recommended);
      expect(out.options.find((o) => o.channel === "zero-etl")?.supported).toBe(false);
    }
  });
});

describe("禁止跨区取数:数据源必须在任务绑定的执行区", () => {
  it("同区 ⇒ null(新任务 targets[] / 存量顶层 targetId / 两边都没有章 = 都在主控区)", () => {
    expect(crossRegionSource({ targets: [WEST] }, { ownerTargetId: WEST })).toBeNull();
    expect(crossRegionSource({ targetId: WEST }, { ownerTargetId: WEST })).toBeNull();
    expect(crossRegionSource({}, {})).toBeNull();
    expect(crossRegionSource({ targets: [HOME] }, {})).toBeNull();
    expect(crossRegionSource({ targets: [HOME, WEST] }, { ownerTargetId: WEST })).toBeNull();
  });

  it("不同区 ⇒ 回两边的事实(哪边在哪)", () => {
    expect(crossRegionSource({ targets: [HOME] }, { ownerTargetId: WEST })).toEqual({ datasourceOwner: WEST, bound: [HOME] });
    expect(crossRegionSource({ targets: [WEST] }, {})).toEqual({ datasourceOwner: HOME, bound: [WEST] });
    expect(crossRegionSource({}, { ownerTargetId: WEST })).toEqual({ datasourceOwner: WEST, bound: [HOME] });
  });

  it("数据源的执行环境标记非法 ⇒ 抛(不当成主控区放过)", () => {
    expect(() => crossRegionSource({ targets: [HOME] }, { ownerTargetId: "not a target" })).toThrow();
  });

  it("三处调用点(批同步启动 / DMS 启动 / 修改时换源)都用这一个判法,各自不再手写比较", () => {
    const read = (rel: string) => readFileSync(resolve(__dirname, "../../../app/api/sync", rel), "utf8");
    for (const rel of ["[id]/start/route.ts", "[id]/start-realtime/route.ts", "[id]/route.ts"]) {
      const src = read(rel);
      expect(src, rel).toMatch(/crossRegionSource\(/);
      expect(src, rel).toContain('"CROSS_REGION_SOURCE"');
    }
  });
});
