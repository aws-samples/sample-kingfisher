// 🔴🔴 **告警去池化**—— 这一组判据钉的是**静默漏告**,不是显示错。
//
// 改动前:`success-rate` / `no-run` 把所有区的 run 揉成一个数 + 一个 `win#<bucket>` 桶。后果:
//   ① 一个区全挂、另一个区健康 ⇒ 总体不越阈值 ⇒ **不告警**;
//   ② 一个区完全断流,只要另一个区有一次成功 ⇒ **永远不报**;
//   ③ 即使某个区告出来了,同窗口里第二个区再挂也不会再告(桶键被第一个区用掉)。
import { describe, it, expect } from "vitest";
import { __matchRuleForTest as matchRule } from "../evaluate";
import type { AlertRule } from "../types";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const iso = (minsAgo: number) => new Date(NOW - minsAgo * 60000).toISOString();

function rule(cond: Record<string, unknown> = {}, scope: Record<string, unknown> = {}): AlertRule {
  return {
    pk: "alertrule", ruleId: "r1", name: "R", projectId: "p", enabled: true,
    scope: { taskType: "all", ...scope } as AlertRule["scope"],
    condition: { type: "success-rate", thresholdPercent: 80, windowMinutes: 60, ...cond } as AlertRule["condition"],
    severity: "P1", channelIds: [], enrichWithDiagnosis: false, silenced: false,
    createdBy: "u", createdAt: "", updatedAt: "", version: 1,
  };
}

// usw2 四次全失败,主控区六次全成功 ⇒ 池化 60%
const MIXED = [
  ...[0, 1, 2, 3].map((i) => ({ taskId: "t", runId: `a${i}`, status: "failed", finishedAt: iso(i + 1), targetId: "tgt_usw2_a" })),
  ...[0, 1, 2, 3, 4, 5].map((i) => ({ taskId: "t", runId: `h${i}`, status: "succeeded", finishedAt: iso(i + 1), targetId: "tgt_home" })),
];

describe("success-rate", () => {
  it("🔴🔴 一个区全挂 + 另一个区健康:池化**不报**(= 改动前的静默漏告),按区(缺省)**报**", () => {
    const pooled = matchRule(rule({ thresholdPercent: 50, evaluation: "pooled" }), MIXED, NOW);
    expect(pooled, "池化下 6/10=60% ≥ 50 ⇒ 不报").toHaveLength(0);
    const per = matchRule(rule({ thresholdPercent: 50 }), MIXED, NOW);
    expect(per).toHaveLength(1);
    expect(per[0].trigger.targetId).toBe("tgt_usw2_a");
    expect(per[0].message).toContain("tgt_usw2_a");
  });

  it("🔴 桶键必须带区:两个区同时越阈值 ⇒ 两条**不同** dedupeKey(否则第二个区被吞)", () => {
    const bothBad = [
      { taskId: "t", runId: "a1", status: "failed", finishedAt: iso(1), targetId: "tgt_usw2_a" },
      { taskId: "t", runId: "h1", status: "failed", finishedAt: iso(1), targetId: "tgt_home" },
    ];
    const out = matchRule(rule({ thresholdPercent: 50 }), bothBad, NOW);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((c) => c.dedupeKey)).size).toBe(2);
    for (const c of out) expect(c.dedupeKey).toMatch(/^win#\d+#tgt_/);
  });

  it("存量无章 run 归主控区(与全平台回落一致)", () => {
    const legacy = [{ taskId: "t", runId: "x", status: "failed", finishedAt: iso(1) }];
    const out = matchRule(rule({ thresholdPercent: 50 }), legacy, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].trigger.targetId).toBe("tgt_home");
  });

  it("规则可以只盯某几个区(scope.targets)", () => {
    const out = matchRule(rule({ thresholdPercent: 50 }, { targets: ["tgt_home"] }), MIXED, NOW);
    expect(out).toHaveLength(0);
  });
});

describe("no-run(断流)", () => {
  const CONF = { type: "no-run", windowMinutes: 60 };
  it("🔴🔴 一个区断流、另一个区有成功:池化**永远不报**,按区**报**", () => {
    const rows = [
      { taskId: "t", runId: "a1", status: "succeeded", finishedAt: iso(600), targetId: "tgt_usw2_a" },
      { taskId: "t", runId: "h1", status: "succeeded", finishedAt: iso(5), targetId: "tgt_home" },
    ];
    expect(matchRule(rule({ ...CONF, evaluation: "pooled" }), rows, NOW)).toHaveLength(0);
    const per = matchRule(rule(CONF), rows, NOW);
    expect(per).toHaveLength(1);
    expect(per[0].trigger.targetId).toBe("tgt_usw2_a");
  });

  it("🔴 候选区取「作用域里出现过的区」而不是「窗口内有 run 的区」—— 否则断流的那个区直接消失", () => {
    const rows = [{ taskId: "t", runId: "a1", status: "succeeded", finishedAt: iso(600), targetId: "tgt_usw2_a" }];
    const per = matchRule(rule(CONF), rows, NOW);
    expect(per.map((c) => c.trigger.targetId)).toEqual(["tgt_usw2_a"]);
  });

  it("规则显式点名的区即使一条 run 都没有也要报(那更该报断流)", () => {
    const per = matchRule(rule(CONF, { targets: ["tgt_home", "tgt_usw2_a"] }), [], NOW);
    expect(per.map((c) => c.trigger.targetId).sort()).toEqual(["tgt_home", "tgt_usw2_a"]);
  });
});

describe("单 run 类(failure / timeout)", () => {
  it("失败告警必须带上「哪个区」(dedupeKey 仍按 runId,不重复告)", () => {
    const rows = [{ taskId: "t", runId: "r9", status: "failed", finishedAt: iso(1), targetId: "tgt_usw2_a", error: "boom" }];
    const out = matchRule(rule({ type: "failure" }), rows, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].dedupeKey).toBe("run#r9");
    expect(out[0].trigger.targetId).toBe("tgt_usw2_a");
  });
});
