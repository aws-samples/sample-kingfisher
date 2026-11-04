// 服务端 `lib/exec-env/scope.ts` 的可执行门禁(合同 SPEC v3.34 §2.6.2 / §2.6.4 / §2.6.5)。
//
// 🔴 最要紧的三条:
//   ① `readScope` **只认 URL** —— 带上 `x-bgp-target-id` 必须毫无影响(判据)。
//   ② 四种拒因**一律不回落** —— 不许悄悄变成 home 或 global(判据)。
//   ③ `scopeFilter` 生成的 DDB 表达式与内存侧 `scalarTargetOf` 是**同一条规则** ——
//      用一个小型求值器逐格比对(parity,同 deploy-impact-parity 的做法)。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Raw = { targetId: string; access?: unknown; ready?: boolean; status?: string; observed?: { phase?: string } };
const targets: Record<string, Raw | undefined> = {
  tgt_home: { targetId: "tgt_home", ready: true },
  tgt_usw2_a: { targetId: "tgt_usw2_a", ready: true },
  tgt_locked: { targetId: "tgt_locked", ready: true, access: { mode: "allowlist", projects: ["proj-other"] } },
  // 装好了但**此刻不可承接**(在途部署锁 / 正在下线 / health 未确认都是这一类):
  // 🔴 必须**放行**范围校验 —— 顶栏下拉里有它,点进去却说「不存在」就是撒谎(全量硬门实撞)
  tgt_busy: { targetId: "tgt_busy", ready: true, status: "upgrading" },
  // 从未装好(还在初始化)⇒ 才该 404
  tgt_new1: { targetId: "tgt_new1", ready: false, status: "initializing" },
};

vi.mock("@/lib/exec-env/registry", () => ({
  // 🔴 范围校验必须走 `getTargetRaw`(不带可服务性准入)——
  //    桩里**故意不提供** `getTarget`:哪天有人改回去调它,这个文件会立刻报「不是函数」。
  getTargetRaw: vi.fn(async (id: string) => targets[id] ?? null),
  descriptorViolation: vi.fn(() => null),
}));

import {
  SCOPE_SCALAR_ATTR,
  countRowsByBinding,
  DEFAULT_BINDING_ATTR,
  countRowsByScalar,
  filterRowsByScope,
  readScope,
  requireScope,
  scalarTargetOf,
  scopeFilter,
  validateScopeTargets,
} from "../scope";
import { HOME_TARGET_ID } from "../target-id";
import type { TargetScope } from "@/lib/scope/scope";

function reqOf(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://x.test${url}`, { headers });
}

describe("readScope —— 来源只有 URL", () => {
  it("缺省 ⇒ global;显式 global ⇒ global;合法 targetId ⇒ target", () => {
    expect(readScope(reqOf("/api/x"))).toEqual({ kind: "global" });
    expect(readScope(reqOf("/api/x?scope=global"))).toEqual({ kind: "global" });
    expect(readScope(reqOf("/api/x?scope=tgt_usw2_a"))).toEqual({ kind: "target", targetId: "tgt_usw2_a" });
  });

  it("文法非法 ⇒ null(不是 global)", () => {
    expect(readScope(reqOf("/api/x?scope=us-west-2"))).toBeNull();
    expect(readScope(reqOf("/api/x?scope=cmp:tgt_home"))).toBeNull();
  });

  it("🔴 带 x-bgp-target-id 请求头**毫无影响**", () => {
    // 头指向 usw2、URL 什么都不带 ⇒ 必须还是 global
    expect(readScope(reqOf("/api/x", { "x-bgp-target-id": "tgt_usw2_a" }))).toEqual({ kind: "global" });
    // 头与 URL 冲突 ⇒ 必须听 URL
    expect(
      readScope(reqOf("/api/x?scope=tgt_home", { "x-bgp-target-id": "tgt_usw2_a" }))
    ).toEqual({ kind: "target", targetId: "tgt_home" });
  });

  it("🔴 也不认 x-bgp-project / x-bgp-env 之外的任何头(拦截器同款注入的天然诱惑)", () => {
    expect(readScope(reqOf("/api/x", { "x-bgp-scope": "tgt_usw2_a", "x-bgp-target": "tgt_usw2_a" }))).toEqual({
      kind: "global",
    });
  });
});

