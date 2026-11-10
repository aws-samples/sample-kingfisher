// 离线计算「运行历史」表的列定义(源码字面判据;页面驱动段在 1600 宽视口量真实列宽):
//   2026-11-03 客户 1600 宽截图:固定列合计 ~1060 + 操作 230 把两个自适应列「开始 / 错误」挤成 0–35px(时间戳一字一行竖排、错误列不可见)。
//   修 = 表格 scroll.x(窄视口横向滚动而不是压缩)+「开始」定宽;「错误」保持自适应 + ellipsis,拿剩余宽度。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const page = fs.readFileSync(path.join(process.cwd(), "src/app/etl-jobs/page.tsx"), "utf8");
const table = (() => {
  const i = page.indexOf('data-testid="etl-run-history-table"');
  expect(i, "运行历史表要有 testid 让页面驱动段锚定").toBeGreaterThan(0);
  const start = page.lastIndexOf("<Table", i);
  const end = page.indexOf("]} />", i);
  return page.slice(start, end);
})();

describe("离线计算运行历史表:窄视口不压缩自适应列", () => {
  it("表格带 scroll.x(≥ 1400)", () => {
    const m = /scroll=\{\{ x: (\d+) \}\}/.exec(table);
    expect(m, "缺 scroll.x ⇒ 1600 宽下自适应列被挤成 0").not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(1400);
  });
  it("「开始」列定宽 ≥ 150;「错误」列仍自适应(无 width)且 ellipsis", () => {
    const started = /\{ title: t\("开始"\), dataIndex: "startedAt", width: (\d+)/.exec(table);
    expect(started).not.toBeNull();
    expect(Number(started![1])).toBeGreaterThanOrEqual(150);
    const error = /\{ title: t\("错误"\), dataIndex: "error", ([^}]*)\}/.exec(table);
    expect(error).not.toBeNull();
    expect(error![1]).toContain("ellipsis: true");
    expect(error![1], "错误列拿剩余宽度,不定宽").not.toMatch(/width:/);
  });
  it("固定列宽合计不超过 scroll.x 减去「开始」与一个最小错误列宽(保证两列各 ≥ 110px)", () => {
    const widths = [...table.matchAll(/width: (\d+)/g)].map((m) => Number(m[1]));
    const scrollX = Number(/scroll=\{\{ x: (\d+) \}\}/.exec(table)![1]);
    const sum = widths.reduce((a, b) => a + b, 0); // 含「开始」
    expect(scrollX - sum, "错误列在 scroll.x 下至少 110px").toBeGreaterThanOrEqual(110);
  });
});
