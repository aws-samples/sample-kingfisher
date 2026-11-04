// @kf-batch 50-WP4ter-coverage
// 定义行区章的单一作者 + **执行侧反向卡**。
//
// 🔴 反向卡是这一刀里最要紧的判据:它保证「加了区维」不会退化成「加了一个骗人的区维」。
import { describe, it, expect } from "vitest";
import {
  DEFINITION_BINDING_ATTR,
  bindingForNewSyncTask,
  assertDefinitionRunsHere,
  DefinitionBindingMismatch,
  boundToHomeOnly,
} from "../definition-binding";
import { HOME_TARGET_ID } from "../target-id";

describe("章的字段名", () => {
  it("与 filterRowsByScope / bindingTargets 同源(不是另起一个名字)", () => {
    expect(DEFINITION_BINDING_ATTR).toBe("targets");
  });
});

describe("bindingForNewSyncTask", () => {
  it("章从数据源的 ownerTargetId 导出", () => {
    expect(bindingForNewSyncTask({ ownerTargetId: "tgt_usw2_a" })).toEqual({ targets: ["tgt_usw2_a"] });
  });
  it("没有源 / 源没落点 ⇒ 主控区(建源一期恒落主控区,这是历史事实不是猜测)", () => {
    expect(bindingForNewSyncTask(null)).toEqual({ targets: [HOME_TARGET_ID] });
    expect(bindingForNewSyncTask({})).toEqual({ targets: [HOME_TARGET_ID] });
    expect(bindingForNewSyncTask({ ownerTargetId: "" })).toEqual({ targets: [HOME_TARGET_ID] });
  });
  it("🔴 不接受调用方传「当前视角」当落点(函数签名里根本没有那个入口)", () => {
    // 形参只有数据源行 —— 视角是看东西的角度,不是执行落点(SPEC §2.6.3)
    expect(bindingForNewSyncTask.length).toBe(1);
  });
});

describe("assertDefinitionRunsHere(反向卡)", () => {
  it("章 = 主控区,在主控区跑 ⇒ 放行", () => {
    expect(() => assertDefinitionRunsHere({ targets: [HOME_TARGET_ID] }, "同步任务", HOME_TARGET_ID)).not.toThrow();
  });
  it("🔴 存量行(无章)在主控区跑 ⇒ 放行(三级回落归主控区)", () => {
    expect(() => assertDefinitionRunsHere({}, "同步任务", HOME_TARGET_ID)).not.toThrow();
    expect(() => assertDefinitionRunsHere(null, "同步任务", HOME_TARGET_ID)).not.toThrow();
  });
  it("🔴🔴 章 = usw2 而执行通道只在主控区 ⇒ **拒跑**(这就是防「跑错区」的那一格)", () => {
    let err: unknown;
    try {
      assertDefinitionRunsHere({ targets: ["tgt_usw2_a"] }, "同步任务", HOME_TARGET_ID);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DefinitionBindingMismatch);
    const m = err as DefinitionBindingMismatch;
    expect(m.bound).toEqual(["tgt_usw2_a"]);
    expect(m.runningIn).toBe(HOME_TARGET_ID);
    // 报错文案必须点名两边,否则用户看不懂为什么被拒
    expect(m.message).toContain("tgt_usw2_a");
    expect(m.message).toContain(HOME_TARGET_ID);
  });
  it("多区章里含当前落点 ⇒ 放行(它真能在这里跑)", () => {
    expect(() =>
      assertDefinitionRunsHere({ targets: [HOME_TARGET_ID, "tgt_usw2_a"] }, "同步任务", HOME_TARGET_ID)
    ).not.toThrow();
  });
  it("单值 targetId 形态也认(三级回落的第二级)", () => {
    expect(() => assertDefinitionRunsHere({ targetId: "tgt_usw2_a" }, "同步任务", HOME_TARGET_ID)).toThrow(
      DefinitionBindingMismatch
    );
  });
});

describe("boundToHomeOnly", () => {
  it("只绑主控区 / 存量无章 ⇒ true;绑了别的区 ⇒ false", () => {
    expect(boundToHomeOnly({ targets: [HOME_TARGET_ID] })).toBe(true);
    expect(boundToHomeOnly({})).toBe(true);
    expect(boundToHomeOnly({ targets: ["tgt_usw2_a"] })).toBe(false);
    expect(boundToHomeOnly({ targets: [HOME_TARGET_ID, "tgt_usw2_a"] })).toBe(false);
  });
});
