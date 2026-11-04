// 多页签批量关闭规则(用户 2026-10-15:「多 tab 需要增加选项,关闭其它 tab」)。
// 钉 `closeTabsBy` 的闭合规则:关闭其它 / 关闭右侧 / 关闭全部;页签永不为空;跳转只在当前页被关掉时发生。
import { describe, it, expect } from "vitest";
import { closeTabsBy, HOME_TAB_PATH } from "../multitabs-close";

const T = (...paths: string[]) => paths.map((path) => ({ path }));
const TABS = T("/", "/datasources", "/sync", "/etl-jobs", "/genbi");

describe("关闭其它", () => {
  it("只留锚点页;当前页就是锚点 ⇒ 不跳", () => {
    const r = closeTabsBy(TABS, "/sync", "others", "/sync");
    expect(r.keep).toEqual(T("/sync"));
    expect(r.goto).toBeNull();
  });
  it("当前页不是锚点 ⇒ 跳到锚点", () => {
    const r = closeTabsBy(TABS, "/sync", "others", "/genbi");
    expect(r.keep).toEqual(T("/sync"));
    expect(r.goto).toBe("/sync");
  });
});

describe("关闭右侧", () => {
  it("保留锚点及其左边,保序;当前页在左边 ⇒ 不跳", () => {
    const r = closeTabsBy(TABS, "/sync", "right", "/datasources");
    expect(r.keep).toEqual(T("/", "/datasources", "/sync"));
    expect(r.goto).toBeNull();
  });
  it("当前页在右边被关掉 ⇒ 跳到锚点", () => {
    const r = closeTabsBy(TABS, "/sync", "right", "/genbi");
    expect(r.keep).toEqual(T("/", "/datasources", "/sync"));
    expect(r.goto).toBe("/sync");
  });
  it("锚点已是最右 ⇒ 什么都不关、不跳", () => {
    const r = closeTabsBy(TABS, "/genbi", "right", "/genbi");
    expect(r.keep).toEqual(TABS);
    expect(r.goto).toBeNull();
  });
});

describe("关闭全部", () => {
  it("只留首页并跳首页(当前页不是首页)", () => {
    const r = closeTabsBy(TABS, "/sync", "all", "/sync");
    expect(r.keep).toEqual(T(HOME_TAB_PATH));
    expect(r.goto).toBe(HOME_TAB_PATH);
  });
  it("首页本来不在页签里 ⇒ 补一个首页页签(页签永不为空)", () => {
    const r = closeTabsBy(T("/sync", "/genbi"), "/sync", "all", "/genbi");
    expect(r.keep).toEqual(T(HOME_TAB_PATH));
    expect(r.goto).toBe(HOME_TAB_PATH);
  });
  it("当前页就是首页 ⇒ 不跳", () => {
    const r = closeTabsBy(TABS, "/genbi", "all", "/");
    expect(r.keep).toEqual(T("/"));
    expect(r.goto).toBeNull();
  });
});

describe("边界", () => {
  it("锚点不在页签里(竞态)⇒ 原样返回、不跳", () => {
    expect(closeTabsBy(TABS, "/nope", "others", "/sync")).toEqual({ keep: TABS, goto: null });
    expect(closeTabsBy(TABS, "/nope", "right", "/sync")).toEqual({ keep: TABS, goto: null });
  });
  it("单页签关闭其它 / 右侧 ⇒ 不变", () => {
    expect(closeTabsBy(T("/sync"), "/sync", "others", "/sync")).toEqual({ keep: T("/sync"), goto: null });
    expect(closeTabsBy(T("/sync"), "/sync", "right", "/sync")).toEqual({ keep: T("/sync"), goto: null });
  });
});