describe("validateScopeTargets / requireScope —— 一律不回落", () => {
  beforeEach(() => vi.clearAllMocks());

  it("global 不用校验", async () => {
    expect(await validateScopeTargets({ kind: "global" }, "proj-a")).toBeNull();
  });

  it("存在且可见 ⇒ 放行", async () => {
    expect(await validateScopeTargets({ kind: "target", targetId: "tgt_usw2_a" }, "proj-a")).toBeNull();
  });

  it("不存在 ⇒ 404 TARGET_NOT_FOUND", async () => {
    const bad = await validateScopeTargets({ kind: "target", targetId: "tgt_zzz9" }, "proj-a");
    expect(bad).toMatchObject({ status: 404, code: "TARGET_NOT_FOUND" });
  });

  it("存在但项目未授权 ⇒ 403 TARGET_FORBIDDEN", async () => {
    const bad = await validateScopeTargets({ kind: "target", targetId: "tgt_locked" }, "proj-a");
    expect(bad).toMatchObject({ status: 403, code: "TARGET_FORBIDDEN" });
  });

  it("🔴 装好但此刻不可承接(在途部署 / 正在下线 / health 未确认)⇒ **放行**", async () => {
    // 理由:范围过滤的是**主控区 DDB 里的行**,压根不碰那个区;真要打那个区的路由各自有准入。
    // 反过来若在这里拒,就出现「下拉里有、点进去说不存在」——(拒因还是假话)。
    expect(await validateScopeTargets({ kind: "target", targetId: "tgt_busy" }, "proj-a")).toBeNull();
  });

  it("🔴 从未装好(initializing 且未 ready)⇒ 404,报文点明「尚未初始化完成」", async () => {
    const bad = await validateScopeTargets({ kind: "target", targetId: "tgt_new1" }, "proj-a");
    expect(bad).toMatchObject({ status: 404, code: "TARGET_NOT_FOUND" });
    expect(bad!.message).toContain("尚未初始化完成");
  });

  it("🔴 compare 里有一个不合格 ⇒ 整体拒(不做「能显示的先显示」)", async () => {
    const bad = await validateScopeTargets(
      { kind: "compare", targetIds: ["tgt_home", "tgt_zzz9"] },
      "proj-a"
    );
    expect(bad).toMatchObject({ status: 404, code: "TARGET_NOT_FOUND" });
  });

  it("requireScope:文法非法 ⇒ 400 INVALID_SCOPE,报文带收到的原值", async () => {
    const res = await requireScope(reqOf("/api/x?scope=us-west-2"), "proj-a");
    expect(res).toBeInstanceOf(Response);
    const body = await (res as Response).json();
    expect((res as Response).status).toBe(400);
    expect(body.error.code).toBe("INVALID_SCOPE");
    expect(body.error.detail).toMatchObject({ received: "us-west-2" });
  });

  it("requireScope:已删 target ⇒ 404,且报文明说「不会自动切回主控区」", async () => {
    const res = await requireScope(reqOf("/api/x?scope=tgt_zzz9"), "proj-a");
    const body = await (res as Response).json();
    expect((res as Response).status).toBe(404);
    expect(body.error.code).toBe("TARGET_NOT_FOUND");
    expect(body.error.message).toContain("不会自动切回主控区");
  });

  it("requireScope:合法 ⇒ 直接返回 scope 对象(不是 Response)", async () => {
    const ok = await requireScope(reqOf("/api/x?scope=tgt_usw2_a"), "proj-a");
    expect(ok).toEqual({ kind: "target", targetId: "tgt_usw2_a" });
  });
});

// ── §2.6.4 A 类:标量章 ─────────────────────────────────────────────────────────

