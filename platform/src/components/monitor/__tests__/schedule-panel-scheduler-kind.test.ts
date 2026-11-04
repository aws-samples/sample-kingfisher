// 序 38 B-72 —— 调度配置页「这个区还没有 Airflow 环境」只许在**真没装**时出现(接线判据,钉源码接缝)。
//
// 【缺陷原形(2026-10-13 客户生产环境)】条件原来是 `!mwaaLoginUrl`:装的是 airflow-serverless 的区本来就没有 Web 控制台
//   (/api/workflow/airflow 回 409 WORKFLOW_SCHEDULER_UNSUPPORTED),于是被误报成「没有 Airflow」,而执行环境页明明列着它已安装。
// 【规则】应答分三态:有登录 URL = 经典 MWAA(按钮);409 WORKFLOW_SCHEDULER_UNSUPPORTED = serverless(中性说明);
//   409 SCHEDULER_NOT_INSTALLED / MWAA_NOT_INSTALLED = 真没装(告警);其它 = unknown(不断言)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "..", "SchedulePanel.tsx"), "utf8");
const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("{/*")).join("\n");

describe("B-72 SchedulePanel 调度器三态", () => {
  it("应答按 error.code 分态:serverless / missing / mwaa(有 loginUrl)", () => {
    expect(code).toContain('code === "WORKFLOW_SCHEDULER_UNSUPPORTED"');
    expect(code).toMatch(/setSchedulerKind\("serverless"\)/);
    expect(code).toContain('code === "SCHEDULER_NOT_INSTALLED" || code === "MWAA_NOT_INSTALLED"');
    expect(code).toMatch(/setSchedulerKind\("missing"\)/);
    expect(code).toMatch(/setSchedulerKind\("mwaa"\)/);
  });
  it("「还没有 Airflow 环境」告警只挂在 missing 态上;serverless 态给的是中性说明(自己的 testid)", () => {
    const warn = code.indexOf('data-testid="airflow-not-installed"');
    expect(warn).toBeGreaterThan(0);
    const before = code.slice(Math.max(0, warn - 400), warn);
    expect(before).toMatch(/schedulerKind === "missing" && airflowTargetId && \(/);
    expect(before).not.toMatch(/!mwaaLoginUrl && airflowTargetId && \(\s*$/);
    expect(code).toContain('data-testid="airflow-serverless-no-ui"');
    const sv = code.indexOf('data-testid="airflow-serverless-no-ui"');
    expect(code.slice(Math.max(0, sv - 400), sv)).toMatch(/schedulerKind === "serverless" && airflowTargetId && \(/);
  });
  it("切区先清空上一个区的结论(不留别区的按钮 / 结论)", () => {
    expect(code).toMatch(/setSchedulerKind\("unknown"\); setMwaaUrl\(""\); setMwaaLoginUrl\(""\); setMwaaRegion\(""\);/);
  });
  it("原来那条「只看有没有登录 URL」的告警条件不许回来", () => {
    expect(code).not.toMatch(/\{!mwaaLoginUrl && airflowTargetId && \(/);
  });
});
