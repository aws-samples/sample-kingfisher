// @kf-batch 50-W3f-T0-T3
// 门票 T2:多区扇出的 `runGroupId` —— 形态 / 分组规则 / **接线门禁**(两条运行路由 + 两个 provider)。
//
// 🔴 接线门禁为什么是文本断言:运行路由要 mock 掉 guard / DDB / 审计 一整串才能跑,mock 一多就在测 mock;
//    而「循环前算一次、每次提交都带上」是能机械识别的形状(与 dataplane-wiring-guard 同一手法)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  RUN_GROUP_ATTR,
  RUN_GROUP_ID_PATTERN,
  isRunGroupId,
  runGroupIdFor,
  // @kf-batch 50-WP5-rungroup
  MANUAL_RUN_GROUP_PREFIX,
  SCHEDULED_RUN_GROUP_PREFIX,
  SCHEDULED_RUN_GROUP_ID_PATTERN,
  isManualRunGroupId,
  isScheduledRunGroupId,
  RUN_GROUP_STATUSES,
  RUN_GROUPS_GSI_BY_DEFINITION,
} from "@/lib/monitor/run-group";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1 ");

describe("runGroupIdFor:多区才分组", () => {
  it("单区 ⇒ undefined(行上不落属性,不是 null / 空串)", () => {
    expect(runGroupIdFor(["tgt_home"])).toBeUndefined();
    expect(runGroupIdFor([])).toBeUndefined();
  });
  it("多区 ⇒ rg_<ULID>,且两次调用**不同**(每次运行请求一个组)", () => {
    const a = runGroupIdFor(["tgt_home", "tgt_usw2_a"]);
    const b = runGroupIdFor(["tgt_home", "tgt_usw2_a"]);
    expect(a).toMatch(RUN_GROUP_ID_PATTERN);
    expect(b).toMatch(RUN_GROUP_ID_PATTERN);
    expect(a).not.toBe(b);
    expect(isRunGroupId(a)).toBe(true);
  });
  it("形态校验拒掉别的字符串(把 targetId / 项目号塞进来会被写通道拒)", () => {
    for (const bad of ["tgt_home", "proj-default", "rg_", "rg_lowercase00000000000000000", "", 12]) {
      expect(isRunGroupId(bad), String(bad)).toBe(false);
    }
  });
  it("属性名单一真值", () => {
    expect(RUN_GROUP_ATTR).toBe("runGroupId");
  });
});

