// 🔴🔴 **「按时跑一次平台动作」的合同**:白名单 = 安全边界;命令形状 = python/TS 两侧同源。
//
// 【这组判据钉五件事】
//   ① 白名单是**闭合式**的:每一条都必须写清走哪个产品路由、服务哪一类能力、
//      以及**为什么可以被无人值守触发** —— 少任何一项就不许进清单(防「顺手加一个动作」);
//   ② 白名单外的动作**一律不是合法命令**(`parseActionCommand` 直接回 null);
//   ③ 形态 fail-closed:缺字段 / 状态非法 / 不是对象 ⇒ null,**不许猜**
//      (本仓的案底:非 home 数仓落点猜错不会报错,而是「看起来正常地连到了别的区域」);
//   ④ 三条缺口能力都被覆盖到(`seed` / `governance` / `genbi`)—— 否则落不下来;
//   ⑤ 🔴 **不许出现危险动作**:删除 / 下线 / 停用这类不该被无人值守触发的动作不得进白名单。
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MIRROR_SOURCES } from "@/lib/exec-env/metadata-mirror-shared";
import {
  CATALOG_SYNC_SOURCES,
  GOVERNANCE_ACTION_IDS,
  CARD_REFRESH_ACTION_ID,
  SEED_ACTION_ID,
  SEED_DATASETS,
  ACTION_COMMAND_TERMINAL,
  validateActionParams,
  ACTION_COMMAND_ATTRS,
  ACTION_COMMAND_STATUSES,
  ACTION_COMMAND_TTL_DAYS,
  DISPATCHABLE_ACTIONS,
  findDispatchableAction,
  isDispatchableAction,
  parseActionCommand,
} from "@/lib/scheduler/action-commands";

const OK = {
  commandId: "01CMD0000000000000000000",
  action: "governance.catalog-sync",
  targetId: "tgt_usw2_a",
  requestedAt: "2026-09-20T10:00:00.000Z",
  status: "pending",
};

