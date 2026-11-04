// 「选中项的状态从刷新后的列表现查,不读陈旧副本」的判据 + 单一作者闭合。
//
// 🔴 起因(2026-09-19 无头验收):`/etl-jobs` 点「发布到 MWAA 调度」成功后,卡片上的 `⏱ cron`
//   变了,而同一屏右侧面板里「触发一次调度 / 下线调度」始终不出现 —— 面板读的是选中时拷的快照。
//   同一个事实在同一屏上两个说法,用户以为发布没成功(而它其实成功了)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { liveRowOf } from "@/lib/scope/live-row";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

describe("liveRowOf", () => {
  const stale = { jobId: "J1", scheduleEnabled: false, cronExpression: "" };
  const fresh = { jobId: "J1", scheduleEnabled: true, cronExpression: "0 3 * * *" };

  it("列表里有同 id 的新版 ⇒ 用新版(陈旧副本的状态不算)", () => {
    expect(liveRowOf([fresh], stale, "jobId")).toBe(fresh);
    expect(liveRowOf([fresh], stale, "jobId")?.scheduleEnabled).toBe(true);
  });
  it("列表还没回来 / 里面没有它 ⇒ 退回副本(不许变成 null 把面板整片闪掉)", () => {
    expect(liveRowOf(null, stale, "jobId")).toBe(stale);
    expect(liveRowOf([], stale, "jobId")).toBe(stale);
    expect(liveRowOf([{ jobId: "OTHER" } as any], stale, "jobId")).toBe(stale);
  });
  it("没选中 ⇒ null", () => {
    expect(liveRowOf([fresh], null, "jobId")).toBe(null);
  });
  it("副本没有 id(异常数据)⇒ 退回副本,不误配到列表首项", () => {
    const noId = { jobId: "", scheduleEnabled: false };
    expect(liveRowOf([fresh], noId as any, "jobId")).toBe(noId);
  });
});

describe("🔴 单一作者闭合:调度类按钮的显隐不许读陈旧副本", () => {
  it("/etl-jobs 用 selLive / selEmrLive,且不再有裸 sel.scheduleEnabled", () => {
    const body = read("app/etl-jobs/page.tsx");
    expect(body).toContain('liveRowOf(jobs, sel, "jobId")');
    expect(body).toContain('liveRowOf(emrJobs, selEmr, "jobId")');
    expect(body).toContain("selLive?.scheduleEnabled");
    // 裸读陈旧副本的形状:出现即复发
    expect(body).not.toContain("{sel.scheduleEnabled &&");
    expect(body).not.toContain("job={selEmr}\n");
  });
});