/** 只支持本模块会生成的那几种形态的**最小求值器**(parity 用)。 */
function evalClause(
  clause: string,
  names: Record<string, string>,
  values: Record<string, unknown>,
  row: Record<string, unknown>
): boolean {
  const attr = names["#scopeAttr"];
  // 本模块只生成「纯 OR 的原子式」⇒ 先把带括号的函数式换成不含括号的记号,再把剩下的括号全抹掉,
  // 这样按 " OR " 拆是语义安全的(纯 OR 下扁平化不改真值)。若将来实现引入 AND,下面会因形态不认识而抛。
  const norm = clause.split("attribute_not_exists(#scopeAttr)").join("ANE").replace(/[()]/g, "");
  return norm.split(" OR ").some((raw) => {
    const t = raw.trim();
    // 🔴 严格照 DDB 语义:`attribute_not_exists` **不匹配空串**(空串是「存在且为空」)。
    // 实现侧因此显式并入了 `#scopeAttr = :scopeEmpty`;这里绝不放宽求值器去凑绿。
    if (t === "ANE") return row[attr] === undefined;
    const m = t.match(/^#scopeAttr = (:scope(?:T\d+|Empty))$/);
    if (!m) throw new Error(`求值器不认识的形态:${t}(说明实现改了形态,先更新本测试)`);
    return row[attr] === values[m[1]];
  });
}

describe("scopeFilter(A 类标量章)", () => {
  it("global ⇒ null(= 不加过滤,回滚点)", () => {
    expect(scopeFilter({ kind: "global" }, "run")).toBeNull();
  });

  it("属性名来自各模块既有权威", () => {
    expect(SCOPE_SCALAR_ATTR.run).toBe("targetId");
    expect(SCOPE_SCALAR_ATTR.cost).toBe("targetId");
    expect(SCOPE_SCALAR_ATTR.datasource).toBe("ownerTargetId");
  });

  it("非 home 单区 ⇒ 纯等值(不捞存量)", () => {
    const f = scopeFilter({ kind: "target", targetId: "tgt_usw2_a" }, "run")!;
    expect(f.clause).toBe("#scopeAttr = :scopeT0");
    expect(f.names).toEqual({ "#scopeAttr": "targetId" });
    expect(f.values).toEqual({ ":scopeT0": "tgt_usw2_a" });
  });

  it("🔴 home 单区 ⇒ 存量无属性的行**和**空串行都要捞回来(DDB 的 attribute_not_exists 不匹配空串)", () => {
    const f = scopeFilter({ kind: "target", targetId: HOME_TARGET_ID }, "run")!;
    expect(f.clause).toContain("attribute_not_exists(#scopeAttr)");
    expect(f.clause).toContain("#scopeAttr = :scopeEmpty");
    expect(f.values[":scopeEmpty"]).toBe("");
  });

  it("非 home 的 scope 不该带 :scopeEmpty(别把空串行算进别的区)", () => {
    const f = scopeFilter({ kind: "target", targetId: "tgt_usw2_a" }, "run")!;
    expect(Object.keys(f.values)).toEqual([":scopeT0"]);
  });

  it("compare ⇒ OR 且整体加括号(免得与调用方的 AND 串错优先级)", () => {
    const f = scopeFilter({ kind: "compare", targetIds: ["tgt_usw2_a", "tgt_home"] }, "cost")!;
    expect(f.clause.startsWith("(")).toBe(true);
    expect(f.clause).toContain(" OR ");
    expect(Object.keys(f.values)).toEqual([":scopeT0", ":scopeT1", ":scopeEmpty"]);
  });

  it("🔴 占位符统一带 scope 前缀(不与调用方的 #env/#st/:uid/:pid 撞名)", () => {
    const f = scopeFilter({ kind: "compare", targetIds: ["tgt_a1", "tgt_b1"] }, "run")!;
    for (const n of Object.keys(f.names)) expect(n).toMatch(/^#scope/);
    for (const v of Object.keys(f.values)) expect(v).toMatch(/^:scope/);
  });

  it("🔴 parity:DDB 表达式与内存侧 scalarTargetOf 判定**逐格一致**", () => {
    const rows: Array<Record<string, unknown>> = [
      { id: "r1", targetId: "tgt_home" },
      { id: "r2", targetId: "tgt_usw2_a" },
      { id: "r3" }, // 存量:没有属性 ⇒ 归 home
      { id: "r4", targetId: "" }, // 空串也当缺失 ⇒ 归 home
    ];
    const scopes: TargetScope[] = [
      { kind: "target", targetId: "tgt_home" },
      { kind: "target", targetId: "tgt_usw2_a" },
      { kind: "compare", targetIds: ["tgt_home", "tgt_usw2_a"] },
    ];
    let checked = 0;
    for (const scope of scopes) {
      const f = scopeFilter(scope, "run")!;
      for (const row of rows) {
        const byDdb = evalClause(f.clause, f.names, f.values, row);
        const wanted = scope.kind === "target" ? [scope.targetId] : (scope as { targetIds: string[] }).targetIds;
        const byMemory = wanted.includes(scalarTargetOf(row, "run"));
        expect(byDdb, `scope=${JSON.stringify(scope)} row=${JSON.stringify(row)}`).toBe(byMemory);
        checked++;
      }
    }
    expect(checked).toBe(rows.length * scopes.length);
  });

  it("🔴 空串 targetId 也归 home(否则 home 视角会漏掉写坏的行)", () => {
    expect(scalarTargetOf({ targetId: "" }, "run")).toBe(HOME_TARGET_ID);
    expect(scalarTargetOf({}, "run")).toBe(HOME_TARGET_ID);
    expect(scalarTargetOf({ ownerTargetId: "tgt_usw2_a" }, "datasource")).toBe("tgt_usw2_a");
  });
});

// ── §2.6.4 B 类:绑定列表 ───────────────────────────────────────────────────────

describe("B 类换字段名读(bindingAttr)", () => {
  const rows = [
    { id: "p1", execTargets: ["tgt_home"] },
    { id: "p2", execTargets: ["tgt_usw2_a"] },
    { id: "p3", execTargets: ["tgt_home", "tgt_usw2_a"] },
    { id: "p4" }, // 无绑定 ⇒ 回落 home
    { id: "p5", targetId: "tgt_usw2_a" }, // 单值 ⇒ 回落第二级
  ];

  it("🔴 用默认字段名读这些行 = 全部算成 home(这正是要防的 bug)", () => {
    expect(filterRowsByScope(rows, { kind: "target", targetId: "tgt_home" }).map((r) => r.id)).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
    ]);
    expect(filterRowsByScope(rows, { kind: "target", targetId: "tgt_usw2_a" }).map((r) => r.id)).toEqual(["p5"]);
  });

  it("换成 `execTargets` 后逐行正确,且**三级回落一个字没变**", () => {
    const home = filterRowsByScope(rows, { kind: "target", targetId: "tgt_home" }, "execTargets");
    expect(home.map((r) => r.id)).toEqual(["p1", "p3", "p4"]);
    const usw2 = filterRowsByScope(rows, { kind: "target", targetId: "tgt_usw2_a" }, "execTargets");
    expect(usw2.map((r) => r.id)).toEqual(["p2", "p3", "p5"]);
  });

  it("global 仍然原样返回(回滚点),compare 仍是并集", () => {
    expect(filterRowsByScope(rows, { kind: "global" }, "execTargets")).toHaveLength(5);
    expect(
      filterRowsByScope(rows, { kind: "compare", targetIds: ["tgt_home", "tgt_usw2_a"] }, "execTargets").map((r) => r.id)
    ).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });

  it("计数同样换字段名(一行绑 N 个区 ⇒ N 个 key 各计 1)", () => {
    expect(countRowsByBinding(rows, "execTargets")).toEqual({ tgt_home: 3, tgt_usw2_a: 3 });
    // 默认字段名下同一批行会全部堆到 home(除了带单值 targetId 的那一行)
    expect(countRowsByBinding(rows)).toEqual({ tgt_home: 4, tgt_usw2_a: 1 });
  });

  it("`targets` 与 `bindingAttr` 缺省值指同一个东西", () => {
    expect(DEFAULT_BINDING_ATTR).toBe("targets");
    const r = [{ id: "x", targets: ["tgt_usw2_a"] }];
    expect(filterRowsByScope(r, { kind: "target", targetId: "tgt_usw2_a" }, DEFAULT_BINDING_ATTR)).toHaveLength(1);
  });
});

