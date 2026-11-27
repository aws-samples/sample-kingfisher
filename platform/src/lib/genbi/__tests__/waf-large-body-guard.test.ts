// 🔴🔴 **跨层门禁(2026-09-13 真环境抓到的 P0)**:边缘层放行上限必须大于应用层自己的上限。
//
// 病史:CloudFront 前的 WAF 托管通用规则集 `SizeRestrictions_BODY` 拦掉**一切 >8KB 的请求体**,
// 而改动前只放行了 `/api/flink/connectors` 一条。于是「会话卡片」——**平台第一个持久化
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
import { BODY_LIMIT_RULES, PUBLIC_API_PREFIX } from "@/lib/http/body-limits";
import { INTERNAL_API_PREFIX } from "@/lib/scheduler/internal-source";

const HERE = dirname(fileURLToPath(import.meta.url));
const WAF = resolve(HERE, "../../../../../infra/lib/waf-stack.ts");
const src = readFileSync(WAF, "utf8");
const GATEWAY_SRC = readFileSync(resolve(HERE, "../../../middleware.ts"), "utf8");

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

  it("边缘整条放行的每条路由:放行上限必须大于应用层网关给这条路由的请求体上限(否则超限的拿不到网关那句人话)", () => {
    for (const [uriPath, ruleName] of [
      ["/api/flink/connectors", "flink-connector-upload"],
      ["/api/genbi/cards", "genbi-card-save"],
    ] as const) {
      const waf = maxBytesOf(uriPath)!;
      expect(waf, `取不到 ${uriPath} 的 maxBytes`).toBeTruthy();
      const rule = BODY_LIMIT_RULES.find((r) => r.name === ruleName);
      expect(rule, `应用层上限表里没有 ${ruleName}`).toBeTruthy();
      expect(rule!.prefix, `${ruleName} 的路径与边缘放行的路径不是同一条`).toBe(uriPath);
      expect(waf, `${uriPath}:边缘放行 ${waf} ≤ 网关上限 ${rule!.maxBytes}`).toBeGreaterThan(rule!.maxBytes);
    }
  });
});

// 2026-11-26 真实客户反馈:离线作业脚本约 160 行以上保存不了 —— 托管通用规则集按 8KB 拦掉了一切请求体,
// 带 id 的保存路由又登记不进只会精确匹配的放行清单。改法:大小那一条只打标签,边缘只对「页面 / 静态资源」与
// 「登录前公开接口、内部回环接口」按标签拦;其余 /api/** 交给应用层网关(lib/http/body-limits.ts)。
// 两层各写在各自的包里 ⇒ 这里钉住它们对得上:边缘不拦的,网关一定管;网关不管的,边缘一定拦。
describe("🔴🔴 请求体大小:边缘只拦页面 / 登录前接口,其余 /api/** 归应用层网关(跨层,对不上就有一段没人管)", () => {
  const constOf = (name: string): string => {
    const m = src.match(new RegExp(`export const ${name}(?::[^=]+)?\\s*=\\s*([^;]+);`));
    expect(m, `infra 源码里取不到 ${name}(形状变了就得改本判据)`).toBeTruthy();
    return m![1].trim();
  };

  it("托管规则里按大小拦的那一条被改成只计数(它的名字、它打的标签两个字面量没写错)", () => {
    expect(constOf("SIZE_RESTRICTION_BODY_RULE")).toBe('"SizeRestrictions_BODY"');
    expect(constOf("OVERSIZE_BODY_LABEL")).toBe('"awswaf:managed:aws:core-rule-set:SizeRestrictions_Body"');
    expect(src).toMatch(/ruleActionOverrides:\s*\[\{\s*name:\s*SIZE_RESTRICTION_BODY_RULE,\s*actionToUse:\s*\{\s*count:\s*\{\}\s*\}\s*\}\]/);
  });

  it("按标签拦的那条规则排在托管通用规则集之后(否则标签还没打上)、不与别的规则撞号、不落进放行预留区", () => {
    const reserved = Number((src.match(/LARGE_BODY_PRIORITY_RESERVED\s*=\s*(\d+)/) || [])[1]);
    const block = Number(constOf("OVERSIZE_BODY_BLOCK_PRIORITY"));
    const fixed = [...src.matchAll(/name: "(AWSManaged\w+|RateLimit)",\s*\n\s*priority: (\d+),/g)].map((m) => ({ name: m[1], p: Number(m[2]) }));
    const common = fixed.find((f) => f.name === "AWSManagedCommon");
    expect(common, "认不出托管通用规则集").toBeTruthy();
    expect(block).toBeGreaterThan(common!.p);
    expect(block).toBeGreaterThanOrEqual(reserved);
    expect(fixed.map((f) => f.p), "与固定规则撞号").not.toContain(block);
    expect(src).toMatch(/name: "BlockOversizeBodyOutsideAppApi",\s*\n\s*priority: OVERSIZE_BODY_BLOCK_PRIORITY,\s*\n\s*action: \{ block: \{\} \},/);
  });

  it("边缘「不按大小拦」的范围 = 网关管的范围:应用接口前缀与网关的匹配范围是同一个", () => {
    expect(constOf("APP_API_PREFIX")).toBe('"/api/"');
    expect(GATEWAY_SRC, "网关的匹配范围变了 ⇒ 边缘的前缀要一起看").toMatch(/matcher:\s*\["\/api\/:path\*"\]/);
  });

  it("边缘「仍按 8KB 拦」的两个前缀 = 网关不做登录校验、因而也不判大小的两个前缀(逐字相同)", () => {
    const literal = constOf("EDGE_SIZE_LIMITED_API_PREFIXES");
    const edge = [...literal.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(edge.sort()).toEqual([PUBLIC_API_PREFIX, INTERNAL_API_PREFIX].sort());
    // 网关里这两个前缀确实在大小判定之前就返回了(调用点,不是只有 import)
    const body = GATEWAY_SRC.slice(GATEWAY_SRC.indexOf("export async function middleware"));
    const firstGate = body.indexOf("proceedIfBodyFits(");
    expect(firstGate, "网关里找不到大小判定的调用点").toBeGreaterThan(-1);
    expect(body.indexOf("pathname.startsWith(PUBLIC_API_PREFIX)")).toBeGreaterThan(-1);
    expect(body.indexOf("pathname.startsWith(PUBLIC_API_PREFIX)")).toBeLessThan(firstGate);
    expect(body.indexOf("pathname.startsWith(INTERNAL_API_PREFIX)")).toBeGreaterThan(-1);
    expect(body.indexOf("pathname.startsWith(INTERNAL_API_PREFIX)")).toBeLessThan(firstGate);
  });

  it("网关源码里没有块注释的结尾记号(行注释里写着带星号的路径;一旦出现块注释,剥注释的源码扫描判据会把中间的代码一起剥掉)", () => {
    expect(GATEWAY_SRC).not.toContain("*/");
  });

  it("网关放行给路由的两条出口都先过大小判定(登录校验通过后、显式关闭鉴权时)", () => {
    const body = GATEWAY_SRC.slice(GATEWAY_SRC.indexOf("export async function middleware"));
    expect((body.match(/proceedIfBodyFits\(req, cid\)/g) ?? []).length).toBe(2);
    // 登录校验之后不许再有绕过大小判定的直接放行
    const afterAuth = body.slice(body.indexOf("jwtVerify("));
    expect(afterAuth).not.toMatch(/return proceed\(req, cid\)/);
  });
});
