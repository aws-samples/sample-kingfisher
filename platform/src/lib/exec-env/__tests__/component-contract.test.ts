// @kf-batch 50-P50.3b-lifecycle-rootfix
// component-contract.ts —— 探活项↔组件归属 + 「精确 green 覆盖」判定的单测。
// 🔴 SSOT 钉:这里列的 green 态 item 名必须与 probe-runner.ts runProbe() 的产物一致(改 probe-runner 命名必同步)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { componentForProbeItem, isGreenProbeForComponents } from "@/lib/exec-env/component-contract";

// probe-runner.ts runProbe() 的 **green 态** item 名(逐项对照该文件):
// @kf-batch 50-W5-seg1-WP3:+emrExecutionRoleArn(core 键,描述符有才出项)
// 序 48 / B-105:+lake:s3tablescatalog(区级 S3 Tables 联邦目录,core 袋)
const CORE_ITEMS = ["datalakeBucket", "scriptsBucket", "tableBucket", "athenaWorkgroup", "emrSecurityGroupId", "glueRoleArn", "emrExecutionRoleArn", "lake:s3tablescatalog"];
const NON_CORE = {
  redshift: ["redshift:workgroup", "redshift:copy-role"],
  mwaa: ["mwaa:environment"],
  dms: ["dms:subnet-group", "dms:kinesis-role"],
  flink: ["flink:role"],
  agentcore: ["agentcore:runtime", "agentcore:memory", "agentcore:gateway"],
  // @kf-batch 50-W5-seg1-WP10a
  "residency-api": ["residency-api:audit-table", "residency-api:results-table", "residency-api:bucket"],
};
const ok = (name: string) => ({ name, ok: true });

describe("componentForProbeItem(SSOT:与 probe-runner green 态命名一致)", () => {
  it("core 六项(无冒号)+ 字面 core ⇒ core", () => {
    for (const n of [...CORE_ITEMS, "core"]) expect(componentForProbeItem(n), n).toBe("core");
  });
  it("非 core 组件项(<comp>:<子项>)⇒ 对应组件", () => {
    for (const [comp, names] of Object.entries(NON_CORE)) {
      for (const n of names) expect(componentForProbeItem(n), n).toBe(comp);
    }
  });
  it("🔴 归属不了的项 ⇒ null(fail-closed;不默默算进某组件)", () => {
    expect(componentForProbeItem("totally-made-up")).toBeNull();
    expect(componentForProbeItem("")).toBeNull();
    expect(componentForProbeItem("unknownprefix:x")).toBeNull();
  });
});

describe("isGreenProbeForComponents(精确 green 覆盖)", () => {
  it("core 单组件:六项全绿 ⇒ true", () => {
    expect(isGreenProbeForComponents(["core"], CORE_ITEMS.map(ok))).toBe(true);
    // 最小 green(一项 core 即覆盖 core)
    expect(isGreenProbeForComponents(["core"], [ok("datalakeBucket")])).toBe(true);
  });
  it("core + dms 全绿 ⇒ true", () => {
    expect(isGreenProbeForComponents(["core", "dms"], [ok("datalakeBucket"), ok("dms:subnet-group")])).toBe(true);
  });
  it("🔴 partial green:声称 core+dms 但只探了 core ⇒ false(漏项)", () => {
    expect(isGreenProbeForComponents(["core", "dms"], [ok("datalakeBucket")])).toBe(false);
  });
  it("🔴 有属于未声明组件的项 ⇒ false(声称 core 却混入 dms 绿项)", () => {
    expect(isGreenProbeForComponents(["core"], [ok("datalakeBucket"), ok("dms:subnet-group")])).toBe(false);
  });
  it("🔴 任一项红 ⇒ false(非全绿)", () => {
    expect(isGreenProbeForComponents(["core"], [{ name: "datalakeBucket", ok: false, error: "gone" }])).toBe(false);
  });
  it("🔴 有归属不了的项 ⇒ false", () => {
    expect(isGreenProbeForComponents(["core"], [ok("datalakeBucket"), ok("mystery-item")])).toBe(false);
  });
  it("空 items / 空组件集 ⇒ false", () => {
    expect(isGreenProbeForComponents(["core"], [])).toBe(false);
    expect(isGreenProbeForComponents([], [ok("datalakeBucket")])).toBe(false);
  });
});

// 🔴 B-105 棘轮(2026-10-19 …7237 序 48 演练抓到):上面手抄的项名清单本身就是漂移源 —— 探活器加了 `lake:s3tablescatalog`,
//   这里没人补,两侧单测照旧全绿,而真环境里所有执行环境的「精确 green 覆盖」恒 false(新区永远进不了 testing、存量区全降级)。
//   ⇒ 不再只靠手抄:直接读 probe-runner.ts 源码,把每个探活项名字面量逐个过 componentForProbeItem;装配层另有
//   probe-runner.test.ts「B-105 装配」用真跑的产物再钉一次(两道网:源码字面量 + 运行时产物)。
describe("🔴 B-105 棘轮:probe-runner.ts 里每个探活项名字面量都必须归属到某个组件", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const RUNNER_SRC = readFileSync(resolve(HERE, "../probe-runner.ts"), "utf8");
  // sdkClient("<plane>", …) 的第一个参数也是 `x:y` 形(如 central:agentcore),不是探活项 ⇒ 按调用位置排除,不按名字排除
  const PLANE_KINDS = new Set([...RUNNER_SRC.matchAll(/sdkClient\(\s*"([^"]+)"/g)].map((m) => m[1]));
  it("probeOne(\"…\") 字面量 + 所有 <comp>:<sub> 形字面量(排除 sdkClient 平面名)⇒ componentForProbeItem 全部非 null", () => {
    const names = new Set<string>();
    for (const m of RUNNER_SRC.matchAll(/probeOne\(\s*"([^"]+)"/g)) names.add(m[1]);
    for (const m of RUNNER_SRC.matchAll(/"([a-zA-Z][a-zA-Z0-9-]*:[a-zA-Z][a-zA-Z0-9-]*)"/g)) if (!PLANE_KINDS.has(m[1])) names.add(m[1]);
    // 清单不许缩水成「什么都没扫到就通过」(空输入 ⇒ 零工作 ⇒ 报成功)
    expect(names.size).toBeGreaterThanOrEqual(18);
    expect(names.has("lake:s3tablescatalog")).toBe(true);
    const orphan = [...names].filter((n) => componentForProbeItem(n) === null).sort();
    expect(orphan, `这些探活项没登记进 component-contract.ts:${orphan.join(", ")}`).toEqual([]);
  });
});
