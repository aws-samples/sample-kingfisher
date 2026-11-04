// @kf-batch 50-WP28-platform-action-node(WP-29 治理)
// 🔴🔴 治理三类定时动作的执行体:只调产品库函数(与手动按钮同一个作者),而「没真干活」一律判失败。
//   · 质量检查:落点 / 项目 / 区限定 fqn 都从命令来;该区没数仓 ⇒ 失败;某张表规则全部执行出错 ⇒ 失败;
//   · 敏感扫描:没扫到任何表(过滤写错)⇒ 失败;全部抽样失败 ⇒ 失败;
//   · 目录同步:点名的来源有一个失败 / 没结果 ⇒ 失败;推进 OM 整体失败 ⇒ 失败;数仓采集器由执行体注入(带命令的项目)。
// mock 只替换**别的目录**的库函数(真外部:数仓 / Glue / OM 都在它们后面),本目录兄弟模块一律不 mock。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  runChecks: vi.fn(),
  runSensitiveScan: vi.fn(),
  mirrorMetadata: vi.fn(),
  warehousePuller: vi.fn((pid: string) => ({ __puller: pid })),
  audits: [] as any[],
}));
vi.mock("@/lib/quality/service", () => ({ runChecks: h.runChecks }));
vi.mock("@/lib/governance/sensitive/scan", () => ({ runSensitiveScan: h.runSensitiveScan }));
vi.mock("@/lib/exec-env/metadata-mirror", () => ({ mirrorMetadata: h.mirrorMetadata }));
vi.mock("@/lib/exec-env/metadata-mirror-warehouse", () => ({ warehousePuller: h.warehousePuller }));
vi.mock("@/lib/audit", () => ({ writeAuditRecord: vi.fn(async (_a: any, action: string, opts: any) => { h.audits.push({ action, opts }); return "id"; }) }));

import { qualityCheckHandler, sensitiveScanHandler, catalogSyncHandler } from "@/lib/scheduler/action-handlers";
import type { ExecutableCommand } from "@/lib/scheduler/action-dispatch";

const cmd = (action: string, params: Record<string, unknown>, targetId = "tgt_usw2_a"): ExecutableCommand => ({
  commandId: "c1", action, targetId, projectId: "proj-x", params, runId: "r1", taskId: "gov_1",
  requestedAt: "2026-10-10T00:00:00Z", status: "running",
});

beforeEach(() => {
  h.runChecks.mockReset(); h.runSensitiveScan.mockReset(); h.mirrorMetadata.mockReset(); h.audits.length = 0;
});

describe("质量检查执行体", () => {
  it("落点 / 项目 / 区限定的 fqn 都从命令来;成功回逐表摘要并留审计(via=schedule)", async () => {
    h.runChecks.mockResolvedValue({ summary: { runId: "q1", score: 90, passed: 9, failed: 1, errors: 0, total: 10, slaBreached: false }, results: [] });
    const out = await qualityCheckHandler(cmd("governance.quality-check", { fqns: ["bgp-redshift.dev.public.orders"] }));
    const [key, scope] = h.runChecks.mock.calls[0];
    expect(key).toContain("tgt_usw2_a");              // 非 home 的键带区前缀(与手动路由同一个 scopedFqn)
    expect(key).toContain("bgp-redshift.dev.public.orders");
    expect(scope).toEqual({ targetId: "tgt_usw2_a", projectId: "proj-x" });
    expect(out).toMatchObject({ tables: [{ fqn: "bgp-redshift.dev.public.orders", score: 90 }] });
    expect(h.audits[0].action).toBe("quality.run");
    expect(h.audits[0].opts.detail.via).toBe("schedule");
    expect(h.audits[0].opts.targetId).toBe("tgt_usw2_a");
  });
  it("该区没数仓 ⇒ 失败(定时没有页面可降级,只能如实失败)", async () => {
    h.runChecks.mockResolvedValue({ capability: "unavailable", targetId: "tgt_usw2_a", missing: "redshift", reason: "该区没装数仓" });
    await expect(qualityCheckHandler(cmd("governance.quality-check", { fqns: ["a"] }))).rejects.toThrow(/没有可用的数仓/);
  });
  it("某张表的规则全部执行出错 ⇒ 失败(那张表根本没被检查到)", async () => {
    h.runChecks.mockResolvedValue({ summary: { runId: "q", score: null, passed: 0, failed: 0, errors: 3, total: 3, slaBreached: false }, results: [] });
    await expect(qualityCheckHandler(cmd("governance.quality-check", { fqns: ["a"] }))).rejects.toThrow(/全部执行失败/);
  });
  it("库函数自己抛(如该表没有启用规则)⇒ 原样失败", async () => {
    h.runChecks.mockRejectedValue(new Error("该表暂无启用的质量规则"));
    await expect(qualityCheckHandler(cmd("governance.quality-check", { fqns: ["a"] }))).rejects.toThrow("该表暂无启用的质量规则");
  });
});