describe("平台动作命令的合同", () => {
  it("① 白名单是闭合式的:每条都要有路由 / 能力 / 「为什么可无人值守」", () => {
    expect(DISPATCHABLE_ACTIONS.length).toBeGreaterThanOrEqual(3);
    for (const a of DISPATCHABLE_ACTIONS) {
      expect(a.id, "动作缺 id").toMatch(/^[a-z][a-z0-9.-]+$/);
      expect(a.route, `${a.id} 没写它走哪个产品路由 ⇒ 业务逻辑可能被在别处重写`).toMatch(/^\/api\//);
      expect(a.capability, `${a.id} 没说它服务哪一类能力 ⇒ 与三维矩阵对不上`).toBeTruthy();
      expect(
        (a.whyUnattended || "").length,
        `${a.id} 没写「为什么可以被无人值守触发」—— 这一栏是拦「顺手加一个动作」的那道门`
      ).toBeGreaterThanOrEqual(10);
      expect(a.label.length).toBeGreaterThanOrEqual(2);
    }
    // id 不许重复(重复 = 两条命令同名,消费端不知道该跑哪个)
    expect(new Set(DISPATCHABLE_ACTIONS.map((a) => a.id)).size).toBe(DISPATCHABLE_ACTIONS.length);
  });

  it("② 白名单外的动作一律不是合法命令(这一句就是那道边界)", () => {
    expect(isDispatchableAction("governance.catalog-sync")).toBe(true);
    for (const bad of ["", "nope", "governance.*", "../admin/exec-envs", null, undefined, 7, {}]) {
      expect(isDispatchableAction(bad as unknown), `${String(bad)} 竟然被当成可下发动作`).toBe(false);
      expect(parseActionCommand({ ...OK, action: bad })).toBeNull();
    }
    expect(findDispatchableAction("nope")).toBeUndefined();
  });

  it("③ 形态 fail-closed:缺字段 / 状态非法 / 不是对象 ⇒ null(不许猜)", () => {
    expect(parseActionCommand(OK)).not.toBeNull();
    for (const k of ["commandId", "action", "targetId", "requestedAt"]) {
      const bad: Record<string, unknown> = { ...OK };
      delete bad[k];
      expect(parseActionCommand(bad), `缺 ${k} 竟然还能解析出命令`).toBeNull();
      expect(parseActionCommand({ ...OK, [k]: "   " }), `${k} 全是空格竟然算有值`).toBeNull();
    }
    expect(parseActionCommand({ ...OK, status: "running" })).not.toBeNull();
    expect(parseActionCommand({ ...OK, status: "weird" })).toBeNull();
    for (const bad of [null, undefined, 1, "str", []]) {
      expect(parseActionCommand(bad)).toBeNull();
    }
    // 可选字段带进来要保留(消费端要靠 runId/taskId 把结果回指到那次 run)
    const full = parseActionCommand({ ...OK, runId: "r1", taskId: "t1", projectId: "p1", params: { a: 1 } });
    expect(full).toMatchObject({ runId: "r1", taskId: "t1", projectId: "p1", params: { a: 1 } });
  });

  // 造数载体交付:原来那条「seed 不许占位」按约定改成正向断言
  //   (作者 = lib/seed/run-once#runSeedOnce;下面「路由真实存在 + 库函数真实导出 + 路由真调用它」那条同样覆盖它)。
  it("④ 三类缺口能力都覆盖到(seed / governance / genbi),且造数只有一个动作、走它自己的单一作者", () => {
    const caps = new Set(DISPATCHABLE_ACTIONS.map((a) => a.capability));
    for (const c of ["seed", "governance", "genbi"]) {
      expect(caps.has(c), `白名单里没有服务 ${c} 的动作 ⇒ 那一格的缺口关不掉`).toBe(true);
    }
    const seed = DISPATCHABLE_ACTIONS.filter((a) => a.capability === "seed");
    expect(seed.map((a) => a.id)).toEqual([SEED_ACTION_ID]);
    expect(seed[0].author).toBe("lib/seed/run-once#runSeedOnce");
    // 治理三类 + 卡片刷新 + 造数的 id 常量必须都在白名单里(页面/服务端从常量取,不手写字符串)
    for (const id of [...GOVERNANCE_ACTION_IDS, CARD_REFRESH_ACTION_ID, SEED_ACTION_ID]) expect(isDispatchableAction(id), id).toBe(true);
  });

  it("④b 造数参数:必须点名数据集(闭合词表),空 / 未知 / 多余参数一律拒", () => {
    expect(validateActionParams(SEED_ACTION_ID, { dataset: "gamedata" })).toBeNull();
    expect(validateActionParams(SEED_ACTION_ID, {})).toMatch(/点名数据集/);
    expect(validateActionParams(SEED_ACTION_ID, { dataset: "" })).toMatch(/点名数据集/);
    expect(validateActionParams(SEED_ACTION_ID, { dataset: "ecommerce" })).toMatch(/只能是 gamedata/);
    expect(validateActionParams(SEED_ACTION_ID, { dataset: "gamedata", scale: 100000 })).toMatch(/不接受这些参数:scale/);
    expect(validateActionParams(SEED_ACTION_ID, null)).toMatch(/params 必须是对象/);
    expect(SEED_DATASETS).toEqual(["gamedata"]);
  });

  it("④b 🔴 每条动作的手动路由**文件真实存在**,共用库函数**真实导出**(原来三条治理路由全写错而判据只断 /api/ 前缀)", () => {
    const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    for (const a of DISPATCHABLE_ACTIONS) {
      const routeFile = resolve(SRC, "app" + a.route, "route.ts");
      expect(existsSync(routeFile), `${a.id} 的路由 ${a.route} 不存在(找的是 ${routeFile})`).toBe(true);
      const [mod, name] = a.author.split("#");
      expect(name, `${a.id} 的 author 必须是「模块#导出名」`).toBeTruthy();
      const modFile = resolve(SRC, mod + ".ts");
      expect(existsSync(modFile), `${a.id} 的作者模块 ${mod} 不存在`).toBe(true);
      const src = readFileSync(modFile, "utf8");
      expect(new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`).test(src), `${mod} 没有导出 ${name}`).toBe(true);
      // 手动路由必须真的调用这个作者(两条路一个作者)
      expect(readFileSync(routeFile, "utf8").includes(`${name}(`), `${a.route} 没有调用 ${name} —— 手动与定时两条路不是同一个作者`).toBe(true);
    }
  });

  it("④c 参数校验 fail-closed:空输入一律拒,合法输入放行", () => {
    expect(validateActionParams("governance.quality-check", { fqns: [] })).toMatch(/至少一张表/);
    expect(validateActionParams("governance.quality-check", {})).toMatch(/至少一张表/);
    expect(validateActionParams("governance.quality-check", { fqns: ["bgp-redshift.dev.public.t"] })).toBeNull();
    expect(validateActionParams("governance.catalog-sync", { sources: [] })).toMatch(/至少一个来源/);
    expect(validateActionParams("governance.catalog-sync", { sources: ["glue", "nope"] })).toMatch(/只能是/);
    expect(validateActionParams("governance.catalog-sync", { sources: ["glue", "redshift"] })).toBeNull();
    expect(validateActionParams("governance.sensitive-scan", {})).toBeNull();
    expect(validateActionParams("governance.sensitive-scan", { schema: "a;drop" })).toMatch(/标识符/);
    expect(validateActionParams("genbi.card-refresh", { cardId: "c", ownerSub: "s" })).toMatch(/ownerUsername/);
    expect(validateActionParams("genbi.card-refresh", { cardId: "c", ownerSub: "s", ownerUsername: "u", turnIndex: -1 })).toMatch(/turnIndex/);
    expect(validateActionParams("genbi.card-refresh", { cardId: "c", ownerSub: "s", ownerUsername: "u" })).toBeNull();
    expect(validateActionParams("nope", {})).toMatch(/白名单/);
    expect(validateActionParams("governance.sensitive-scan", null)).toMatch(/对象/);
    // 每条白名单动作都必须有自己的校验分支(没写 ⇒ default 分支拒,不许放行)
    for (const a of DISPATCHABLE_ACTIONS) {
      expect(validateActionParams(a.id, {}) ?? "", `${a.id}`).not.toMatch(/没有参数校验/);
    }
    // 目录同步的来源与镜像层的来源是同一组值
    expect([...CATALOG_SYNC_SOURCES]).toEqual([...MIRROR_SOURCES]);
    expect([...ACTION_COMMAND_TERMINAL]).toEqual(["succeeded", "failed"]);
  });

  it("⑤ 🔴 危险动作不许进白名单(不该被无人值守触发的东西)", () => {
    const FORBIDDEN = ["delete", "destroy", "teardown", "unpublish", "offline", "disable", "remove", "drop", "retire"];
    for (const a of DISPATCHABLE_ACTIONS) {
      for (const w of FORBIDDEN) {
        expect(
          `${a.id} ${a.route}`.toLowerCase().includes(w),
          `动作 ${a.id} 看起来是破坏性的(命中「${w}」)—— 定时无人值守触发这类动作,` +
            `错一次就不可逆。要做必须单独拍板并给二次确认,不能塞进这张白名单`
        ).toBe(false);
      }
      expect(a.method, "只允许 POST / GET").toMatch(/^(POST|GET)$/);
    }
  });

  it("⑥ 命令是一次性的传声筒:有 TTL,而运行历史永远在 run 台账", () => {
    expect(ACTION_COMMAND_TTL_DAYS).toBeGreaterThan(0);
    expect(ACTION_COMMAND_TTL_DAYS).toBeLessThanOrEqual(30);
    expect([...ACTION_COMMAND_ATTRS]).toContain("ttl");
    // pending 必须是初始态(消费端靠条件写 pending → running 抢单,防两个消费者各跑一次)
    expect(ACTION_COMMAND_STATUSES[0]).toBe("pending");
    expect([...ACTION_COMMAND_STATUSES]).toEqual(["pending", "running", "succeeded", "failed"]);
  });
});
