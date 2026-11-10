// 页面 / 组件里裸发 `fetch(…, { method: "DELETE" })` 的**棘轮**(只减不增)+ 已修四页必须经 `deleteJson`。
//
// 为什么是棘轮而不是一刀全禁:28 处里 23 处各自 `res.json()` 读信封(口径不一但不说假话),一次全改 = 二十几页回归面;
//   五处**完全不看响应就提示「已删除」**的(sync / datasources / etl-jobs 删作业 / redshift 删任务 / workflow)本批改掉。
//   名单显式写死:新页面不许再裸发 DELETE(加一处 ⇒ 这里红);迁一处就从名单删一行。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(p, out);
    } else if (/\.(tsx?|jsx?)$/.test(name)) out.push(p);
  }
  return out;
}

/** 裸发 DELETE 的调用点(含 authedFetch 包装;不含 deleteJson 自身)。 */
function rawDeleteFetches(file: string): number {
  const src = readFileSync(file, "utf8");
  const re = /\b(?:authedFetch|fetch)\([^;]*?method:\s*"DELETE"/g; // `[^;]` 本就含换行;再写 `|\n` 会指数回溯
  return (src.match(re) ?? []).length;
}

/** 2026-10-23 基线:仍各自读信封的调用点(路径 ⇒ 处数)。只许减少;加一处 = 新页面又裸发 DELETE。 */
const BASELINE: Record<string, number> = {
  "app/alerting/page.tsx": 2,
  "app/etl-jobs/page.tsx": 1, // 只剩「下线调度」的 schedule DELETE(它读了信封);删作业已改 deleteJson
  "app/metrics/page.tsx": 1,
  "app/modeling/page.tsx": 1,
  "app/projects/page.tsx": 2,
  "app/realtime-compute/page.tsx": 2,
  "app/knowledge/page.tsx": 1,
  "app/governance/page.tsx": 2,
  "app/skills/page.tsx": 1,
  "components/engines/EmrJobPanel.tsx": 1, // 只剩「下线调度」的 schedule DELETE(它读了信封);删作业已改 deleteJson(R7:409 JOB_IN_USE 原话要给用户看)
  "components/genbi/SessionCards.tsx": 1,
  "components/finops/BudgetTab.tsx": 1,
  "components/alerting/SlaPanel.tsx": 1,
  "components/copilot/RecipeLibrary.tsx": 1,
  "components/governance/GovernanceSchedules.tsx": 1,
  "components/settings/AiModelCard.tsx": 1,
  "components/bi/AnalysisWorkbench.tsx": 1,
};

/** 本批已修的五页:删除必须经 deleteJson,并且失败分支要把服务端原话呈现出来(message.error)。 */
const FIXED = ["app/sync/page.tsx", "app/datasources/page.tsx", "app/etl-jobs/page.tsx", "app/redshift/page.tsx", "app/workflow/page.tsx"];

describe("🔴 页面删除不许不看响应就提示「已删除」", () => {
  const files = [...walk(resolve(SRC, "app")), ...walk(resolve(SRC, "components"))];
  const found: Record<string, number> = {};
  for (const f of files) {
    const n = rawDeleteFetches(f);
    if (n > 0) found[relative(SRC, f)] = n;
  }

  it("裸发 DELETE 的调用点 ⊆ 基线名单且每处不多于基线(只减不增;新页面请用 lib/http/delete-json)", () => {
    const extra = Object.entries(found).filter(([k, n]) => !(k in BASELINE) || n > BASELINE[k]);
    expect(extra, `新增或变多的裸 DELETE 调用点:${JSON.stringify(extra)}`).toEqual([]);
  });
  it("基线里消失的条目要同步从名单删掉(名单不许比现实宽松)", () => {
    const stale = Object.keys(BASELINE).filter((k) => !(k in found));
    expect(stale, "这些文件已经不再裸发 DELETE,请从 BASELINE 删掉").toEqual([]);
  });
  it.each(FIXED)("%s:删除经 deleteJson,且 catch 里用 message.error 呈现服务端原话", (rel) => {
    const src = readFileSync(resolve(SRC, rel), "utf8");
    expect(src).toMatch(/import \{[^}]*\bdeleteJson\b[^}]*\} from "@\/lib\/http\/delete-json"/);
    expect(src).toMatch(/await deleteJson\(/);
    // 失败分支:catch 里(允许先有注释行)紧接 message.error((e as Error).message …)
    expect(src).toMatch(/catch \(e\) \{(?:\s*\/\/[^\n]*\n)*\s*message\.error\(\(e as Error\)\.message/);
  });
});
