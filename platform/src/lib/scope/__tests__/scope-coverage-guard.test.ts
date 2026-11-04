// @kf-batch 50-WP4ter-coverage
// 🔴🔴 **棘轮门禁** —— 用户 2026-09-10 原话:「这些都有问题,你都必须要覆盖到,**我不想再说第二次**」。
//
// 「不想再说第二次」不能靠人记住,只能靠一个**会红的数字**。本文件就是那个数字:
//   ① 实际「还没按执行范围过滤」的路由条数,必须**恰好等于** `NOT_WIRED_LIMIT`;
//      · 新增一页而不接入 ⇒ 实数 > 上限 ⇒ 红(没人能悄悄再添一个未接入页);
//      · 接好一页 ⇒ 必须在同一笔提交里把上限减 1(多减也红,防「先减着占坑」)。
//   ② 上限**只许改小**:本文件里另钉一个**开工基线**常量,`NOT_WIRED_LIMIT` 不许超过它。
//   ③ 每条未接入都必须有**唯一工单号** + **说得出差什么**(横幅直接渲染这两样给用户看);
//      工单号必须在 WORK-PACKAGES 的 WP-4ter 台账里查得到 ⇒ 代码与排期不许分叉。
//   ④ 「差什么」不许是同义反复(「待接入」「以后再说」这类词 = 什么都没说)。

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { EXTRA_ROUTE_SCOPE, isFollows, isNoGate, isNotWired, isGlobalOnly, GLOBAL_REASONS } from "../capability";
import { MENU_ROUTE_SCOPE, NOT_WIRED_LIMIT } from "../route-scope";

const REPO = resolve(__dirname, "../../../../..");
// @kf-batch 50-WP4quater-reads(工单 SC-14)—— `redirect-only` 门禁要读页面文件
const SRC = resolve(REPO, "platform/src");
const read = (f: string) => readFileSync(f, "utf8");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/**
 * 🔴 **开工基线,这个数字只许改小,永远不许改大。**
 * 22 = 2026-09-10 开工时的实数(原 15 个 `scopeWired:false` + 翻出来的 7 处伪全局:
 * 计划中心 / 技能 / 业务口径 / 运维大屏 / 运维知识库 / 项目空间 / 系统设置)。
 */
const OPENING_BALANCE = 22;

/** 两张表里所有**真能定范围**的声明(排掉 follows / no-gate 两种非声明)。 */
function allDecls(): Array<[string, ReturnType<typeof declOf>]> {
  const out: Array<[string, ReturnType<typeof declOf>]> = [];
  for (const [k, d] of Object.entries(MENU_ROUTE_SCOPE)) out.push([k, d as never]);
  for (const [k, d] of Object.entries(EXTRA_ROUTE_SCOPE)) {
    if (isFollows(d) || isNoGate(d)) continue;
    out.push([k, d as never]);
  }
  return out;
}
function declOf(d: unknown) {
  return d as { scope: string; wired?: boolean; ticket?: string; missing?: string };
}