describe("敏感扫描执行体", () => {
  const ok = { summary: { scanId: "s1", targetId: "tgt_usw2_a", database: "dev", tablesScanned: 3, tablesSkipped: 0, tablesErrored: 0, columnsScanned: 9, findingsHigh: 1, findingsMed: 0, ts: "t" }, findings: [], errors: [] };
  it("参数原样带下去、落点与项目从命令来、扫描者是系统主体", async () => {
    h.runSensitiveScan.mockResolvedValue(ok);
    const out = await sensitiveScanHandler(cmd("governance.sensitive-scan", { schema: "public", tables: ["public.users"] }));
    expect(h.runSensitiveScan.mock.calls[0][0]).toEqual({
      schema: "public", tables: ["public.users"], scannedBy: "system:action-dispatcher",
      scope: { targetId: "tgt_usw2_a", projectId: "proj-x" },
    });
    expect(out).toMatchObject({ scanId: "s1", tablesScanned: 3 });
    expect(h.audits[0].action).toBe("sensitive.scan");
  });
  it("没扫到任何表 ⇒ 失败;全部抽样失败 ⇒ 失败;该区没数仓 ⇒ 失败", async () => {
    h.runSensitiveScan.mockResolvedValue({ ...ok, summary: { ...ok.summary, tablesScanned: 0 } });
    await expect(sensitiveScanHandler(cmd("governance.sensitive-scan", { schema: "nope" }))).rejects.toThrow(/没有扫到任何表/);
    h.runSensitiveScan.mockResolvedValue({ ...ok, summary: { ...ok.summary, tablesErrored: 3 }, errors: [{ fqn: "x", error: "denied" }] });
    await expect(sensitiveScanHandler(cmd("governance.sensitive-scan", {}))).rejects.toThrow(/全部抽样失败/);
    h.runSensitiveScan.mockResolvedValue({ capability: "unavailable", targetId: "t", missing: "redshift", reason: "r" });
    await expect(sensitiveScanHandler(cmd("governance.sensitive-scan", {}))).rejects.toThrow(/没有可用的数仓/);
  });
});

describe("目录同步执行体", () => {
  const facet = (sources: any[]) => ({ targetId: "tgt_usw2_a", facet: { state: "fresh", tables: 5, sources }, sources: sources.map((s) => s.source), om: { tables: 5, services: [], truncated: false, errors: 0 } });
  it("只采点名的来源;数仓采集器由执行体注入且带命令的项目", async () => {
    h.mirrorMetadata.mockResolvedValue(facet([{ source: "glue", ok: true, tables: 5, columns: 9 }, { source: "redshift", ok: true, tables: 2, columns: 4 }]));
    const out = await catalogSyncHandler(cmd("governance.catalog-sync", { sources: ["glue", "redshift"] }));
    const [tid, opts] = h.mirrorMetadata.mock.calls[0];
    expect(tid).toBe("tgt_usw2_a");
    expect(opts.sources).toEqual(["glue", "redshift"]);
    expect(opts.pullers.redshift).toEqual({ __puller: "proj-x" });
    expect(out).toMatchObject({ sources: [{ source: "glue", tables: 5 }, { source: "redshift", tables: 2 }] });
  });
  it("点名的来源失败 / 没有结果 ⇒ 失败;推进 OM 整体失败 ⇒ 失败", async () => {
    h.mirrorMetadata.mockResolvedValue(facet([{ source: "glue", ok: false, error: "AccessDenied" }]));
    await expect(catalogSyncHandler(cmd("governance.catalog-sync", { sources: ["glue"] }))).rejects.toThrow(/AccessDenied/);
    h.mirrorMetadata.mockResolvedValue(facet([{ source: "glue", ok: true, tables: 1 }]));
    await expect(catalogSyncHandler(cmd("governance.catalog-sync", { sources: ["glue", "redshift"] }))).rejects.toThrow(/redshift: 本轮没有结果/);
    h.mirrorMetadata.mockResolvedValue({ ...facet([{ source: "glue", ok: true, tables: 1 }]), om: { tables: 0, services: [], truncated: false, errors: -1, error: "OM down" } });
    await expect(catalogSyncHandler(cmd("governance.catalog-sync", { sources: ["glue"] }))).rejects.toThrow(/OpenMetadata 整体失败/);
  });
});