describe("filterRowsByScope / countRowsByBinding(B 类,走 bindingTargets)", () => {
  const rows = [
    { id: "a", targets: ["tgt_home"] },
    { id: "b", targets: ["tgt_usw2_a"] },
    { id: "c", targets: ["tgt_home", "tgt_usw2_a"] },
    { id: "d" }, // 存量:无 targets ⇒ bindingTargets 回落 home
    { id: "e", targetId: "tgt_usw2_a" }, // 单值旧形态 ⇒ 回落到它
  ];

  it("global ⇒ 原样返回(同一个数组内容)", () => {
    expect(filterRowsByScope(rows, { kind: "global" }).map((r) => r.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("🔴 home 视角必须包含存量无 targets 的行(三级回落)", () => {
    expect(filterRowsByScope(rows, { kind: "target", targetId: "tgt_home" }).map((r) => r.id)).toEqual([
      "a",
      "c",
      "d",
    ]);
  });

  it("🔴 单值旧形态 targetId 也算绑定", () => {
    expect(filterRowsByScope(rows, { kind: "target", targetId: "tgt_usw2_a" }).map((r) => r.id)).toEqual([
      "b",
      "c",
      "e",
    ]);
  });

  it("compare ⇒ 并集", () => {
    expect(
      filterRowsByScope(rows, { kind: "compare", targetIds: ["tgt_home", "tgt_usw2_a"] }).map((r) => r.id)
    ).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("🔴 一行绑 N 个区 ⇒ N 个 key 各计 1(各 key 之和可大于行数)", () => {
    const counts = countRowsByBinding(rows);
    expect(counts).toEqual({ tgt_home: 3, tgt_usw2_a: 3 });
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(6);
    expect(sum).toBeGreaterThan(rows.length); // 5 行 → 6 计数,界面别做等式断言
  });

  it("countRowsByScalar:一行只归一个区", () => {
    expect(
      countRowsByScalar([{ ownerTargetId: "tgt_usw2_a" }, { ownerTargetId: "tgt_usw2_a" }, {}], "datasource")
    ).toEqual({ tgt_usw2_a: 2, tgt_home: 1 });
  });
});
