// @kf-batch 54-genbi-session-cards
// 🔴🔴 **跨层门禁(2026-09-13 真环境抓到的 P0)**:边缘层放行上限必须大于应用层自己的上限。
//
// 病史:CloudFront 前的 WAF 托管通用规则集 `SizeRestrictions_BODY` 拦掉**一切 >8KB 的请求体**,
// 而改动前只放行了 `/api/flink/connectors` 一条。于是模块 54「会话卡片」——**平台第一个持久化
// 查询结果行**的功能 —— 只要对话稍长(轻易 >8KB)就被边缘层拦成一张 **403 HTML 错误页**:
// 应用层一个字都说不上,用户看到「保存失败」而查不出原因,日志里也没有。
//
// 【为什么这条门禁必须存在,而且必须跨层读】两层的上限各写在各自的包里(`cards-store.ts` 与
// `infra/lib/waf-stack.ts`),谁都不知道对方是多少。顺序一反(边缘 < 应用)就等于
// **应用层那句「超出多少 MB」永远到不了用户面前** —— 而两个包各自的单测都会全绿。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_BODY_BYTES } from "@/lib/genbi/cards-store";

const HERE = dirname(fileURLToPath(import.meta.url));
const WAF = resolve(HERE, "../../../../../infra/lib/waf-stack.ts");
const src = readFileSync(WAF, "utf8");

/** 从 infra 源码里取某条放行规则的 `maxBytes` 表达式并求值(只允许 `<num> * 1024 * 1024` 这一种形状)。 */
function maxBytesOf(uriPath: string): number | null {
  // 逐条切出 LARGE_BODY_ROUTES 里的对象块,按 uriPath 认准对象(不猜正则跨越多条)
  const blocks = src.split(/\n\s*\{\s*\n/).filter((b) => b.includes("uriPath:"));
  for (const b of blocks) {
    if (!b.includes(`uriPath: "${uriPath}"`)) continue;
    const m = b.match(/maxBytes:\s*(\d+)\s*\*\s*1024\s*\*\s*1024/);
    if (m) return Number(m[1]) * 1024 * 1024;
    const n = b.match(/maxBytes:\s*(\d+)\s*,/);
    return n ? Number(n[1]) : null;
  }
  return null;
}

describe("🔴🔴 WAF 大请求体放行清单 ↔ 应用层上限(跨层,顺序反了用户就看不到原因)", () => {
  it("会话卡片保存必须在放行清单里(不在 ⇒ >8KB 的对话被边缘层 403 拦掉,应用层说不上话)", () => {
    expect(src, "LARGE_BODY_ROUTES 不见了?").toContain("LARGE_BODY_ROUTES");
    expect(src, "🔴 /api/genbi/cards 不在大请求体放行清单里").toContain('uriPath: "/api/genbi/cards"');
    expect(maxBytesOf("/api/genbi/cards"), "取不到它的 maxBytes(形状变了就得改本判据)").toBeTruthy();
  });

  it("🔴 放行上限必须 **大于** 应用层上限(否则那句「超出多少 MB」永远到不了用户面前)", () => {
    const waf = maxBytesOf("/api/genbi/cards")!;
    expect(MAX_BODY_BYTES).toBe(20 * 1024 * 1024); // 变了就该一起看这条
    expect(waf, `WAF 放行 ${waf} ≤ 应用层 ${MAX_BODY_BYTES} ⇒ 超限用户拿到的是 CloudFront 403 HTML`)
      .toBeGreaterThan(MAX_BODY_BYTES);
  });

  it("优先级不许与固定规则撞号(WAF 要求唯一;撞了 CloudFormation 直接拒)", () => {
    const reserved = Number((src.match(/LARGE_BODY_PRIORITY_RESERVED\s*=\s*(\d+)/) || [])[1]);
    expect(reserved, "取不到预留区常量").toBeGreaterThan(0);
    // 放行条数必须还在预留区内
    const routes = (src.match(/uriPath: "/g) || []).length;
    expect(routes, `放行规则 ${routes} 条已超出预留区 ${reserved} —— 抬 LARGE_BODY_PRIORITY_RESERVED 并同步后移固定规则`)
      .toBeLessThanOrEqual(reserved);
    // 固定规则的 priority 必须都 ≥ 预留区
    const fixed = [...src.matchAll(/name: "(AWSManaged\w+|RateLimit)",\s*\n\s*priority: (\d+),/g)]
      .map((m) => ({ name: m[1], p: Number(m[2]) }));
    expect(fixed.length, "认不出固定规则(形状变了就得改本判据)").toBeGreaterThanOrEqual(4);
    for (const f of fixed) {
      expect(f.p, `${f.name} 的 priority=${f.p} 落进了放行预留区 [0,${reserved})`).toBeGreaterThanOrEqual(reserved);
    }
  });
});
