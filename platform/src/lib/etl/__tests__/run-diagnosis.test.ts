/**
 * 「云侧还没给算力」的判定 —— **行为**判据。
 * 变异对照:去掉 `stillRunning` 这一半 ⇒ ③ 红;把 starvation 文本改错一个字 ⇒ ① 红;
 * 把 `isStillRunning` 的词表砍掉 queued/scheduled ⇒ ④ 红。
 */
import { describe, it, expect } from "vitest";
import { diagnoseRunLogs, isStillRunning, CAPACITY_QUEUED_ADVICE } from "@/lib/etl/run-diagnosis";

const STARVE = [
  "2026-09-16T05:20:21,903 WARN org.apache.spark.scheduler.TaskSchedulerImpl [task-starvation-timer]",
  "Initial job has not accepted any resources; check your cluster UI to ensure that workers are registered and have sufficient resources",
];

describe("🔴 云侧算力排队要被认出来并说清出路", () => {
  it("① 仍在运行 + 日志里有 Spark starvation ⇒ capacity-queued,文案里有「排队」与出路", () => {
    const d = diagnoseRunLogs(STARVE, true);
    expect(d.kind).toBe("capacity-queued");
    expect(d.advice).toBe(CAPACITY_QUEUED_ADVICE);
    // 🔴 三件事必须在文案里分开:不是作业错、不是平台坏、有出路
    expect(d.advice).toContain("排队");
    expect(d.advice).toMatch(/不是作业本身出错/);
    expect(d.advice).toMatch(/不是平台故障/);
    expect(d.advice).toMatch(/重跑|继续等/);
  });

  it("② 普通日志 ⇒ none(不许把任何失败都说成「云侧没给资源」)", () => {
    expect(diagnoseRunLogs(["py4j error: table not found", "AnalysisException"], true).kind).toBe("none");
    expect(diagnoseRunLogs([], true).kind).toBe("none");
  });

  it("③ 🔴 已终态就不许再说「在排队」(跑完了才看到那句历史告警是正常的)", () => {
    expect(diagnoseRunLogs(STARVE, false).kind).toBe("none");
    expect(diagnoseRunLogs(STARVE, false).advice).toBe("");
  });

  it("④ isStillRunning 认全三套引擎的在途词表,终态一律 false", () => {
    for (const s of ["RUNNING", "Starting", "waiting", "QUEUED", "SCHEDULED", "SUBMITTED", "PENDING", "started"]) {
      expect(isStillRunning(s), s).toBe(true);
    }
    for (const s of ["SUCCEEDED", "succeeded", "FAILED", "STOPPED", "ABORTED", "", undefined, null]) {
      expect(isStillRunning(s as string), String(s)).toBe(false);
    }
  });
});

// 接线层:日志路由必须把结论放到**第一行**(两个页面的弹窗都直接渲染 logs)
describe("🔴 接线:ETL 日志路由把结论顶到第一行并回结构化字段", () => {
  it("路由走单一作者、结论 unshift 到最前、响应带 diagnosis", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const src = fs.readFileSync(new URL("../../../app/api/etl-jobs/[id]/logs/route.ts", import.meta.url), "utf8");
    expect(src).toContain("diagnoseRunLogs(");
    expect(src).toContain("isStillRunning(status)");
    expect(src).toMatch(/lines\.unshift\(diag\.advice/);
    expect(src).toMatch(/diagnosis: diag/);
    // 🔴 反例:不许自己再写一遍那句 Spark 文本(第二处判定 = 迟早只改一处)
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
    expect(stripped).not.toContain("has not accepted any resources");
  });

  it("🔴 引擎(EMR Serverless)那条日志路径也接上了同一个作者 —— 它跑的也是 Spark", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const src = fs.readFileSync(new URL("../../../app/api/engines/[engine]/[id]/logs/route.ts", import.meta.url), "utf8");
    expect(src).toContain("diagnoseRunLogs(");
    expect(src).toMatch(/text\.unshift\(diag\.advice/);
    expect(src).toMatch(/diagnosis: diag/);
  });

  it("🔴 闭合式:凡是**读引擎日志**的路由都必须接上诊断(新增一条日志路径漏接就红)", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const root = new URL("../../../app/api", import.meta.url).pathname;
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => {
        const p = path.join(d, x.name);
        return x.isDirectory() ? walk(p) : p.endsWith("route.ts") ? [p] : [];
      });
    const logRoutes = walk(root).filter((f) => /\/logs\/route\.ts$/.test(f));
    expect(logRoutes.length, "一条读日志的路由都没找到 ⇒ 这道门在空转").toBeGreaterThanOrEqual(3);
    // 只要求「真的从引擎/CloudWatch 取行」的那些接上(纯转发的 monitor 路由靠被转发方拿到结论)
    const missing = logRoutes.filter((f) => {
      const src = fs.readFileSync(f, "utf8");
      const fetchesLines = /fetchLogStream\(|readLogs\(/.test(src);
      return fetchesLines && !src.includes("diagnoseRunLogs(");
    });
    expect(missing.map((f) => path.relative(root, f)), "这些日志路由没接诊断 ⇒ 用户又只能看到一个「运行中」").toEqual([]);
  });
});
