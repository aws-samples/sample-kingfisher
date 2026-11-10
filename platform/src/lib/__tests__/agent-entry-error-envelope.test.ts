// 2026-11-09 代码扫描抓到:三个 AgentCore 容器入口的 500 回包把整个异常对象(String(e))回给调用方,
//   异常对象可能带堆栈 / 内部路径。钉:只回 message,非 Error 的抛出物给固定文案,细节只进容器日志。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(process.cwd(), "..");
const ENTRIES = ["genbi", "netadvisor", "paramadvisor"].map((a) => `infra/agent/${a}/index.js`);
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

describe("AgentCore 容器入口的错误信封", () => {
  for (const rel of ENTRIES) {
    it(`${rel}:500 只回 errorMessage(e),不回 String(e) / e.stack / 整个 e`, () => {
      const src = strip(readFileSync(resolve(REPO, rel), "utf8"));
      expect(src).toMatch(/function errorMessage\(e\)/);
      expect(src).toMatch(/send\(res, 500, \{ error: errorMessage\(e\) \}\)/);
      expect(src).not.toMatch(/String\(e\)/);
      expect(src).not.toMatch(/\.stack\b/);
      expect(src).not.toMatch(/error:\s*e\b/);
      // 细节仍进容器日志(排障不丢)
      expect(src).toMatch(/console\.error\("\[invocations\] failed:", e\)/);
    });
  }
  it("errorMessage 的语义:Error ⇒ message;非 Error / 空 message ⇒ 固定文案", () => {
    // 与入口文件逐字同一实现(入口是会起 http 服务的 ESM,不直接 import;下面这行若与源码不一致,上面的正则会先红)
    const errorMessage = (e: unknown) => (e && typeof (e as { message?: unknown }).message === "string" && (e as { message: string }).message ? (e as { message: string }).message : "internal error");
    expect(errorMessage(new Error("model not available"))).toBe("model not available");
    expect(errorMessage("raw string")).toBe("internal error");
    expect(errorMessage(null)).toBe("internal error");
    expect(errorMessage({ message: "" })).toBe("internal error");
    const src = strip(readFileSync(resolve(REPO, ENTRIES[0]), "utf8"));
    expect(src).toContain('return e && typeof e.message === "string" && e.message ? e.message : "internal error";');
  });
});
