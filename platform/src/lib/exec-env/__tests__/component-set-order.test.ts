// @kf-batch 50-P50.3b-3-p0e-baseline
// 🔴 **真环境 P0 回归**(2026-09-03,用户实测报的那个):
//    页面「检测初始化」报 `legacyCompletionFence 的 probe/desired/observed/input 非法或未精确覆盖组件`,
//    且周期收养永远写不进 `observed`。
//
// 【根因】完成栅栏用 `JSON.stringify(a) === JSON.stringify(b)` 比三份组件清单,而同一份清单在系统里
//   有**两种排序**:`orderComponents()` 的规范序 vs 生产者原始序(legacy 收养 `[...t.components]`;
//   broker 直接存**客户端传来的**次序)。组件清单的语义是**集合**,不是序列 ⇒ 逐字节比是错的判据。
//
// 【为什么单测之前没逮到】既有单测的 fixture 组件清单**恰好都是规范序**(多为 `["core"]` / `["core","redshift"]`),
//   而真实 home 是 `core,redshift,mwaa,dms,flink,agentcore`(`mwaa`/`agentcore` 属 PENDING ⇒ 被 orderComponents
//   排到尾部并按字母序)⇒ 规范序变成 `core,redshift,dms,flink,agentcore,mwaa`,与原始序不同。
//   ⇒ 本文件**把真实生产数据钉成 fixture**,并用**全排列**杜绝"fixture 恰好同序"这个假绿来源。
import { describe, it, expect } from "vitest";
import { componentSetKey, sameComponentSet, isGreenProbeForComponents } from "@/lib/exec-env/component-contract";
import { orderComponents } from "@/lib/exec-env/implemented-components";
import { adoptLegacyAfterFreshProbe } from "@/lib/exec-env/lifecycle";
import type { ExecutionTarget } from "@/lib/exec-env/registry";

/** 🔴 2026-09-03 真环境 tgt_home 的实际组件清单(逐字节抄自 DDB,不是编的)。 */
const REAL_HOME_COMPONENTS = ["core", "redshift", "mwaa", "dms", "flink", "agentcore"];
/** 🔴 真环境 tgt_home 的实际探活项(13 项全绿,逐字节抄自 DDB)。 */
const REAL_HOME_PROBE_ITEMS = [
  "datalakeBucket", "scriptsBucket", "tableBucket", "athenaWorkgroup", "emrSecurityGroupId", "glueRoleArn",
  "redshift:workgroup", "mwaa:environment", "dms:subnet-group", "flink:role",
  "agentcore:runtime", "agentcore:memory", "agentcore:gateway",
].map((name) => ({ name, ok: true }));

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i++) {
    const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
    for (const p of permutations(rest)) out.push([xs[i], ...p]);
  }
  return out;
}

describe("🔴 组件清单是【集合】不是【序列】(真环境 P0 回归)", () => {
  it("真环境 home 清单的规范序 ≠ 原始序 —— 这正是原缺陷的触发条件(先把前提钉住)", () => {
    const canonical = orderComponents(REAL_HOME_COMPONENTS);
    expect(canonical).toEqual(["core", "redshift", "dms", "flink", "mwaa", "agentcore"]); // WP-13:mwaa 已实现,进已实现序;agentcore 仍排尾
    // 🔴 若哪天这两者变成同序,本文件其余断言就失去意义 ⇒ 这条断言是"测试仍有效"的守卫。
    expect(JSON.stringify(canonical)).not.toBe(JSON.stringify(REAL_HOME_COMPONENTS));
  });

  it("sameComponentSet:原始序 vs 规范序 ⇒ 同集合(旧的逐字节比在这里判不等 = 探活必炸)", () => {
    expect(sameComponentSet(REAL_HOME_COMPONENTS, orderComponents(REAL_HOME_COMPONENTS))).toBe(true);
    expect(JSON.stringify(REAL_HOME_COMPONENTS)).not.toBe(JSON.stringify(orderComponents(REAL_HOME_COMPONENTS)));
  });

  it("**全排列**(6! = 720 种)两两之间都判同集合 —— 杜绝「fixture 恰好同序」的假绿", () => {
    const perms = permutations(REAL_HOME_COMPONENTS);
    expect(perms.length).toBe(720);
    const key = componentSetKey(REAL_HOME_COMPONENTS);
    for (const p of perms) expect(componentSetKey(p)).toBe(key);
    // 抽样做两两比较(720² 太多;取首尾与随机若干足够,且数量断言防循环失效)
    let compared = 0;
    for (const p of [perms[0], perms[1], perms[359], perms[718], perms[719]]) {
      for (const q of [perms[0], perms[123], perms[719]]) {
        expect(sameComponentSet(p, q)).toBe(true);
        compared++;
      }
    }
    expect(compared).toBe(15);
  });

  it("🔴 负向:集合**真的不同**照样判不等(partial-green 防线一分不减)", () => {
    expect(sameComponentSet(REAL_HOME_COMPONENTS, ["core", "redshift"])).toBe(false);
    expect(sameComponentSet(["core"], ["core", "redshift"])).toBe(false);
    expect(sameComponentSet(["core", "redshift"], ["core", "dms"])).toBe(false);
    // 空集不等于非空
    expect(sameComponentSet([], ["core"])).toBe(false);
  });

  it("重复项被归一(库里若存了重复,不该因此判不等)", () => {
    expect(sameComponentSet(["core", "core", "redshift"], ["redshift", "core"])).toBe(true);
  });

  it("真环境 13 项探活对真环境 6 组件 ⇒ 精确覆盖成立(次序无关,这条本来就是集合语义)", () => {
    expect(isGreenProbeForComponents(REAL_HOME_COMPONENTS, REAL_HOME_PROBE_ITEMS)).toBe(true);
    expect(isGreenProbeForComponents(orderComponents(REAL_HOME_COMPONENTS), REAL_HOME_PROBE_ITEMS)).toBe(true);
    // 负向:少声明一个组件 ⇒ 有项归属到未声明组件 ⇒ false(不是"多探了没关系")
    expect(isGreenProbeForComponents(["core", "redshift"], REAL_HOME_PROBE_ITEMS)).toBe(false);
  });

  it("adoptLegacyAfterFreshProbe 落库的两轴都是**规范序**(持久化数据不再一个原始序一个规范序)", () => {
    const probe = { at: "2026-09-03T04:57:02.879Z", ok: true, items: REAL_HOME_PROBE_ITEMS };
    const t = { targetId: "tgt_home", components: REAL_HOME_COMPONENTS } as unknown as ExecutionTarget;
    const { spec, observed } = adoptLegacyAfterFreshProbe(t, probe as never, "stable");
    const canonical = orderComponents(REAL_HOME_COMPONENTS);
    expect(spec.desiredComponents).toEqual(canonical);
    expect(observed.components).toEqual(canonical);
    // 集合不变(收养绝不悄悄丢/加组件)
    expect(sameComponentSet(spec.desiredComponents, REAL_HOME_COMPONENTS)).toBe(true);
  });
});
