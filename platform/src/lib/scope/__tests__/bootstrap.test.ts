// @kf-batch 50-WP4-o1-scope
// 冷启动决策的穷举单测(合同 SPEC v3.36 §2.6.5b;判据 E-157 / E-157a / E-154)。
//
// 🔴 这里最要紧的是**把两条路径分清**:
//   · URL **显式点名**了坏 target ⇒ 报错、保留 URL、绝不改写(E-154)
//   · localStorage **播种**的值失效 ⇒ 落回「全部」+ 明确告知(E-157 ④)
// 把后者写成前者会天天弹错误页;把前者写成后者就是「前端吃掉 4xx 再偷偷切 global」。

import { describe, it, expect } from "vitest";
import {
  resolveInitialScope,
  revalidateScope,
  scopeStorageKey,
  staleScopeNotice,
  missingTargets,
} from "../bootstrap";

const HOME = "tgt_home";
const A = "tgt_usw2_a";
const AVAIL = [HOME, A];

describe("scopeStorageKey", () => {
  it("🔴 必须同时带项目与环境(漏 env 会让 dev 选的区串到 prod)", () => {
    expect(scopeStorageKey("proj-a", "dev")).toBe("bgp-scope:proj-a:dev");
    expect(scopeStorageKey("proj-a", "prod")).not.toBe(scopeStorageKey("proj-a", "dev"));
    expect(scopeStorageKey("proj-b", "dev")).not.toBe(scopeStorageKey("proj-a", "dev"));
  });
});

describe("① URL 带合法值 ⇒ URL 赢", () => {
  it("单区", () => {
    expect(resolveInitialScope({ urlParam: A, stored: HOME, available: AVAIL })).toEqual({
      kind: "url",
      scope: { kind: "target", targetId: A },
      persist: true,
    });
  });

  it("显式 global 也是 URL 赢(不许被 localStorage 顶掉)", () => {
    expect(resolveInitialScope({ urlParam: "global", stored: A, available: AVAIL })).toEqual({
      kind: "url",
      scope: { kind: "global" },
      persist: true,
    });
  });

  it("对比态", () => {
    expect(resolveInitialScope({ urlParam: `cmp:${A},${HOME}`, stored: null, available: AVAIL })).toMatchObject({
      kind: "url",
      scope: { kind: "compare", targetIds: [A, HOME] },
    });
  });
});

describe("②③ URL 里的值有问题 ⇒ 报错壳,**不改 URL**", () => {
  it("文法非法", () => {
    expect(resolveInitialScope({ urlParam: "us-west-2", stored: A, available: AVAIL })).toEqual({
      kind: "url-invalid",
      raw: "us-west-2",
      reason: "grammar",
    });
  });

  it("🔴 文法合法但不在可用列表(已删 / 未装完 / 未授权)⇒ url-unavailable,而不是悄悄换成 stored", () => {
    const r = resolveInitialScope({ urlParam: "tgt_zzz9", stored: A, available: AVAIL });
    expect(r).toEqual({
      kind: "url-unavailable",
      scope: { kind: "target", targetId: "tgt_zzz9" },
      missing: ["tgt_zzz9"],
      reason: "unavailable",
    });
  });

  it("compare 里有一个不可用 ⇒ 整体判不可用,并点名是哪一个", () => {
    const r = resolveInitialScope({ urlParam: `cmp:${A},tgt_zzz9`, stored: null, available: AVAIL });
    expect(r).toMatchObject({ kind: "url-unavailable", missing: ["tgt_zzz9"] });
  });

  it("🔴 列表还没拉回来(available=null)⇒ 先按有效渲染,不闪错误壳", () => {
    expect(resolveInitialScope({ urlParam: "tgt_zzz9", stored: null, available: null })).toMatchObject({
      kind: "url",
    });
  });
});

describe("④ URL 不带 + 上次选择仍可用 ⇒ 恢复并写回地址栏(用户点名:刷新不能丢选择)", () => {
  it("恢复单区并给出要写回的参数值", () => {
    expect(resolveInitialScope({ urlParam: null, stored: A, available: AVAIL })).toEqual({
      kind: "restored",
      scope: { kind: "target", targetId: A },
      rewriteTo: A,
    });
  });

  it("空串参数等同于没带(?scope= 这种)", () => {
    expect(resolveInitialScope({ urlParam: "", stored: A, available: AVAIL })).toMatchObject({ kind: "restored" });
  });

  it("恢复对比态", () => {
    expect(resolveInitialScope({ urlParam: null, stored: `cmp:${HOME},${A}`, available: AVAIL })).toMatchObject({
      kind: "restored",
      rewriteTo: `cmp:${HOME},${A}`,
    });
  });

  it("上次存的是 global ⇒ 就是默认态,不用写回参数(保住 E-158 的回滚点)", () => {
    expect(resolveInitialScope({ urlParam: null, stored: "global", available: AVAIL })).toEqual({
      kind: "default",
      scope: { kind: "global" },
    });
  });
});

describe("⑤ URL 不带 + 上次选择已失效 ⇒ 落回「全部」+ 明确告知", () => {
  it("存的 target 已不在列表", () => {
    expect(resolveInitialScope({ urlParam: null, stored: "tgt_zzz9", available: AVAIL })).toEqual({
      kind: "restored-stale",
      scope: { kind: "global" },
      staleRaw: "tgt_zzz9",
    });
  });

  it("存坏了(手改过 / 旧格式)也按失效处理,不弹报错", () => {
    expect(resolveInitialScope({ urlParam: null, stored: "us-west-2", available: AVAIL })).toMatchObject({
      kind: "restored-stale",
      staleRaw: "us-west-2",
    });
  });

  it("🔴 告知文案必须点名那个 id(不说清楚用户不知道发生了什么)", () => {
    const msg = staleScopeNotice("tgt_zzz9");
    expect(msg).toContain("tgt_zzz9");
    expect(msg).toContain("已切回");
  });

  it("🔴 落回的是「全部」而不是 home(回落 home 会丢掉别区的数据视野)", () => {
    const r = resolveInitialScope({ urlParam: null, stored: "tgt_zzz9", available: AVAIL });
    expect(r.scope).toEqual({ kind: "global" });
  });
});

describe("默认态", () => {
  it("URL 不带 + 没存过 ⇒ 全部", () => {
    expect(resolveInitialScope({ urlParam: null, stored: null, available: AVAIL })).toEqual({
      kind: "default",
      scope: { kind: "global" },
    });
  });

  it("全新环境只有 home ⇒ 列表一项,恢复 home 照常成立", () => {
    expect(resolveInitialScope({ urlParam: null, stored: HOME, available: [HOME] })).toMatchObject({
      kind: "restored",
      rewriteTo: HOME,
    });
  });
});

describe("missingTargets / revalidateScope(切项目 · 切环境后再校验)", () => {
  it("global 永远有效", () => {
    expect(revalidateScope({ kind: "global" }, [])).toBeNull();
    expect(missingTargets({ kind: "global" }, [])).toEqual([]);
  });

  it("仍在列表 ⇒ null", () => {
    expect(revalidateScope({ kind: "target", targetId: A }, AVAIL)).toBeNull();
  });

  it("切到没有该 target 的项目 ⇒ 切「全部」并给出失效原值", () => {
    expect(revalidateScope({ kind: "target", targetId: A }, [HOME])).toEqual({
      scope: { kind: "global" },
      staleRaw: A,
    });
  });

  it("列表还没拉回来 ⇒ 不判失效(否则切项目瞬间会误报)", () => {
    expect(revalidateScope({ kind: "target", targetId: A }, null)).toBeNull();
  });
});
