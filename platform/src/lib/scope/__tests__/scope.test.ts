// `lib/scope/scope.ts` 的**穷举**单测(合同 SPEC §2.6.1)。
//
// 🔴 这里刻意把「非法值」逐条列出来而不是抽样:文法是前后端共用的唯一权威,
// 少测一类就等于给「静默回落」留一个入口(SPEC §2.6.5 禁止的三种回落之一)。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  GLOBAL_SCOPE,
  SCOPE_COMPARE_MAX,
  SCOPE_COMPARE_MIN,
  SCOPE_COMPARE_PREFIX,
  SCOPE_GLOBAL,
  SCOPE_PARAM,
  isGlobalScope,
  isSameScope,
  parseScope,
  scopeIncludesTarget,
  scopeTargets,
  serializeScope,
  toScopeParam,
  type TargetScope,
} from "../scope";
import { TARGET_ID_PATTERN } from "@/lib/exec-env/target-id";

const HOME = "tgt_home";
const A = "tgt_usw2_a";
const B = "tgt_euw1_prod";
const C = "tgt_apse1_x";
const D = "tgt_use2_z";

describe("常量", () => {
  it("参数名与字面量固定(改了它就是改合同)", () => {
    expect(SCOPE_PARAM).toBe("scope");
    expect(SCOPE_GLOBAL).toBe("global");
    expect(SCOPE_COMPARE_PREFIX).toBe("cmp:");
    expect(SCOPE_COMPARE_MIN).toBe(2);
    expect(SCOPE_COMPARE_MAX).toBe(4);
  });

  it("🔴 A1:本文件不得自带第二份 targetId 正则(判定必须来自 target-id.ts)", () => {
    const src = readFileSync(new URL("../scope.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/\/\^?tgt_/);
    expect(src).toContain("isValidTargetId");
    expect(TARGET_ID_PATTERN.startsWith("^tgt_")).toBe(true);
  });
});

describe("parseScope —— 缺省与 global", () => {
  it.each([null, undefined, ""])("缺省(%s)⇒ global,**不是非法**", (raw) => {
    expect(parseScope(raw as string | null | undefined)).toEqual(GLOBAL_SCOPE);
  });

  it("字面量 global ⇒ global", () => {
    expect(parseScope("global")).toEqual({ kind: "global" });
  });

  it("isGlobalScope 是类型守卫", () => {
    const s = parseScope("global") as TargetScope;
    expect(isGlobalScope(s)).toBe(true);
    expect(isGlobalScope({ kind: "target", targetId: A })).toBe(false);
  });
});

describe("parseScope —— 单区", () => {
  it.each([HOME, A, B, C, D])("合法 targetId %s ⇒ target 态", (id) => {
    expect(parseScope(id)).toEqual({ kind: "target", targetId: id });
  });
});

describe("parseScope —— 对比态", () => {
  it("两个 ⇒ compare,保序", () => {
    expect(parseScope(`cmp:${A},${HOME}`)).toEqual({ kind: "compare", targetIds: [A, HOME] });
  });

  it("四个 ⇒ compare(上限)", () => {
    expect(parseScope(`cmp:${A},${B},${C},${D}`)).toEqual({
      kind: "compare",
      targetIds: [A, B, C, D],
    });
  });

  it("重复段去重后仍 ≥2 ⇒ 接受并规范化(顺序取首现)", () => {
    expect(parseScope(`cmp:${A},${A},${HOME}`)).toEqual({ kind: "compare", targetIds: [A, HOME] });
  });

  it("🔴 去重后只剩 1 个 ⇒ 非法(不许降级成 target 态)", () => {
    expect(parseScope(`cmp:${A},${A}`)).toBeNull();
  });
});

describe("parseScope —— 非法值穷举(每条都必须 null)", () => {
  const illegal: Array<[string, string]> = [
    ["只给一个", `cmp:${A}`],
    ["超过上限 5 个", `cmp:${A},${B},${C},${D},tgt_x1`],
    ["空段(尾逗号)", `cmp:${A},`],
    ["空段(头逗号)", `cmp:,${A}`],
    ["空段(中间)", `cmp:${A},,${B}`],
    ["前缀后什么都没有", "cmp:"],
    ["列表里混 global", `cmp:${A},global`],
    ["列表里有非法 targetId", `cmp:${A},TGT_UPPER`],
    ["用分号分隔", `cmp:${A};${B}`],
    ["用空格分隔", `cmp:${A} ${B}`],
    ["段内带空白", `cmp:${A}, ${B}`],
    ["前缀大写", `CMP:${A},${B}`],
    ["前导空白", ` ${A}`],
    ["尾随空白", `${A} `],
    ["global 带空白", " global"],
    ["global 大写", "GLOBAL"],
    ["targetId 大写", "TGT_HOME"],
    ["缺 tgt_ 前缀", "usw2_a"],
    ["用连字符(targetId 禁 -)", "tgt-usw2-a"],
    ["带 # (runId 分隔符)", "tgt_home#x"],
    ["带点", "tgt_home.x"],
    ["正文以 _ 结尾", "tgt_a_"],
    ["超长", "tgt_" + "a".repeat(30)],
    ["region 字面量(最容易被手写进 URL 的一种)", "us-west-2"],
    ["home 别名", "home"],
    ["纯数字", "123"],
    ["JSON 片段", '{"kind":"target"}'],
  ];
  it.each(illegal)("%s:%s ⇒ null", (_name, raw) => {
    expect(parseScope(raw)).toBeNull();
  });

  it("🔴 null(非法)与 global(缺省)不是一回事", () => {
    expect(parseScope("us-west-2")).toBeNull();
    expect(parseScope(undefined)).toEqual(GLOBAL_SCOPE);
  });
});

describe("serializeScope / toScopeParam", () => {
  it("三态各自的字面量", () => {
    expect(serializeScope({ kind: "global" })).toBe("global");
    expect(serializeScope({ kind: "target", targetId: A })).toBe(A);
    expect(serializeScope({ kind: "compare", targetIds: [A, HOME] })).toBe(`cmp:${A},${HOME}`);
  });

  it("🔴 global ⇒ toScopeParam 返回 null(URL 不带该参数 = 回滚点)", () => {
    expect(toScopeParam({ kind: "global" })).toBeNull();
    expect(toScopeParam({ kind: "target", targetId: A })).toBe(A);
    expect(toScopeParam({ kind: "compare", targetIds: [A, HOME] })).toBe(`cmp:${A},${HOME}`);
  });

  it("round-trip:parse(serialize(s)) === s(规范形式)", () => {
    const cases: TargetScope[] = [
      { kind: "global" },
      { kind: "target", targetId: HOME },
      { kind: "target", targetId: A },
      { kind: "compare", targetIds: [A, HOME] },
      { kind: "compare", targetIds: [A, B, C, D] },
    ];
    for (const s of cases) expect(parseScope(serializeScope(s))).toEqual(s);
  });

  it("反向不保证逐字节:`cmp:a,a,b` 会被规范化", () => {
    const parsed = parseScope(`cmp:${A},${A},${HOME}`) as TargetScope;
    expect(serializeScope(parsed)).toBe(`cmp:${A},${HOME}`);
  });
});

describe("scopeTargets / scopeIncludesTarget / isSameScope", () => {
  it("🔴 global 的 targets 是空数组(= 不加过滤),不是「所有 target」", () => {
    expect(scopeTargets({ kind: "global" })).toEqual([]);
  });

  it("target / compare 的 targets", () => {
    expect(scopeTargets({ kind: "target", targetId: A })).toEqual([A]);
    expect(scopeTargets({ kind: "compare", targetIds: [A, HOME] })).toEqual([A, HOME]);
  });

  it("scopeTargets 返回副本(改返回值不能污染 scope)", () => {
    const s: TargetScope = { kind: "compare", targetIds: [A, HOME] };
    scopeTargets(s).push("tgt_x1");
    expect(s.targetIds).toEqual([A, HOME]);
  });

  it("scopeIncludesTarget:global 恒真;target / compare 按名单", () => {
    expect(scopeIncludesTarget({ kind: "global" }, A)).toBe(true);
    expect(scopeIncludesTarget({ kind: "global" }, "随便什么")).toBe(true);
    expect(scopeIncludesTarget({ kind: "target", targetId: A }, A)).toBe(true);
    expect(scopeIncludesTarget({ kind: "target", targetId: A }, HOME)).toBe(false);
    expect(scopeIncludesTarget({ kind: "compare", targetIds: [A, HOME] }, HOME)).toBe(true);
    expect(scopeIncludesTarget({ kind: "compare", targetIds: [A, HOME] }, B)).toBe(false);
  });

  it("isSameScope:compare **顺序不同即不等价**(顺序就是列序)", () => {
    expect(isSameScope({ kind: "global" }, { kind: "global" })).toBe(true);
    expect(isSameScope({ kind: "target", targetId: A }, { kind: "target", targetId: A })).toBe(true);
    expect(isSameScope({ kind: "target", targetId: A }, { kind: "target", targetId: HOME })).toBe(false);
    expect(
      isSameScope({ kind: "compare", targetIds: [A, HOME] }, { kind: "compare", targetIds: [HOME, A] })
    ).toBe(false);
    expect(isSameScope({ kind: "target", targetId: A }, { kind: "global" })).toBe(false);
  });
});
