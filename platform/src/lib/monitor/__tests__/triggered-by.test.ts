// run 行 triggeredBy 的闭合清单 / 文案唯一作者 + 监控页接线。
// 钉事实:① 清单闭合且覆盖所有写 run 行处用到的字面量(源码扫描棘轮,与同一教训:清单的测试不能手抄);
//        ② backfill 的文案是「补数」不是「手动」;未知值原值照出;③ 监控页「触发」列与「触发方式」筛选都从这一张表取,
//        老的 `v === "schedule" ? 自动 : 手动` 三目已不存在(写了 ≠ 接上了)。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TRIGGERED_BY_VALUES, triggeredByMeta, TRIGGERED_BY_FILTER_OPTIONS, isTriggeredBy } from "../triggered-by";
import { COPILOT_TRIGGERED_BY } from "@/lib/copilot/plan/types";

const SRC = join(__dirname, "..", "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "__tests__" || name === "node_modules") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

function stripped(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8")
    .replace(/^\s*import[\s\S]*?;\s*$/gm, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("{/*"))
    .join("\n");
}

describe("triggeredBy 闭合清单(源码字面量棘轮)", () => {
  it("lib/ 与 app/api/ 里每一处 `triggeredBy: \"x\"` / `triggeredBy === \"x\"` 的字面量都已登记", () => {
    const files = [...walk(join(SRC, "lib")), ...walk(join(SRC, "app", "api"))];
    const seen = new Map<string, string>();
    for (const f of files) {
      const code = readFileSync(f, "utf8").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
      for (const m of code.matchAll(/triggeredBy\s*(?::|===|!==)\s*"([a-zA-Z-]+)"/g)) {
        // 🔴 同名字段的另一个命名空间:驻留审计记录 `residencyAudit({ …, triggeredBy })`(lib/exec-env/residency-audit.ts,自由字串,
        //    值如 genbi-card-save / genbi-card-refresh)不是 run 行 ⇒ 该调用还没闭合时出现的字面量不计
        const before = code.slice(Math.max(0, (m.index ?? 0) - 600), m.index);
        const opener = Math.max(before.lastIndexOf("residencyAudit({"), before.lastIndexOf("scheduledResidencyAudit({"));
        if (opener >= 0 && !before.slice(opener).includes("})")) continue;
        seen.set(m[1], f.replace(SRC, ""));
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(3); // 扫描器本身在工作(至少 manual / backfill / schedule)
    const unregistered = Array.from(seen.entries()).filter(([v]) => !isTriggeredBy(v));
    expect(unregistered, `未登记的 triggeredBy 字面量:${JSON.stringify(unregistered)}`).toEqual([]);
    expect(TRIGGERED_BY_VALUES).toContain(COPILOT_TRIGGERED_BY);
  });
});

describe("文案", () => {
  it("backfill ⇒「补数」(不是「手动」);schedule ⇒ 自动;dryrun ⇒ 试运行;rerun ⇒ 重跑;copilot ⇒ Copilot", () => {
    expect(triggeredByMeta("backfill")).toEqual({ label: "补数", color: "gold" });
    expect(triggeredByMeta("schedule").label).toBe("自动");
    expect(triggeredByMeta("manual").label).toBe("手动");
    expect(triggeredByMeta("dryrun").label).toBe("试运行");
    expect(triggeredByMeta("rerun").label).toBe("重跑");
    expect(triggeredByMeta(COPILOT_TRIGGERED_BY).label).toBe("Copilot");
  });
  it("🔴 未知值原值照出、空值「-」—— 不冒称「手动」", () => {
    expect(triggeredByMeta("retry-xyz")).toEqual({ label: "retry-xyz" });
    expect(triggeredByMeta("")).toEqual({ label: "-" });
    expect(triggeredByMeta(undefined)).toEqual({ label: "-" });
  });
  it("筛选下拉选项 = 清单逐项(含补数),label 与列文案同源", () => {
    expect(TRIGGERED_BY_FILTER_OPTIONS.map((o) => o.value)).toEqual([...TRIGGERED_BY_VALUES]);
    expect(TRIGGERED_BY_FILTER_OPTIONS.find((o) => o.value === "backfill")?.label).toBe("补数");
  });
});

describe("监控页接线(写了 ≠ 接上了)", () => {
  it("「触发」列用 triggeredByMeta、「触发方式」筛选用 TRIGGERED_BY_FILTER_OPTIONS;老三目已删", () => {
    const page = stripped("app/monitor/page.tsx");
    expect(page).toContain("const m = triggeredByMeta(v)");
    expect(page).toContain('data-testid="run-trigger" data-trigger={v || ""}');
    expect(page).toContain("options={TRIGGERED_BY_FILTER_OPTIONS.map((o) => ({ label: t(o.label), value: o.value }))}");
    expect(page).not.toMatch(/v === "schedule" \? <Tag/);
    expect(page).not.toContain('{ label: t("自动"), value: "schedule" }, { label: t("手动"), value: "manual" }');
  });
});