describe("🔴 接线门禁:两条运行路由都「循环前算一次、每次提交都带上」", () => {
  // B-136:引擎运行的扇出循环在长操作执行体(路由算 runGroupId 后经 submitLongOp 的 params 交给执行体)
  const ROUTES: Array<[string, string]> = [
    ["app/api/etl-jobs/[id]/run/route.ts", "app/api/etl-jobs/[id]/run/route.ts"],
    ["app/api/engines/[engine]/[id]/run/route.ts", "lib/engines/long-ops.ts"],
  ];
  for (const [rel, loopFile] of ROUTES) {
    it(`${rel}`, () => {
      const src = stripComments(read(rel));
      const loopSrc = stripComments(read(loopFile));
      // @kf-batch 50-WP5-rungroup —— 允许第二个 opts 实参(`forceGroup` 给重试链用),但仍必须**恰好一次**
      const calls = src.match(/runGroupIdFor\(\s*runTargets\s*[,)]/g) ?? [];
      expect(calls.length, "必须恰好调一次(0 = 没接线;>1 = 可能在循环里算,每条 run 各拿一个值等于没分组)").toBe(1);
      // 🔴 `forceGroup` 只许由重试链驱动 —— 写成常量 true 会让**每一次单区运行**都建一个只有一个区的组
      const forced = src.match(/forceGroup:\s*([^\s}]+)/g) ?? [];
      expect(forced.length, "forceGroup 必须出现且只出现一次").toBe(1);
      expect(forced[0], "forceGroup 只能由 retryOf 驱动,不许写死").toBe("forceGroup: !!retryOf");
      const at = src.indexOf("runGroupIdFor(");
      // @kf-batch 50-WP31-place-first-class —— 扇出循环改为 forEachTargetPlace(runTargets, async (targetId) => …)(L10 唯一写法)
      const loop = loopSrc.search(/forEachTargetPlace\(\s*runTargets,\s*async \(targetId\) =>/);
      expect(loop, "找不到扇出循环 ⇒ 路由形状变了,请同步本门禁").toBeGreaterThan(0);
      if (loopFile === rel) expect(at, "runGroupIdFor 必须在扇出循环**之前**").toBeLessThan(loop);
      else expect(src, "路由必须把 runGroupId 交给执行体(长操作任务可能被另一次请求接管)").toMatch(/submitLongOp\([\s\S]*runGroupId/);
      // 循环体里的每一次提交都要带 runGroupId
      const body = loopSrc.slice(loop);
      const submits = body.match(/\{\s*runDate,\s*targetId[^}]*\}/g) ?? [];
      expect(submits.length, "循环里没找到提交调用的 opts 对象 ⇒ 形状变了,请同步本门禁").toBeGreaterThan(0);
      for (const s of submits) expect(s, `这次提交没带 runGroupId:${s}`).toContain("runGroupId");
      // 响应把它回给调用方(验收脚本 / 将来的 UI 靠它对上组)
      expect(loopSrc).toContain("...(runGroupId ? { runGroupId } : {})");
    });
  }

  it("job-service:每一处 createRunRecord 调用都把 opts.runGroupId 透传到写通道", () => {
    const src = stripComments(read("lib/etl/job-service.ts"));
    const calls = src.match(/await createRunRecord\([\s\S]*?\);/g) ?? [];
    expect(calls.length, "createRunRecord 调用数变了,请同步").toBe(4);
    for (const c of calls) expect(c, `这一处没透传 runGroupId:${c.slice(0, 80)}…`).toContain("opts.runGroupId");
    expect(src).toMatch(/putRunRecord\(\{[\s\S]*?runGroupId,[\s\S]*?\}\)/);
  });

  it("EMR provider:提交时把 opts.runGroupId 透传到 createRunRecord", () => {
    const src = stripComments(read("lib/engines/emr/provider.ts"));
    expect(src).toMatch(/createRunRecord\(j, runId, \{[^}]*\}, triggeredBy, targetId, opts\.runGroupId\)/);
    const rr = stripComments(read("lib/engines/emr/run-record.ts"));
    expect(rr).toMatch(/putRunRecord\(\{[\s\S]*?runGroupId,[\s\S]*?\}\)/);
  });
});


