import { describe, it, expect } from "vitest";
import { translate, interpolate } from "../translate";
import { coerceLocale, localeForCountry } from "../locales";
import { EN } from "../messages/en";
import { projectDisplayName, DEFAULT_PROJECT_ID } from "../../projects/constants";

describe("interpolate ({key} 占位)", () => {
  it("按 params 替换占位", () => {
    expect(interpolate("共 {n} 条", { n: 12 })).toBe("共 12 条");
  });
  it("无 params 原样返回", () => {
    expect(interpolate("共 {n} 条")).toBe("共 {n} 条");
  });
  it("缺失的占位保持原样,不抛错", () => {
    expect(interpolate("{a} 和 {b}", { a: "x" })).toBe("x 和 {b}");
  });
});

describe("translate(中文即 key)", () => {
  it("zh:恒等返回中文源串", () => {
    expect(translate("保存", "zh")).toBe("保存");
    expect(translate("未收录的任意中文", "zh")).toBe("未收录的任意中文");
  });
  it("zh:仍做插值", () => {
    expect(translate("共 {n} 条", "zh", { n: 5 })).toBe("共 5 条");
  });
  it("en:命中字典用英文", () => {
    expect(translate("保存", "en")).toBe("Save");
    expect(translate("删除", "en")).toBe("Delete");
  });
  it("en:未命中优雅降级为中文(核心红线——遇问题显中文)", () => {
    expect(translate("这条一定没进字典xyz", "en")).toBe("这条一定没进字典xyz");
  });
  it("en:命中且插值", () => {
    // 需要字典里存在插值条目才生效;此处直接验证 interpolate 已被应用于降级串
    expect(translate("共 {n} 条", "en", { n: 9 })).toContain("9");
  });
});

describe("coerceLocale", () => {
  it("只认 en,其余一律 zh(默认中文)", () => {
    expect(coerceLocale("en")).toBe("en");
    expect(coerceLocale("zh")).toBe("zh");
    expect(coerceLocale("fr")).toBe("zh");
    expect(coerceLocale(null)).toBe("zh");
    expect(coerceLocale(undefined)).toBe("zh");
    expect(coerceLocale(123)).toBe("zh");
  });
});

describe("localeForCountry(IP→国家→语种)", () => {
  it("英语区→en", () => {
    expect(localeForCountry("US")).toBe("en");
    expect(localeForCountry("gb")).toBe("en"); // 大小写不敏感
    expect(localeForCountry("AU")).toBe("en");
  });
  it("非英语区→zh(用户要求:非英语区默认中文)", () => {
    expect(localeForCountry("CN")).toBe("zh");
    expect(localeForCountry("JP")).toBe("zh");
    expect(localeForCountry("FR")).toBe("zh");
  });
  it("未知/空→zh(兜底中文)", () => {
    expect(localeForCountry(null)).toBe("zh");
    expect(localeForCountry(undefined)).toBe("zh");
    expect(localeForCountry("")).toBe("zh");
  });
});

describe("projectDisplayName(默认工作区翻译,自建工作区保留)", () => {
  const en = (zh: string) => translate(zh, "en");
  const zh = (s: string) => translate(s, "zh");
  it("默认工作区:en 翻译为 Default Workspace", () => {
    expect(projectDisplayName("默认空间", DEFAULT_PROJECT_ID, en)).toBe("Default Workspace");
  });
  it("默认工作区:zh 恒等仍为默认空间", () => {
    expect(projectDisplayName("默认空间", DEFAULT_PROJECT_ID, zh)).toBe("默认空间");
  });
  it("自建工作区:业务数据原样保留(即便含中文,en 也不翻)", () => {
    expect(projectDisplayName("风控数据域", "proj-abc123", en)).toBe("风控数据域");
    expect(projectDisplayName("My Space", "proj-abc123", en)).toBe("My Space");
  });
});

describe("字典自洽", () => {
  it("EN 无空译文", () => {
    for (const [k, v] of Object.entries(EN)) {
      expect(v, `key=${k}`).toBeTruthy();
    }
  });
});
