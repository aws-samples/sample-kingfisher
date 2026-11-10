// 2026-11-09 代码扫描抓到:correlation id 的退路用 Math.random 生成会被当作关联键的标识符。
//   钉:三级退路都不碰 Math.random,且每级产物形态可辨。
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { newCorrelationId } from "../logger";

afterEach(() => vi.unstubAllGlobals());

describe("newCorrelationId 的随机源", () => {
  it("Node 20:randomUUID 形态", () => {
    expect(newCorrelationId()).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("没有 randomUUID ⇒ getRandomValues 的 32 位十六进制", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) });
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).toMatch(/^cid-[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
  it("完全没有 crypto ⇒ 时间 + 进程内计数,仍不重复、不抛", () => {
    vi.stubGlobal("crypto", undefined);
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).toMatch(/^cid-[0-9a-z]+-[0-9a-z]+$/);
    expect(a).not.toBe(b);
  });
  it("源码里没有 Math.random(剥掉注释再查:注释里写着「不用 Math.random」)", () => {
    const src = readFileSync(resolve(process.cwd(), "src/lib/observability/logger.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");
    expect(src).not.toMatch(/Math\.random/);
  });
});