// @kf-batch 50-WP5-rungroup —— O2:定时确定性键这一支的形态判别(50 SPEC §1.3a S7 / §3.17.2)
describe("🔴 两种组 id 形态:靠**末尾下划线**才互不混淆(判别一律走完整正则)", () => {
  const SCHED = "rgs_0123456789abcdef01234567"; // 24 hex
  const MANUAL = "rg_01J8Z6Q2M3N4P5R6S7T8V9W0XY".slice(0, 3) + "0123456789ABCDEFGHJKMNPQRS";

  it("合法的定时键:24 位小写 hex;写通道守卫**必须放行**它", () => {
    expect(SCHED).toMatch(SCHEDULED_RUN_GROUP_ID_PATTERN);
    expect(isScheduledRunGroupId(SCHED)).toBe(true);
    // 🔴 这一条是本支最贵的接缝:守卫漏了 `rgs_` 的故障形态是「定时运行整批写不进台账」,
    //    而手动运行全绿 ⇒ 页面上看起来只有定时任务「跑了但没有历史」。
    expect(isRunGroupId(SCHED), "写通道守卫必须同时认两种形态").toBe(true);
  });

  it("长度 / 大小写 / 前缀混淆都必须拒", () => {
    for (const bad of [
      "rgs_0123456789abcdef0123456",   // 23 hex
      "rgs_0123456789abcdef012345678", // 25 hex
      "rgs_0123456789ABCDEF01234567", // 大写 hex(sha256 输出统一小写)
      "rgs_",
      "rgs_01234567-89ab-cdef-0123",
    ]) {
      expect(isScheduledRunGroupId(bad), bad).toBe(false);
      expect(isRunGroupId(bad), bad).toBe(false);
    }
  });

  it("两支互斥:手动 id 不是定时 id,定时 id 不是手动 id(前缀关系最容易写错的地方)", () => {
    expect(isManualRunGroupId(MANUAL)).toBe(true);
    expect(isScheduledRunGroupId(MANUAL), "`rg_...` 被判成定时键 ⇒ 说明用了 startsWith").toBe(false);
    expect(isManualRunGroupId(SCHED), "`rgs_...` 被判成手动键 ⇒ 说明 `rg_` 前缀吞掉了它").toBe(false);
    // runGroupIdFor 产出的永远是手动支
    const g = runGroupIdFor(["tgt_home", "tgt_usw2_a"]) as string;
    expect(isManualRunGroupId(g)).toBe(true);
    expect(isScheduledRunGroupId(g)).toBe(false);
    expect(g.startsWith(MANUAL_RUN_GROUP_PREFIX)).toBe(true);
    // 🔴 两个前缀互不为前缀,**全靠末尾那个下划线**(`rgs_` 的第 3 个字符是 `s` 而不是 `_`)。
    //    谁把常量写成 `rg` / `rgs`(丢掉下划线)就会立刻重新混淆 ⇒ 把这条性质钉住。
    expect(SCHEDULED_RUN_GROUP_PREFIX.startsWith(MANUAL_RUN_GROUP_PREFIX)).toBe(false);
    for (const pre of [MANUAL_RUN_GROUP_PREFIX, SCHEDULED_RUN_GROUP_PREFIX]) {
      expect(pre.endsWith("_"), `前缀 ${pre} 丢了分隔下划线 ⇒ 两支会互相吞`).toBe(true);
    }
  });

  it("状态词表:穷举、无重复、且两对刻意不合并的态都在", () => {
    expect(new Set(RUN_GROUP_STATUSES).size, "词表有重复项").toBe(RUN_GROUP_STATUSES.length);
    expect([...RUN_GROUP_STATUSES].sort()).toEqual(
      ["cancelled", "failed", "partial-failed", "running", "submitting", "succeeded"]
    );
  });

  it("GSI 名单一真值(写死字符串会与 infra 漂移)", () => {
    expect(RUN_GROUPS_GSI_BY_DEFINITION).toBe("byDefinition");
  });
});

