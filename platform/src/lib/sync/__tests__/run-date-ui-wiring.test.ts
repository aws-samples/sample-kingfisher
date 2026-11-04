// @kf-batch 37-sync-backfill —— 序 37 ⑥⑦ 界面接线判据(写了 ≠ 接上了):查**调用位置**(剥掉 import 行再看),不查 token 出现过。
// 行为判据在 start-route-baseline.test.ts(路由)与 lib/backfill/__tests__/sync-task-assembly.test.ts(补数整链);
// 这里只钉三件界面侧的结构事实:
//   ① 「指定业务日期运行」弹窗真的把日期放进请求体发给 start 路由;列表页、详情页都挂上了它;
//   ② 原来的「启动」按钮、监控页「重新触发」仍然**不带请求体**(= 改动前的行为);
//   ③ 补数页显式要同步任务(include=sync-task),补不了的选项置灰。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..", "..");
function code(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8")
    .replace(/^\s*import[\s\S]*?;\s*$/gm, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("{/*"))
    .join("\n");
}

describe("序 37 ⑥ 指定业务日期运行:界面接线", () => {
  it("① 弹窗把所选日期作为 runDate 放进请求体,POST 到该任务的 start 路由", () => {
    const m = code("components/sync/RunWithDateModal.tsx");
    expect(m).toContain("fetch(`/api/sync/${task.taskId}/start`, {");
    expect(m).toContain('body: JSON.stringify({ runDate: date.format("YYYY-MM-DD") })');
  });
  it("① 列表页:操作列有入口、页面挂了弹窗", () => {
    const p = code("app/sync/page.tsx");
    expect(p).toContain("onClick={() => setRunDateTask(record)}");
    expect(p).toMatch(/<RunWithDateModal task=\{runDateTask\} open=\{!!runDateTask\}/);
  });
  it("① 详情页:按钮打开弹窗、页面挂了弹窗", () => {
    const p = code("app/sync/[id]/page.tsx");
    expect(p).toContain("onClick={() => setRunDateOpen(true)}");
    expect(p).toMatch(/<RunWithDateModal task=\{task\} open=\{runDateOpen\}/);
  });
  it("② 原来的启动 / 重新触发仍然不带请求体(改动前的行为)", () => {
    expect(code("app/sync/page.tsx")).toContain("fetch(`/api/sync/${id}/${path}`, { method: \"POST\" })");
    expect(code("app/sync/[id]/page.tsx")).toContain("fetch(`/api/sync/${id}/${action}`, { method: \"POST\" })");
    expect(code("app/monitor/page.tsx")).toContain("fetch(url, { method: \"POST\" })");
  });
});

describe("序 37 ⑦ 补数页:界面接线", () => {
  it("③ 拉目标时显式要同步任务;补不了的选项置灰", () => {
    const p = code("app/backfill/page.tsx");
    expect(p).toContain('tq.set("include", "sync-task");');
    expect(p).toContain("fetch(`/api/backfill/targets?${tq.toString()}`)");
    expect(p).toContain("disabled: !!x.unavailableReason,");
  });
  it("③ SLA 面板仍然不要同步任务(它没有为同步任务定 SLA 的语义,不顺带改它)", () => {
    expect(code("components/alerting/SlaPanel.tsx")).not.toContain("sync-task");
  });
});
