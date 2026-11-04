// disclaimer.ts —— 免责告知文案单作者(DESIGN §18 决策 6quinquies ④;INTERACTION v2.17 §4bis.4)。
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DISCLAIMER_TEXT, DISCLAIMER_TEXT_HASH, DISCLAIMER_VERSION, currentDisclaimerAck, isCurrentDisclaimerAck } from "@/lib/residency/disclaimer";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");

describe("🔴 文案 + 版本 + 哈希三者绑定", () => {
  it("DISCLAIMER_TEXT_HASH == sha256(DISCLAIMER_TEXT)(改文案不改哈希 ⇒ 红;同意记录绑的是「这一版这段字」)", () => {
    expect(DISCLAIMER_TEXT_HASH).toBe(createHash("sha256").update(DISCLAIMER_TEXT).digest("hex"));
  });
  it("版本号形如 vN;currentDisclaimerAck 回的就是当前版本 + 哈希;isCurrentDisclaimerAck 逐字核对", () => {
    expect(DISCLAIMER_VERSION).toMatch(/^v\d+$/);
    expect(currentDisclaimerAck()).toEqual({ version: DISCLAIMER_VERSION, textHash: DISCLAIMER_TEXT_HASH });
    expect(isCurrentDisclaimerAck(currentDisclaimerAck())).toBe(true);
    expect(isCurrentDisclaimerAck({ version: "v0", textHash: DISCLAIMER_TEXT_HASH })).toBe(false);
    expect(isCurrentDisclaimerAck({ version: DISCLAIMER_VERSION, textHash: "0".repeat(64) })).toBe(false);
    expect(isCurrentDisclaimerAck(null)).toBe(false);
    expect(isCurrentDisclaimerAck("v1")).toBe(false);
  });
  it("🔴 文案不替客户下法律定性(用户原话:告知我们不承担 … 需要用户自行 …);且说了「不承担」与「自行」", () => {
    expect(DISCLAIMER_TEXT).toContain("不承担任何");
    expect(DISCLAIMER_TEXT).toContain("自行");
    for (const banned of ["由你担责", "数据出境", "法务备案", "备案"]) expect(DISCLAIMER_TEXT).not.toContain(banned);
  });
});

describe("🔴 A1 门禁:文案只在 disclaimer.ts 一处定义;全仓产品代码无法务定性文案(ACCEPTANCE)", () => {
  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === "__tests__" || e === ".next") continue;
      const fp = resolve(dir, e);
      if (statSync(fp).isDirectory()) walk(fp, acc);
      else if (/\.(ts|tsx)$/.test(e)) acc.push(fp);
    }
    return acc;
  };
  const files = walk(SRC);
  const strip = (raw: string) => raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  it("文案首句只出现在 lib/residency/disclaimer.ts", () => {
    const head = DISCLAIMER_TEXT.slice(0, 12);
    const hits = files.filter((fp) => strip(readFileSync(fp, "utf8")).includes(head)).map((fp) => fp.slice(SRC.length + 1));
    expect(hits).toEqual(["lib/residency/disclaimer.ts"]);
  });
  it("全仓产品代码(剥注释)不出现「法务备案 / 由你担责 / 数据出境」", () => {
    const offenders: string[] = [];
    for (const fp of files) {
      const code = strip(readFileSync(fp, "utf8"));
      for (const w of ["法务备案", "由你担责", "数据出境"]) if (code.includes(w)) offenders.push(`${fp.slice(SRC.length + 1)}:${w}`);
    }
    expect(offenders).toEqual([]);
  });
});