// @kf-batch 50-WP5-rungroup —— O2 步 3:两条运行路由的接线门禁
describe("🔴 O2 接线:组行**先建**(严格) + 逐 target 记账(尽力),两条路由同一形状", () => {
  // B-136:engine-job 的扇出循环 / 逐 target 记账在长操作执行体 lib/engines/long-ops.ts;建组行 / 定义版本仍在路由,经 submitLongOp 的 params 交给执行体
  const ROUTES: Array<[string, string, string]> = [
    ["app/api/etl-jobs/[id]/run/route.ts", "etl-job", "app/api/etl-jobs/[id]/run/route.ts"],
    ["app/api/engines/[engine]/[id]/run/route.ts", "engine-job", "lib/engines/long-ops.ts"],
  ];
  for (const [rel, kind, loopFile] of ROUTES) {
    it(`${rel}(definitionKind = ${kind})`, () => {
      const src = stripComments(read(rel));
      const loopSrc = stripComments(read(loopFile));
      const sameFile = loopFile === rel;
      // @kf-batch 50-WP31-place-first-class —— 扇出循环改为 forEachTargetPlace(runTargets, async (targetId) => …)(L10 唯一写法)
      const loop = loopSrc.search(/forEachTargetPlace\(\s*runTargets,\s*async \(targetId\) =>/);
      expect(loop, "找不到扇出循环 ⇒ 路由形状变了,请同步本门禁").toBeGreaterThan(0);

      // ① 建组行:恰好一次,且在循环之前
      const opens = src.match(/await openRunGroupIfFanout\(\{/g) ?? [];
      expect(opens.length, "0 = 没接线;>1 = 可能在循环里建,等于每个区各建一个组").toBe(1);
      const openAt = src.indexOf("await openRunGroupIfFanout({");
      if (sameFile) expect(openAt, "建组行必须在扇出循环**之前**").toBeLessThan(loop);
      else expect(src, "路由先建组行再 submitLongOp,并把 runGroupId 交给执行体").toMatch(/openRunGroupIfFanout\(\{[\s\S]*submitLongOp\([\s\S]*runGroupId/);

      // ② definitionKind 必须与这条路由的资源种类一致(写串了会把组归到另一类定义下)
      const openCall = src.slice(openAt, src.indexOf("});", openAt));
      expect(openCall).toContain(`definitionKind: "${kind}"`);
      expect(openCall, "requestedTargets 必须是本次真正要跑的那批").toContain("requestedTargets: runTargets");
      expect(openCall, "归属必须走 resolveRunStamp 单一作者,不许自己 `job.projectId || …`").toContain("resolveRunStamp(job).projectId");

      // ③ 🔴 写失败必须**返回错误响应**,不许 fail-open 继续往下跑(E-167)
      const afterOpen = sameFile ? src.slice(openAt, loop) : src.slice(openAt);
      expect(afterOpen, "组行写失败必须经单一作者映射成响应并 return").toContain("runGroupWriteErrorResponse(e)");
      expect(afterOpen).toMatch(/if \(r\) return r;/);
      expect(afterOpen, "不许把写失败吞掉继续跑").not.toMatch(/catch \([^)]*\) \{\s*\}/);

      // ④ 记账:成功与失败两支各一次,都在循环里
      const body = loopSrc.slice(loop);
      const notes = body.match(/await noteFanoutResult\(runGroupId, targetId, /g) ?? [];
      expect(notes.length, "成功支与失败支各要记一次(少一支 = 组里少一个区且没人知道为什么)").toBe(2);
      expect(body).toContain("{ runId: (res as { runId?: string }).runId, definitionVersion: defVersion }");
      expect(body).toMatch(/\{ reason: String\(e\?\.message \?\? e\)/);

      // ⑤ 记账没记上要如实回报,不许假装完整
      expect(loopSrc).toContain("...(ledgerWarnings.length ? { groupLedgerIncomplete: ledgerWarnings } : {})");

      // ⑥ E-168:定义版本必须**循环之前**算一次并带给记账(放循环里会对同一定义连查 N 遍)
      const dv = src.indexOf("const defVersion =");
      expect(dv, "没算定义版本 ⇒ 组页面「定义版本」那一列永远是「-」(写了没接上)").toBeGreaterThan(-1);
      if (sameFile) expect(dv).toBeLessThan(loop);
      expect(src).toContain("definitionVersion: defVersion");
      // 读不到就不写,不许编一个 0(会显示成「v0」骗人)
      expect(src).toContain("catch(() => undefined)");
    });
  }

  it("🔴 「组台账写不进去」的 503 只许 `lib/monitor/run-group-http.ts` 一处构造(同族分类缺陷一天修过三次)", () => {
    const out = execFileSync(
      "grep",
      ["-rl", "run-group-ledger-unavailable", "--include=*.ts", "--include=*.tsx", SRC],
      { encoding: "utf8" }
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((f) => f.replace(SRC + "/", ""))
      .filter((f) => !f.includes("__tests__"))
      .sort();
    expect(out).toEqual(["lib/monitor/run-group-http.ts"]);
  });
});
