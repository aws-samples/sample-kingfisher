// @kf-batch 50-WP4quater-reads(工单 SC-24)
/**
 * 钉住成本按区。用户 2026-09-10:「『成本大盘』与『预算护栏』仍是全平台合计 ——
 * 账单来自 Cost Explorer 的服务维度采集,按区拆分需要**多采一个 REGION 分组并重采存量**」。
 *
 * 🔴 这一刀最危险的错法不是「少算」而是「**算错**」:
 *   ① 存量行(落 REGION 分组之前采的)是**账号级服务合计**。把它回落给主控区 ⇒
 *      主控区的成本凭空多出别区的账,而这个数字看起来完全正常;
 *   ② 旧格式行不删就与新按区行**共存**在同一个 pk ⇒ 大盘把同一笔钱算**两遍**;
 *   ③ sk 不带 region ⇒ 同一天同一服务的第二个区**覆盖**第一个区 ⇒ 总额少算,且无声。
 * 下面每一条都各自钉一个。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("成本采集的区维(SC-24)", () => {
  const collector = strip(read("lib/finops/collector.ts"));
  const store = strip(read("lib/finops/store.ts"));

  it("🔴 CE 必须多采一个 REGION 分组(SERVICE + REGION,CE 上限正好两个)", () => {
    expect(collector).toContain('{ Type: "DIMENSION", Key: "SERVICE" }');
    expect(collector).toContain('{ Type: "DIMENSION", Key: "REGION" }');
  });

  it("🔴 sk 必须带 region,否则第二个区会覆盖第一个区(总额少算、无声)", () => {
    expect(store).toContain("`${row.date}#${row.service}#${row.region}`");
  });

  it("🔴 REGION 缺失时必须落 `NoRegion` 字面量,不能留空", () => {
    // 留空会让 v2 写侧 fail-closed 拒写(store.upsertCostDaily)—— 这一趟采集就白采了
    expect(collector).toContain('|| "NoRegion"');
  });

  // @kf-batch 50-WP6-cost-by-region —— 原判据「重采后必须删掉旧格式行」被合同订正取代:
  // WP-6 ④「读侧只读 v2;旧行留待 TTL」⇒ 换 pk 前缀让混计**结构上读不到**,不再删任何行。
  it("🔴 WP-6:采集器不删任何成本日行(旧分区留着,回滚读侧时仍可用)", () => {
    expect(collector).not.toMatch(/purge|DeleteCommand/);
    expect(store).not.toContain("purgeLegacyCostDaily");
  });

  it("🔴 WP-6:pk 只经 `COST_DAILY_PK_PREFIX`(v2)拼,不许散写 `cost#`", () => {
    expect(store).toContain("`${COST_DAILY_PK_PREFIX}${month}`");
    expect(store).not.toMatch(/`cost#\$\{/);
  });
});

describe("大盘 / 预算按区的三条处置(SC-24)", () => {
  const overview = strip(read("app/api/finops/overview/route.ts"));
  const budgets = strip(read("app/api/finops/budgets/route.ts"));
  const evalSrc = strip(read("lib/finops/budget-eval.ts"));

  it("🔴 全局服务**不算进任何区**,而是单独如实报出", () => {
    expect(overview).toContain("isUnattributed");
    expect(overview).toContain("unattributedUsd");
    expect(overview, "必须把「有多少钱还没归区」说给用户,否则他会拿合计去对账单总额").toContain("unattributedNote");
    // @kf-batch 50-WP6-cost-by-region —— 「存量行 / 立即重采」分支随 v2 读侧一起删除(旧分区读不到了)
    expect(overview).not.toContain("needsRecollect");
    // 🔴 负向:不许出现「无 region ⇒ 当成主控区」这类回落
    expect(overview).not.toMatch(/region\s*\|\|\s*process\.env\.AWS_REGION/);
  });

  it("🔴 只有 region 作用域的预算被范围筛掉;账号 / 服务 / 项目作用域横切所有区", () => {
    // @kf-batch 50-WP6-cost-by-region —— 视角 → 区集合只许经 `regionsInViewOf`(全部视角 = null)
    expect(budgets).toContain("regionsInViewOf(scope)");
    expect(budgets).toContain('b.scope.kind !== "region" || regions.has(b.scope.region)');
  });

  it("region 预算只算那个区的花费(存量行不算进来)", () => {
    expect(evalSrc).toContain('if (b.scope.kind === "region")');
    expect(evalSrc).toContain('(r.region || "") === want');
  });

  it("🔴 targetId → region 的换算必须有单一处(拿 targetId 比 region 字符串永远不匹配 ⇒ 恒为 0)", () => {
    const conv = strip(read("lib/finops/cost-region.ts"));
    expect(conv).toContain("listActiveTargetsForScope");
    // 解析不到 region 的 target 必须跳过,而不是回落主控区(那会把它的成本算成主控区的)
    expect(conv).toMatch(/if \(typeof region === "string" && region\) out\.set\(tid, region\);/);
  });
});