describe("scope-coverage-guard(棘轮)", () => {
  it("🔴 未接入条数 == NOT_WIRED_LIMIT(新增未接入页即红;接好一页必须把上限减 1)", () => {
    const notWired = allDecls().filter(([, d]) => isNotWired(d as never));
    expect(
      notWired.length,
      `未接入实数 ${notWired.length} ≠ 上限 ${NOT_WIRED_LIMIT}。` +
        `多了 ⇒ 有人新增了未接入的页;少了 ⇒ 接好了却没把上限减掉(两种都不许)。` +
        `名单:${notWired.map(([k]) => k).join(" / ")}`
    ).toBe(NOT_WIRED_LIMIT);
  });

  it("🔴 上限只许改小:NOT_WIRED_LIMIT ≤ 开工基线 22", () => {
    expect(
      NOT_WIRED_LIMIT,
      `NOT_WIRED_LIMIT 被改大了(${NOT_WIRED_LIMIT} > ${OPENING_BALANCE})—— 这个方向是禁止的:` +
        `它意味着「又多了一页不按执行范围过滤」,正是用户说不想再说第二次的那件事`
    ).toBeLessThanOrEqual(OPENING_BALANCE);
  });

  it("🔴 每条未接入:工单号唯一 + 形如 SC-<数字>(工单台账在内部工程仓,不在本仓核对)", () => {
    const seen = new Map<string, string>();
    for (const [k, dRaw] of allDecls()) {
      const d = declOf(dRaw);
      if (!isNotWired(dRaw as never)) continue;
      expect(d.ticket, `${k} 缺工单号`).toMatch(/^SC-\d+$/);
      expect(seen.has(d.ticket!), `工单号 ${d.ticket} 被 ${seen.get(d.ticket!)} 和 ${k} 同时占用`).toBe(false);
      seen.set(d.ticket!, k);
    }
    if (NOT_WIRED_LIMIT > 0) {
      expect(seen.size, "棘轮 > 0 却一条未接入都没扫到 ⇒ 探测器坏了").toBeGreaterThanOrEqual(1);
    } else {
      const fake = { scope: "global-and-target", wired: false, ticket: "SC-999999", missing: "合成夹具:探测器判别力自证" };
      expect(isNotWired(fake as never), "探测器认不出「未接入」形态 ⇒ 上面整段循环都是空转").toBe(true);
    }
  });

  it("🔴 「差什么」必须真说了什么(同义反复不算)", () => {
    // 这些词单独出现 = 什么都没说;「差什么」要能让人判断该修哪里
    const EMPTY_WORDS = ["待接入", "尚未接入", "以后再说", "TODO", "待办", "未实现"];
    for (const [k, dRaw] of allDecls()) {
      const d = declOf(dRaw);
      if (!isNotWired(dRaw as never)) continue;
      expect(d.missing!.length, `${k} 的 missing 太短,等于没说`).toBeGreaterThanOrEqual(20);
      for (const w of EMPTY_WORDS) {
        expect(
          d.missing === w || d.missing!.trim() === w,
          `${k} 的 missing 只写了「${w}」= 同义反复`
        ).toBe(false);
      }
      // 必须给出归属批次(WP-4ter ④ 的 A–E),否则「差什么」没有归宿
      expect(/批次 [A-E]|WP-\d/.test(d.missing!), `${k} 的 missing 没写归哪个批次 / 哪个包`).toBe(true);
    }
  });

  it("🔴 global-only 必须自证(理由码在封闭集 + insteadSee 指真实路由)", () => {
    let n = 0;
    for (const [k, dRaw] of allDecls()) {
      if (!isGlobalOnly(dRaw as never)) continue;
      const d = dRaw as unknown as { globalReason: string; insteadSee: string };
      n++;
      expect(Object.keys(GLOBAL_REASONS), `${k} 的理由码不在封闭集合里`).toContain(d.globalReason);
      const ok = d.insteadSee === "self" || d.insteadSee in MENU_ROUTE_SCOPE || d.insteadSee in EXTRA_ROUTE_SCOPE;
      expect(ok, `${k} 的 insteadSee=${d.insteadSee} 不是已登记路由`).toBe(true);
    }
    expect(n, "一个 global-only 都没扫到 ⇒ 空断言").toBeGreaterThanOrEqual(4);
  });

  it("门禁自检:探测器真能区分三种形态(否则上面全是空断言)", () => {
    expect(isNotWired({ scope: "global-and-target", wired: false, ticket: "SC-1", missing: "x" } as never)).toBe(true);
    expect(isNotWired({ scope: "global-and-target", wired: true } as never)).toBe(false);
    // 🔴 global-only 不参与「过滤没过滤」这个问题,不能被算进未接入名单
    expect(isNotWired({ scope: "global-only", globalReason: "frontend-only", insteadSee: "self" } as never)).toBe(false);
    expect(isGlobalOnly({ scope: "global-only", globalReason: "frontend-only", insteadSee: "self" } as never)).toBe(true);
  });
  it("🔴🔴 `redirect-only` 不许变成新的挡箭牌:页面必须真的只跳转,且 insteadSee 指向的真页面必须已接入", () => {
    // 这条理由码是 2026-09-10 为 `/schedule` 引入的(19 行的 URL 兼容跳转页)。
    // 它很容易被滥用成「把欠账藏到一个跳转后面」⇒ 两条硬条件:
    //   ① 页面文件里除了 replace 跳转不许有任何 `/api` 取数;
    //   ② `insteadSee` 指向的那一页自己必须是 `wired: true`(不能跳到另一个欠账页)。
    const decls: Record<string, unknown> = { ...MENU_ROUTE_SCOPE, ...EXTRA_ROUTE_SCOPE };
    const bad: string[] = [];
    for (const [key, d] of Object.entries(decls)) {
      const dd = d as { globalReason?: string; insteadSee?: string };
      if (dd.globalReason !== "redirect-only") continue;
      const pf = resolve(SRC, "app", key === "/" ? "page.tsx" : `${key.replace(/^\//, "")}/page.tsx`);
      if (!existsSync(pf)) { bad.push(`${key}: 找不到页面文件`); continue; }
      const src = stripComments(read(pf));
      if (!/router\.replace\(/.test(src)) bad.push(`${key}: 声明了 redirect-only 但没有 router.replace(`);
      if (/\b(?:fetch|authedFetch|apiFetch)\s*\(\s*[`"'][^`"']*\/api\//.test(src)) {
        bad.push(`${key}: 声明了 redirect-only 却还在取 /api 数据 ⇒ 这不是跳转页`);
      }
      const target = dd.insteadSee;
      if (!target) { bad.push(`${key}: redirect-only 必须给 insteadSee(跳到哪一页)`); continue; }
      const td = decls[target] as { wired?: boolean; scope?: string } | undefined;
      if (!td) bad.push(`${key}: insteadSee=${target} 不在登记表里`);
      else if (td.scope !== "global-only" && td.wired !== true) {
        bad.push(`${key}: insteadSee=${target} 自己还没接入 ⇒ 等于把欠账藏到跳转后面`);
      }
    }
    expect(bad, bad.join(" / ")).toEqual([]);
  });

});
