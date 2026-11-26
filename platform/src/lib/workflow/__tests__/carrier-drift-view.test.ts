// **呈现面**(B2)的判据。机制在库里而界面上看不见 = 写了等于没写(本仓的元 bug),
// 所以这一组既钉判别函数的**行为**,也钉界面**真的接到了它**。
//
// 🔴 这一组最值钱的是「只查了一半」那条:一行绑两个区、接口只回了一个区的结果时,
//   `Object.values(drift).every(ok)` 会**通过** —— 没查的那个区被邻居的绿标顺带放行。
//   同形的错本仓记过两次(字符窗口跨行拿邻居的「成功」/ 整页断言被邻居打红),
//   所以这里逐个 armed 区要答案,并且**写成行为判据**,不是文本判据。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { armedTargetsOf, carrierDriftView } from "@/lib/workflow/carrier-drift-view";

const SRC = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");
/** 🔴 负向文本断言前必先剥注释(本仓累计栽过多次:注释里解释「不许这么写」反而把自己打红)。 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

const ARN = "arn:aws:mwaa:us-east-1:x:workflow/x";
const armedRow = (targets: string[], drift?: Record<string, { state: string; reason?: string }>) => ({
  deployments: Object.fromEntries(targets.map((t) => [t, { workflowArn: ARN }])),
  ...(drift ? { carrierDrift: drift } : {}),
});

describe("B2 ① 判别函数:五态各自成立(行为判据)", () => {
  it("🔴 没有载体 ⇒ n/a(「落后」这个问题不成立,不是「最新」也不是「未检查」)", () => {
    expect(carrierDriftView({}).kind).toBe("n/a");
    expect(carrierDriftView({ deployments: {} }).kind).toBe("n/a");
    // 🔴 「产物」的口径只认 workflowArn:有 deployments 这个键但没发出产物,仍然是没载体
    expect(carrierDriftView({ deployments: { tgt_home: {} } }).kind).toBe("n/a");
    expect(armedTargetsOf({ deployments: { a: { workflowArn: ARN }, b: {} } })).toEqual(["a"]);
  });

  it("🔴🔴 有载体但压根没查 ⇒ unchecked,**绝不许是 ok**(「没查」≠「最新」)", () => {
    const v = carrierDriftView(armedRow(["tgt_home"]));
    expect(v.kind, "没带 withDrift 时把「没查」显示成了别的态").toBe("unchecked");
    expect(carrierDriftView({ ...armedRow(["tgt_home"]), carrierDrift: {} }).kind).toBe("unchecked");
  });

  it("🔴🔴 **只查了一半** ⇒ unchecked(没查的那个区不许被邻居的绿标放行)", () => {
    // 绑两个区,接口只回了 home 的答案,而 home 是 ok —— 最容易假绿的形状
    const v = carrierDriftView(armedRow(["tgt_home", "tgt_usw2_a"], { tgt_home: { state: "ok" } }));
    expect(
      v.kind,
      "🔴 一个区 ok、另一个区**压根没答案**却判成了 " + v.kind +
        " ⇒ 那个区带着旧定义在跑而界面是绿的(本仓「拿邻居的成功给自己放行」同形)"
    ).toBe("unchecked");
    expect(v.kind === "unchecked" && v.missingAnswerFor).toEqual(["tgt_usw2_a"]);
    // 空字符串 / 缺 state 字段也算没答案(不许被 truthy 判断放过)
    expect(carrierDriftView(armedRow(["a", "b"], { a: { state: "ok" }, b: { state: "" } })).kind).toBe("unchecked");
  });

  it("🔴 每个区都真比过且一致 ⇒ ok", () => {
    const v = carrierDriftView(armedRow(["a", "b"], { a: { state: "ok" }, b: { state: "ok" } }));
    expect(v.kind).toBe("ok");
    expect(v.kind === "ok" && v.armed).toEqual(["a", "b"]);
  });

  it("🔴 任一区落后 ⇒ stale,且点名**是哪几个区**(一次发布可能只有一个区旧了)", () => {
    const v = carrierDriftView(armedRow(["a", "b"], { a: { state: "ok" }, b: { state: "stale" } }));
    expect(v.kind).toBe("stale");
    expect(v.kind === "stale" && v.staleTargets).toEqual(["b"]);
    // 🔴 坏消息优先,但**不许把别的区的不确定藏掉**:完整状态要一并带出去
    const mixed = carrierDriftView(armedRow(["a", "b"], { a: { state: "unknown" }, b: { state: "stale" } }));
    expect(mixed.kind).toBe("stale");
    expect(mixed.kind === "stale" && mixed.states).toEqual({ a: "unknown", b: "stale" });
  });

  it("🔴🔴 判不了的三态都不许变成 ok,一律 indeterminate", () => {
    for (const st of ["unknown", "missing", "unsupported"]) {
      const v = carrierDriftView(armedRow(["a"], { a: { state: st, reason: "服务没回定义" } }));
      expect(v.kind, `state=${st} 被判成了 ${v.kind} ⇒ 把「判不了」说成了结论`).toBe("indeterminate");
    }
    // 混了一个 ok 也不许被 ok 带绿
    const v = carrierDriftView(armedRow(["a", "b"], { a: { state: "ok" }, b: { state: "missing" } }));
    expect(v.kind, "一个 ok + 一个 missing 判成了 " + v.kind).toBe("indeterminate");
    expect(v.kind === "indeterminate" && v.reasons.length >= 0).toBe(true);
  });

  it("🔴 判据自己有判别力:五态**都**能被这个函数产出(少一态就说明有出口是死的)", () => {
    const got = new Set([
      carrierDriftView({}).kind,
      carrierDriftView(armedRow(["a"])).kind,
      carrierDriftView(armedRow(["a"], { a: { state: "ok" } })).kind,
      carrierDriftView(armedRow(["a"], { a: { state: "stale" } })).kind,
      carrierDriftView(armedRow(["a"], { a: { state: "unknown" } })).kind,
    ]);
    expect([...got].sort()).toEqual(["indeterminate", "n/a", "ok", "stale", "unchecked"]);
  });
});

// 2026-11-25 真环境:同步任务 / 平台动作的定时停用之后,调度服务里的载体真删了,行里的发布记录却留着
//   ⇒ 调度配置页对这条已停用的行显示「无法确认」(一句英文 Resource not found)或「载体需重新发布」+ 一个点了会报错的「重新发布」。
//   之后停用的行记录随停用一起清;之前留下的行靠这条规则:定时已停用 + 服务确认每个有记录的区都没有载体 ⇒ 没有载体。
describe("B2 ①b 过期的发布记录不是载体(定时已停用 + 服务确认没有载体 ⇒ n/a)", () => {
  const stale = (itemType: string | undefined, scheduleEnabled: boolean | undefined, drift: Record<string, { state: string; reason?: string }>) => ({
    ...armedRow(Object.keys(drift), drift),
    ...(itemType === undefined ? {} : { itemType }),
    ...(scheduleEnabled === undefined ? {} : { scheduleEnabled }),
  });

  it("🔴 同步任务 / 治理任务 / 问数卡片 / 造数:已停用且每个有记录的区都是 missing ⇒ n/a", () => {
    for (const t of ["sync", "governance", "genbi-card", "seed"]) {
      expect(carrierDriftView(stale(t, false, { tgt_home: { state: "missing" } })).kind, t).toBe("n/a");
      // 从没写过启用字段的存量行(没有这个属性)与显式 false 同一口径
      expect(carrierDriftView(stale(t, undefined, { tgt_home: { state: "missing" } })).kind, t).toBe("n/a");
      expect(carrierDriftView(stale(t, false, { a: { state: "missing" }, b: { state: "missing" } })).kind, t).toBe("n/a");
    }
  });

  it("🔴🔴 定时还开着而载体不在 ⇒ 真问题,不许吞成 n/a(到点不会触发,必须说出来)", () => {
    const v = carrierDriftView(stale("sync", true, { tgt_home: { state: "missing", reason: "该区没有这个工作流的载体" } }));
    expect(v.kind).toBe("indeterminate");
    expect(v.kind === "indeterminate" && v.reasons).toEqual(["该区没有这个工作流的载体"]);
  });

  it("🔴 工作流不适用:已发布的工作流不开定时也有载体,载体不在要如实说", () => {
    expect(carrierDriftView(stale("workflow", false, { tgt_home: { state: "missing" } })).kind).toBe("indeterminate");
    // 没带行类型(别的调用方)⇒ 不套这条规则
    expect(carrierDriftView(stale(undefined, false, { tgt_home: { state: "missing" } })).kind).toBe("indeterminate");
  });

  it("🔴 只认 missing:已停用但读得到载体(还在 / 落后 / 判不了)⇒ 照旧各归各态", () => {
    expect(carrierDriftView(stale("sync", false, { tgt_home: { state: "stale" } })).kind).toBe("stale");
    expect(carrierDriftView(stale("sync", false, { tgt_home: { state: "ok" } })).kind).toBe("ok");
    expect(carrierDriftView(stale("sync", false, { tgt_home: { state: "unknown" } })).kind).toBe("indeterminate");
    // 一个区没有、另一个区还在 ⇒ 不是「没有载体」
    expect(carrierDriftView(stale("sync", false, { a: { state: "missing" }, b: { state: "ok" } })).kind).toBe("indeterminate");
    // 没查全照旧是「未检查」
    expect(carrierDriftView({ ...armedRow(["a", "b"], { a: { state: "missing" } }), itemType: "sync", scheduleEnabled: false }).kind).toBe("unchecked");
  });
});

describe("B2 ② 接线:界面真的接到了那个唯一作者", () => {
  const panel = strip(read("components/monitor/SchedulePanel.tsx"));

  it("🔴 在**调用位置**用了 carrierDriftView(不是只 import)", () => {
    expect(panel, "SchedulePanel 没在调用位置用 carrierDriftView").toMatch(/carrierDriftView\(\s*r\s*\)/);
  });

  // 🔴 这一条我第一版写成「禁止出现 `=== "stale"` 这个字面」,当场被自己的**正确**代码打红
  //   (`v.kind === "stale"` 判的是唯一作者回的 kind,合法)。本仓第 4 条纪律的又一例:
  //   判据要钉**事实**、要闭合式地说「唯一允许的形态是什么」,别去枚举违规字面。
  //   这里的事实是:**drift 的原始数据只许经由那个函数**,界面一次也不许自己碰。
  it("🔴🔴 界面一次也不许自己碰 drift 原始数据(碰了 ⇒ 五态又会被揉成两态)", () => {
    // 唯一允许的形态:整行交给 carrierDriftView,之后只看它回的 kind
    const reads = panel.match(/\b(?:r|record|row|x)\.carrierDrift\b/g) || [];
    expect(
      reads,
      `🔴 SchedulePanel 里直接读了行上的 carrierDrift(${reads.length} 处)⇒ 请把整行交给 carrierDriftView`
    ).toEqual([]);
    // 也不许自己对那份数据做聚合(every/some/Object.values 都是「自己判」的形状)
    for (const bad of [/carrierDrift\s*\|\|\s*\{\}/, /carrierDrift\s*\)?\s*\.\s*(every|some)\b/, /Object\.(values|keys)\(\s*\w+\.carrierDrift/]) {
      expect(bad.test(panel), `🔴 界面自己聚合了 drift(${bad})⇒ 绕过唯一作者`).toBe(false);
    }
    // 判据自己有判别力:那个唯一作者确实在这份文件里被调用了(否则上面两条在空转)
    expect(panel, "判据在空转:界面压根没调 carrierDriftView").toMatch(/carrierDriftView\(/);
  });

  it("🔴 五个出口在界面上都有**各自的** data-testid(缺一个 ⇒ 无头判据看不见那一态)", () => {
    for (const id of ["carrier-drift-na", "carrier-drift-unchecked", "carrier-drift-ok",
                      "carrier-drift-stale", "carrier-drift-indeterminate"]) {
      expect(panel, `界面少了 ${id} 这个出口`).toContain(`data-testid="${id}"`);
    }
    // 🔴 「最新」那个绿标只许挂在 ok 那一支上:kind 判断必须出现在它之前
    expect(panel.indexOf('data-testid="carrier-drift-stale"'))
      .toBeLessThan(panel.indexOf('data-testid="carrier-drift-ok"'));
  });

  it("🔴 本面板**常开**这个开关(不开就永远是「未检查」,这一列等于没做)", () => {
    expect(panel, "SchedulePanel 的列表请求没带 withDrift=1").toMatch(/params\.set\("withDrift",\s*"1"\)/);
  });
});

describe("B2 ③ 一键重发:复用产品已有的发布通道", () => {
  const panel = strip(read("components/monitor/SchedulePanel.tsx"));

  it("🔴 两类各打**既有**接口,不自己写一遍下发", () => {
    const i = panel.indexOf("const republishCarrier");
    expect(i, "找不到 republishCarrier ⇒ 判据在空转").toBeGreaterThan(-1);
    const body = panel.slice(i, i + 1400);
    expect(body, "工作流没走既有的 publish 接口").toMatch(/\/api\/workflow\/\$\{r\.itemId\}\/publish/);
    expect(body, "同步任务没走既有的 schedule/enable 接口").toContain('"/api/schedule/enable"');
    // 🔴该缺陷的病根就是「生成有两个作者」——界面自己拼产物就是把它埋回去
    for (const bad of ["buildCarrierArtifact", "buildWorkflowTasksYaml", "generateAirflowDag"]) {
      expect(body.includes(bad), `🔴 界面自己拼载体产物(${bad})⇒ 又出现第二个作者`).toBe(false);
    }
  });

  it("🔴 逐区部分失败**不许报成功**(另一个区还带着旧定义在跑)", () => {
    const i = panel.indexOf("const republishCarrier");
    const body = panel.slice(i, i + 1400);
    expect(body, "没处理 partial ⇒ 「一个区成一个区没成」会被报成「已重新发布」").toMatch(/d\?\.partial/);
  });

  it("🔴 重发后必须**重新比一次**,别让页面留着旧结论", () => {
    const i = panel.indexOf("const republishCarrier");
    const body = panel.slice(i, i + 1400);
    expect(body, "重发后没有重新拉列表").toMatch(/fetchData\(\)/);
  });
});

describe("B2 ④ 我这一刀自己拉大的竞态窗口,同刀封上", () => {
  const panel = strip(read("components/monitor/SchedulePanel.tsx"));

  it("🔴🔴 fetchData 必须有陈旧响应守卫(withDrift 让响应从毫秒变成秒级)", () => {
    const i = panel.indexOf("const fetchData");
    expect(i, "找不到 fetchData ⇒ 判据在空转").toBeGreaterThan(-1);
    const body = panel.slice(i, panel.indexOf("const republishCarrier"));
    expect(body, "fetchData 没记序号").toMatch(/\+\+\s*seqRef\.current/);
    expect(
      body,
      "🔴 fetchData 写 state 前没丢弃陈旧响应 ⇒ 切区时晚到的旧响应会盖掉新范围的结果" +
        "(本仓「某区视角显示别的区的数仓」同一个根)"
    ).toMatch(/seq\s*!==\s*seqRef\.current\)\s*return/);
    // 写 state 必须在守卫**之后**
    expect(body.indexOf("seq !== seqRef.current")).toBeLessThan(body.indexOf("setSyncTasks("));
  });
});
