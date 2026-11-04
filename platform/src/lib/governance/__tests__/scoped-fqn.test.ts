// @kf-batch 50-WP4quater-reads(工单 SC-8)
/**
 * 钉住治理记录的区维。用户 2026-09-10 点名的根因:
 * 「治理健康分依赖质量 / 血缘 / 分类三路信号,而它们的键里没有区维(按 fqn 聚合)——
 *  **同名表跨区会互相顶,按区出分会串味**」。
 *
 * 🔴 两条最容易写错、且错了完全无声的地方,各钉一条:
 *   ① **home 必须是裸 fqn**。一旦给 home 也加前缀,全部存量治理数据(标签 / 规则 / 结果 / 血缘)
 *      一夜之间「消失」—— 因为读的是新键、数据在老键上。零迁移就是靠这一条成立的;
 *   ② **非法 targetId 不许静默退回裸 fqn**。退回的后果是那条记录写进了主控区的分区,
 *      从此与主控区的记录互相覆盖 —— 正是这一刀要修的病,而且是它最隐蔽的复发形式。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scopedFqn, parseScopedFqn, displayFqn, scopedFqnInTargets, governanceTargetFrom } from "../scoped-fqn";

const SRC = resolve(__dirname, "../../..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const read = (p: string) => strip(readFileSync(resolve(SRC, p), "utf8"));

const FQN = "redshift.dev.public.orders";
const USW2 = "tgt_usw2_a";

describe("scopedFqn:治理记录的分区键", () => {
  it("🔴 home / 不传 ⇒ **裸 fqn**(存量零迁移就靠这一条)", () => {
    expect(scopedFqn(FQN)).toBe(FQN);
    expect(scopedFqn(FQN, "tgt_home")).toBe(FQN);
    expect(scopedFqn(FQN, null)).toBe(FQN);
  });

  it("非 home ⇒ 带区前缀,且与 home 的键**不相等**(这就是「不再互相顶」)", () => {
    const k = scopedFqn(FQN, USW2);
    expect(k).toBe(`${USW2}::${FQN}`);
    expect(k).not.toBe(scopedFqn(FQN, "tgt_home"));
  });

  it("幂等:已经带前缀的键再传一次不会套两层", () => {
    const once = scopedFqn(FQN, USW2);
    expect(scopedFqn(once, USW2)).toBe(once);
  });

  it("🔴 非法 targetId 必须**抛**,绝不静默退回裸 fqn", () => {
    for (const bad of ["TGT_UPPER", "tgt bad", "global", "tgt_"]) {
      expect(() => scopedFqn(FQN, bad), `「${bad}」应当被拒`).toThrow(/非法 targetId/);
    }
  });

  it("空 fqn 拒掉(空键会把所有表的记录堆到同一个分区)", () => {
    expect(() => scopedFqn("", USW2)).toThrow();
  });

  it("parse / display:裸 fqn ⇒ 主控区;带前缀 ⇒ 解出两段", () => {
    expect(parseScopedFqn(FQN)).toEqual({ fqn: FQN, targetId: "tgt_home" });
    expect(parseScopedFqn(`${USW2}::${FQN}`)).toEqual({ fqn: FQN, targetId: USW2 });
    expect(displayFqn(`${USW2}::${FQN}`), "给人看的表名里不许混着 tgt_xxx:: 前缀").toBe(FQN);
  });

  it("🔴 分隔符 `::` 在 fqn(点分)与 targetId(下划线)里都不会出现 ⇒ 解析无歧义", () => {
    expect(FQN.includes("::")).toBe(false);
    expect(USW2.includes("::")).toBe(false);
    // 表名里真带点也没问题(只切第一个 `::`)
    expect(parseScopedFqn(`${USW2}::a.b.c.d`).fqn).toBe("a.b.c.d");
  });

  it("scopedFqnInTargets:空范围 ⇒ 全放过;裸 fqn 算主控区", () => {
    expect(scopedFqnInTargets(FQN, [])).toBe(true);
    expect(scopedFqnInTargets(FQN, ["tgt_home"])).toBe(true);
    expect(scopedFqnInTargets(FQN, [USW2])).toBe(false);
    expect(scopedFqnInTargets(`${USW2}::${FQN}`, [USW2])).toBe(true);
  });
});

describe("governanceTargetFrom:从请求解析这张表在哪个区", () => {
  const q = (s: string) => new URLSearchParams(s);
  it("`?targetId=` 优先", () => {
    expect(governanceTargetFrom(q(`targetId=${USW2}&scope=tgt_home`))).toBe(USW2);
  });
  it("否则用 `?scope=` 的**单区**;分组 / 全局回主控区", () => {
    expect(governanceTargetFrom(q(`scope=${USW2}`))).toBe(USW2);
    expect(governanceTargetFrom(q("scope=global"))).toBe("tgt_home");
    expect(governanceTargetFrom(q(`scope=compare:${USW2},tgt_home`))).toBe("tgt_home");
    expect(governanceTargetFrom(q(""))).toBe("tgt_home");
  });
  it("🔴 `?scope=` 的文法只有一个作者(parseScope)—— 这里不许再写一份", () => {
    const src = read("lib/governance/scoped-fqn.ts");
    expect(src).toContain("parseScope(");
    // 第一版我按 `target:` 前缀猜过,而 parseScope 的单区形态是**裸 targetId** ⇒ 那种串它根本不认
    expect(src).not.toContain('startsWith("target:")');
  });
});

describe("🔴 结构性:治理读写两侧必须用同一个键", () => {
  const FILES = [
    "app/api/governance/classification/route.ts",
    "app/api/governance/quality-rules/route.ts",
    "app/api/governance/quality-rules/[id]/route.ts",
    "app/api/governance/quality-results/route.ts",
    "app/api/governance/quality-run/route.ts",
    "app/api/governance/lineage/route.ts",
  ];
  it("每个治理路由都过 scopedFqn(写裸 fqn 而读按区键 ⇒ 读不到自己刚写的)", () => {
    const bad = FILES.filter((f) => !read(f).includes("scopedFqn("));
    expect(bad, `这些路由没过按区键:${bad.join(" / ")}`).toEqual([]);
  });
  it("健康分:缓存按 target 分键 + 表全集从那个区的数仓探", () => {
    const src = read("lib/governance/health-service.ts");
    expect(src, "全局缓存会让切区后 60 秒内看到主控区的分").toContain("_cache.get(wantTarget)");
    expect(src, "用主控区 workgroup 探别的区 ⇒ 分母就是错的").toContain("resolveRedshiftBinding(");
    expect(src).toContain("parseScopedFqn(");
  });
});
