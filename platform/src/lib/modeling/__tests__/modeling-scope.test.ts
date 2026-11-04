// @kf-batch 50-WP4quater-reads(工单 SC-37)
/**
 * 钉住建模四块的区维。用户 2026-09-10 驳回了我写的「平台级定义,本身不分区(设计如此)」:
 * 「**这里为什么不能做成区域维度?我认为都可以切出来的。**」
 *
 * 🔴 这里最容易写错的一点:**两种语义相反的回落**。
 *   · 治理约定(分层 / 数据域 / 数据标准):**未声明适用区 ⇒ 全平台通用**(任何视角都看得到);
 *   · 执行体 / 计算结果(B 类 `targets[]`、A 类 `targetId`):**无章 ⇒ 归主控区**。
 * 把前者写成后者,存量定义会在非主控区视角**整体消失**,而用户只会以为「这个区没有规范」。
 * 所以下面的夹具刻意同时放「未声明」「声明了别的区」「声明了本区」三种行,三个方向各断一次。
 */
import { describe, it, expect } from "vitest";
import { filterRowsByApplicableScope } from "@/lib/exec-env/scope";
import { metricValueFor } from "../model-metrics";

const HOME = "tgt_home";
const USW2 = "tgt_usw2_a";

describe("治理约定的适用区(SC-37)", () => {
  const rows = [
    { code: "ODS" }, // 未声明 ⇒ 全平台通用
    { code: "DWD", targets: [USW2] }, // 只适用于 usw2
    { code: "ADS", targets: [HOME] }, // 只适用于主控区
    { code: "TMP", targets: [] as string[] }, // 空数组 —— 也当「未声明」处理(见下)
  ];

  it("🔴 未声明适用区的定义,在**任何**视角都看得到(不是「归主控区」)", () => {
    const atUsw2 = filterRowsByApplicableScope(rows as Array<Record<string, unknown>>, { kind: "target", targetId: USW2 }).map((r) => r.code);
    expect(atUsw2, "未声明 = 全平台通用 ⇒ ODS 必须在 usw2 视角里").toContain("ODS");
    expect(atUsw2).toContain("DWD");
    expect(atUsw2, "声明了只适用主控区的,不该出现在 usw2").not.toContain("ADS");
  });

  it("声明了本区的看得到;主控区视角同理", () => {
    const atHome = filterRowsByApplicableScope(rows as Array<Record<string, unknown>>, { kind: "target", targetId: HOME }).map((r) => r.code);
    expect(atHome).toEqual(["ODS", "ADS", "TMP"]);
  });

  it("🔴 空数组必须与「未声明」同解:否则那条定义会在所有视角里消失(fail-silent)", () => {
    for (const t of [HOME, USW2]) {
      expect(
        filterRowsByApplicableScope(rows as Array<Record<string, unknown>>, { kind: "target", targetId: t }).map((r) => r.code),
        `空 targets 的行在 ${t} 视角消失了`
      ).toContain("TMP");
    }
  });

  it("全局视角一条不少", () => {
    expect(filterRowsByApplicableScope(rows as Array<Record<string, unknown>>, { kind: "global" })).toHaveLength(4);
  });
});

describe("指标计算值按区(SC-37)", () => {
  const m = {
    valueByTarget: { [HOME]: { value: 100, computedAt: "2026-09-10T00:00:00Z" }, [USW2]: { value: 7, computedAt: "2026-09-10T01:00:00Z" } },
    lastValue: 7,
    lastComputedAt: "2026-09-10T01:00:00Z",
    lastTargetId: USW2,
  };

  it("各区给各自的值(🔴 两个值刻意差得很远 —— 否则这条判据没有判别力)", () => {
    expect(metricValueFor(m, HOME)!.value).toBe(100);
    expect(metricValueFor(m, USW2)!.value).toBe(7);
    expect(metricValueFor(m, HOME)!.legacy).toBe(false);
  });

  it("🔴 该区没算过 ⇒ 回 null,**绝不**回落 lastValue(那是别区的数字)", () => {
    expect(metricValueFor(m, "tgt_eu_1")).toBeNull();
    // 若回落成 lastValue(7),界面上 eu 区就会显示一个 usw2 算出来的数字 —— 错得完全无声
  });

  it("落章之前算的存量行(没有 valueByTarget)⇒ 回 lastValue 并标 legacy", () => {
    const legacy = { lastValue: 42, lastComputedAt: "2026-09-01T00:00:00Z" };
    const v = metricValueFor(legacy, USW2)!;
    expect(v.value).toBe(42);
    expect(v.legacy).toBe(true);
  });

  it("从来没算过 ⇒ null(不是 0 —— 0 是个会被当成真值的数字)", () => {
    expect(metricValueFor({}, HOME)).toBeNull();
  });
});
