// `scope-capability-guard` + `capabilityForPath` 的单测(合同 SPEC v3.35 §2.6.7;矩阵 INTERACTION §9.6)。
//
// 🔴 本门禁要防的是**盲区**:平台有 40 个页面路由,只接 6 个单元。
// 少登记一条 = 那一页静默按「全部」渲染,用户切到 us-west-2 却看到全平台数据。

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  EXTRA_ROUTE_SCOPE,
  NO_GATE_ROUTES,
  SCOPE_CAPABILITIES,
  capabilityForPath,
  isFollows,
  isNoGate,
  GLOBAL_REASONS,
  isNotWired,
} from "../capability";
import { MENU_ROUTE_SCOPE } from "../route-scope";


const REPO = resolve(__dirname, "../../../../..");
const APP = resolve(REPO, "platform/src/app");

/** 从文件系统数出**真实**页面路由(不写死数字:写死了新增页面就静默通过)。 */
function pageRoutes(dir = APP, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "api") continue;
      out.push(...pageRoutes(p, `${prefix}/${name}`));
    } else if (name === "page.tsx") {
      out.push(prefix === "" ? "/" : prefix);
    }
  }
  return out;
}

const ROUTES = pageRoutes().sort();

// 🔴 **不 import `routes.tsx`**:本仓 vitest 是 `environment: node` 且刻意不处理 JSX
// (只跑纯逻辑层)。菜单树那一侧改为**读源码文本**核对 key 集合 —— 这也正是「登记表与菜单
// 不许各说各话」这条门禁要做的事。
const ROUTES_TSX = readFileSync(resolve(REPO, "platform/src/components/layout/routes.tsx"), "utf8");
const MENU_KEYS_IN_TSX = [...ROUTES_TSX.matchAll(/\bkey: "(\/[^"]*)"/g)].map((m) => m[1]);
const REGISTERED_MENU_KEYS = Object.keys(MENU_ROUTE_SCOPE);

describe("scope-capability-guard —— 登记面必须盖满真实路由", () => {
  it("门禁自检:真数出了页面路由(否则下面全是空断言)", () => {
    expect(ROUTES.length).toBeGreaterThan(30);
    expect(ROUTES).toContain("/");
    expect(ROUTES).toContain("/etl-jobs");
    expect(ROUTES).toContain("/sync/[id]");
  });

  it("🔴 每个真实页面路由都必须**有登记**(菜单叶 或 EXTRA_ROUTE_SCOPE)", () => {
    const registered = new Set<string>([...REGISTERED_MENU_KEYS, ...Object.keys(EXTRA_ROUTE_SCOPE)]);
    const missing = ROUTES.filter((r) => !registered.has(r));
    expect(
      missing,
      `这些页面没有范围能力登记 ⇒ 会静默按「全部」渲染:${missing.join(" / ")}。` +
        `补 routes.tsx 的 Leaf 或 capability.ts 的 EXTRA_ROUTE_SCOPE,并同步 INTERACTION §9.6`
    ).toEqual([]);
  });

  it("🔴 反向:登记表里不许有**已不存在**的路由(删页后留下的僵尸登记)", () => {
    const zombies = Object.keys(EXTRA_ROUTE_SCOPE).filter((k) => !ROUTES.includes(k));
    expect(zombies, `EXTRA_ROUTE_SCOPE 里这些路由已经没有 page.tsx:${zombies.join(" / ")}`).toEqual([]);
    const leafZombies = REGISTERED_MENU_KEYS.filter((k) => !ROUTES.includes(k));
    expect(leafZombies, `菜单叶指向不存在的页面:${leafZombies.join(" / ")}`).toEqual([]);
  });

  it("🔴 菜单树里的路由 key ↔ 登记表的 key **集合相等**(各说各话即红)", () => {
    expect(MENU_KEYS_IN_TSX.length, "读 routes.tsx 没抓到 key ⇒ 下面是空断言").toBeGreaterThan(25);
    expect([...MENU_KEYS_IN_TSX].sort()).toEqual([...REGISTERED_MENU_KEYS].sort());
  });

  it("登记总数 == 真实路由数(用 glob 实数比,不写死)", () => {
    expect(REGISTERED_MENU_KEYS.length + Object.keys(EXTRA_ROUTE_SCOPE).length).toBe(ROUTES.length);
  });

  // 原判据「global-only 的 scopeWired 恒 true」已作废
  // 新类型里 `global-only` 根本没有 wired 这一维(它不参与「过滤没过滤」这个问题),
  // 取而代之的是**自证**:必须有登记过的理由码 + 「按区的东西去哪看」。
  it("🔴 `global-only` 必须自证:理由码在封闭集合里 + insteadSee 指向真实路由或 self", () => {
    const all: Array<[string, unknown]> = [
      ...Object.entries(MENU_ROUTE_SCOPE),
      ...Object.entries(EXTRA_ROUTE_SCOPE).filter(([, d]) => !isFollows(d as never) && !isNoGate(d as never)),
    ];
    let n = 0;
    for (const [k, dRaw] of all) {
      const d = dRaw as { scope: string; globalReason?: string; insteadSee?: string };
      if (d.scope !== "global-only") continue;
      n++;
      expect(Object.keys(GLOBAL_REASONS), `${k} 的 globalReason 不在封闭集合里`).toContain(d.globalReason);
      const see = d.insteadSee;
      expect(typeof see, `${k} 缺 insteadSee`).toBe("string");
      const ok = see === "self" || see! in MENU_ROUTE_SCOPE || see! in EXTRA_ROUTE_SCOPE;
      expect(ok, `${k} 的 insteadSee 指向 ${see},那不是一个已登记的路由 ⇒ 会把用户送进 404`).toBe(true);
    }
    expect(n, "一个 global-only 都没扫到 ⇒ 空断言").toBeGreaterThanOrEqual(4);
  });

  it("每个叶子的 scope 取值都在 union 里(运行期再兜一层,防 as any 绕过)", () => {
    for (const [k, d] of Object.entries(MENU_ROUTE_SCOPE)) expect(SCOPE_CAPABILITIES, k).toContain(d.scope);
  });

  it("`follows` 指向的路由必须自己有登记(不许指向空)", () => {
    for (const [k, d] of Object.entries(EXTRA_ROUTE_SCOPE)) {
      if (!isFollows(d)) continue;
      const target = d.follows;
      const ok = target in MENU_ROUTE_SCOPE || target in EXTRA_ROUTE_SCOPE;
      expect(ok, `${k} 的 follows 指向 ${target},但那条没有登记`).toBe(true);
    }
  });

});

