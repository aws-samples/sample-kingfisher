// @kf-batch 50-WP15-airflow-serverless
// 🔴 W3e-12 真撞(2026-09-06):`/api/exec-targets` 回 `{targets}`,EMR 面板仍按数组读 ⇒「全选当前活跃区(0)」灰掉,作业只能绑 home。
// 修法 = 读法单一作者 + 本守卫:页面不许再自己 fetch 这条路由;形状归一化有单测。
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeExecTargets } from "@/lib/exec-env/exec-targets-client";
import { EXEC_TARGET_COMPONENT_DIMS } from "@/lib/exec-env/exec-targets-dims";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");
/** 六个消费者(B-109 补进编排页与治理建表向导 —— 它们当时漏在名单外,传的维度路由不认也没人看见)。 */
const CONSUMERS = [
  "app/etl-jobs/page.tsx",
  "app/redshift/page.tsx",
  "app/modeling/page.tsx",
  "components/engines/EmrJobPanel.tsx",
  "app/workflow/page.tsx",
  "components/governance/CreateTableWizard.tsx",
];
const strip = (raw: string) => raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const walk = (dir: string, acc: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "__tests__" || e === ".next") continue;
    const fp = resolve(dir, e);
    if (statSync(fp).isDirectory()) walk(fp, acc);
    else if (/\.(ts|tsx)$/.test(e)) acc.push(fp);
  }
  return acc;
};

describe("normalizeExecTargets:一个路由多个消费者,形状只在这里认一次", () => {
  it("现行 {targets:[…]} ⇒ 数组;兼容裸数组;字段缺省补齐", () => {
    expect(normalizeExecTargets({ targets: [{ targetId: "tgt_home", isHome: true }, { targetId: "tgt_usw2_a", region: "us-west-2", jurisdiction: "home" }] })).toEqual([
      { targetId: "tgt_home", region: "", isHome: true },
      { targetId: "tgt_usw2_a", region: "us-west-2", isHome: false, jurisdiction: "home" },
    ]);
    expect(normalizeExecTargets([{ targetId: "tgt_home" }])).toEqual([{ targetId: "tgt_home", region: "", isHome: false }]);
  });
  it("形状异常显式抛(不许静默回空:空 = 界面只剩 home,用户会以为第二区域没建好)", () => {
    expect(() => normalizeExecTargets({ items: [] })).toThrow(/形状异常/);
    expect(() => normalizeExecTargets(null)).toThrow(/形状异常/);
    expect(() => normalizeExecTargets("x")).toThrow(/形状异常/);
  });
});

describe("🔴 接线守卫:/api/exec-targets 只许在 exec-targets-client.ts 里 fetch", () => {
  it("app/ 与 components/ 下无人再直接 fetch 这条路由;四个消费者都经 fetchExecTargets", () => {
    const files = [...walk(resolve(SRC, "app")), ...walk(resolve(SRC, "components")), ...walk(resolve(SRC, "lib"))];
    const offenders = files
      .filter((fp) => !fp.endsWith("exec-targets-client.ts") && !fp.includes("/app/api/"))
      .filter((fp) => /fetch\(\s*[`"']\/api\/exec-targets/.test(strip(readFileSync(fp, "utf8"))))
      .map((fp) => fp.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
    for (const rel of CONSUMERS) {
      expect(strip(readFileSync(resolve(SRC, rel), "utf8")), rel).toContain("fetchExecTargets(");
    }
  });

  // @kf-batch 50-B109-exec-target-dims
  // 🔴 「经 fetchExecTargets 调」还不够:传的维度路由不认 ⇒ 400 被页面吞成空列表(B-109:编排页 "airflow" /
  //   建表向导 "core" 坏了一个月,本守卫当时全绿)。门禁写成「枚举违规写法」就漏第 N+1 种 ⇒ 改钉唯一合法形态:
  //   每个调用点实参里的**每个字符串字面** ∈ 闭合清单(类型层 tsc 也会红;这里再钉一遍,防 `as any` / 模板串绕过),
  //   而且实参必须含字面(全动态表达式让人读不出传了什么维度)。
  it("🔴 B-109:每个调用点传的维度字面 ∈ EXEC_TARGET_COMPONENT_DIMS(路由同一份清单)", () => {
    const files = [...walk(resolve(SRC, "app")), ...walk(resolve(SRC, "components")), ...walk(resolve(SRC, "lib"))].filter(
      (fp) => !fp.endsWith("exec-targets-client.ts") && !fp.endsWith("exec-targets-dims.ts")
    );
    const seen: string[] = [];
    for (const fp of files) {
      const src = strip(readFileSync(fp, "utf8"));
      for (const m of src.matchAll(/fetchExecTargets\(([^)]*)\)/g)) {
        const rel = fp.slice(SRC.length + 1);
        seen.push(rel);
        const lits = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
        expect(lits.length, `${rel}: ${m[0]} 实参必须用字符串字面传维度`).toBeGreaterThan(0);
        for (const lit of lits) expect(EXEC_TARGET_COMPONENT_DIMS as readonly string[], `${rel}: ${m[0]}`).toContain(lit);
      }
    }
    // 消费者名单也是棘轮:B-109 当时漏掉了编排页与建表向导,这两处今后必须在
    for (const rel of CONSUMERS) expect(seen, `${rel} 必须经 fetchExecTargets 取清单`).toContain(rel);
  });
});