describe("capabilityForPath", () => {
  it("精确命中菜单叶", () => {
    // 🔴 `scopeWired` **不写死字面量**:它会逐个单元翻成 true,
    // 写死就得每接一页改一次测试(而那种改动很容易顺手把断言改松)。这里断「查出来的 == 登记的」。
    for (const key of ["/etl-jobs", "/exec-envs", "/genbi", "/monitor"] as const) {
      expect(capabilityForPath(key), key).toEqual(MENU_ROUTE_SCOPE[key]);
    }
    // 基础能力这三条是设计意图,不随接入进度变,可以写死
    expect(capabilityForPath("/etl-jobs")!.scope).toBe("global-and-target");
    expect(capabilityForPath("/exec-envs")).toEqual({
      scope: "global-only",
      globalReason: "manages-regions",
      insteadSee: "self",
    });
    expect(capabilityForPath("/genbi")!.scope).toBe("target-only");
  });

  it("compare 能力透传(护栏 6 只给这几页)", () => {
    expect(capabilityForPath("/finops")).toMatchObject({ scopeCompare: true });
    expect(capabilityForPath("/multi-region")).toMatchObject({ scope: "global-only", scopeCompare: true });
    expect(capabilityForPath("/etl-jobs")).not.toHaveProperty("scopeCompare");
  });

  it("🔴 动态详情页按**最长前缀**继承(与 routeLabelParts 同一规则,不另造匹配)", () => {
    expect(capabilityForPath("/workflow/abc123")).toEqual(capabilityForPath("/workflow"));
    expect(capabilityForPath("/sync/xyz")).toEqual(capabilityForPath("/sync"));
    // 首页不参与前缀匹配,否则所有路径都会命中它
    expect(capabilityForPath("/nonexistent-page")).toMatchObject({
      scope: "global-and-target",
      wired: false,
    });
  });

  it("`/login` 不挂门", () => {
    expect(capabilityForPath("/login")).toBeNull();
    expect(NO_GATE_ROUTES).toEqual(["/login"]);
  });

  it("🔴 未知路由兜底成「未接入」而不是「已接入」(至少会挂上提示条,不假装过滤过了)", () => {
    const r = capabilityForPath("/some/brand/new/page");
    expect(r).not.toBeNull();
    expect(isNotWired(r!)).toBe(true);
    // 🔴 兜底也必须说得出「差什么」—— 它差的就是「没人登记过它」
    expect((r as { missing: string }).missing).toContain("没有在执行范围能力表里登记");
  });
});
