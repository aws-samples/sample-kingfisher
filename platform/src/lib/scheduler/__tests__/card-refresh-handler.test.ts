// (问数 · CAP-GENBI)
// 🔴 卡片定时刷新的执行体:三道重验在**刷新之前**,任一不过 ⇒ 失败且一次都不刷;
//    通过 ⇒ 以服务身份 + 作者 sub 调唯一作者 refreshCardOnce(与「立即刷新」同一个函数)。
// 另含接线判据:路由 / 删卡顺序 / 页面入口 / 调度中心。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  authorOk: vi.fn(),
  cardOk: vi.fn(),
  order: [] as string[],
}));
vi.mock("@/lib/genbi/cards-refresh", () => ({
  refreshCardOnce: async (...a: any[]) => { h.order.push("refresh"); return h.refresh(...a); },
  cardScheduleTaskId: (id: string) => `gcard_${id}`,
}));
vi.mock("@/lib/genbi/cards-schedule", () => ({
  assertCardAuthorStillAuthorized: async (...a: any[]) => { h.order.push("author"); return h.authorOk(...a); },
  assertCardStillSchedulable: async (...a: any[]) => { h.order.push("card"); return h.cardOk(...a); },
}));
vi.mock("@/lib/audit", () => ({ writeAuditRecord: vi.fn(async () => "id") }));

import { cardRefreshHandler } from "@/lib/scheduler/action-handlers";
import type { ExecutableCommand } from "@/lib/scheduler/action-dispatch";

const CARD = "01CARD000000000000000000AA";
const cmd = (over: Partial<ExecutableCommand> = {}): ExecutableCommand => ({
  commandId: "c1", action: "genbi.card-refresh", targetId: "tgt_usw2_a", projectId: "proj-x",
  params: { cardId: CARD, ownerSub: "sub-1", ownerUsername: "u1" }, runId: "r1", taskId: `gcard_${CARD}`,
  requestedAt: "t", status: "running", ...over,
});

beforeEach(() => {
  h.refresh.mockReset(); h.authorOk.mockReset(); h.cardOk.mockReset(); h.order.length = 0;
  h.refresh.mockResolvedValue({ cardId: CARD, snapshotId: "s1", rowCount: 3, turnIndex: 0, refreshedAt: "t" });
});

describe("卡片定时刷新执行体", () => {
  it("重验在前、刷新在后;以服务身份替作者执行;摘要只含非数据值", async () => {
    const out = await cardRefreshHandler(cmd());
    expect(h.order).toEqual(["author", "card", "refresh"]);
    expect(h.authorOk).toHaveBeenCalledWith("u1", "sub-1", "proj-x");
    expect(h.cardOk).toHaveBeenCalledWith("sub-1", CARD, "tgt_usw2_a", "proj-x");
    expect(h.refresh).toHaveBeenCalledWith("sub-1", CARD, { triggeredBy: "schedule", actor: { kind: "schedule", authorSub: "sub-1" } });
    expect(out).toEqual({ cardId: CARD, snapshotId: "s1", rowCount: 3, turnIndex: 0, refreshedAt: "t" });
  });
  it("命令不是这张卡的调度对象发的 ⇒ 拒,一次都不刷", async () => {
    await expect(cardRefreshHandler(cmd({ taskId: "gov_x" }))).rejects.toThrow(/不是这张卡片的定时/);
    expect(h.order).toEqual([]);
  });
  it("作者重验不过 / 卡片不在原区 ⇒ 拒,一次都不刷", async () => {
    h.authorOk.mockRejectedValueOnce(new Error("已不是项目成员"));
    await expect(cardRefreshHandler(cmd())).rejects.toThrow("已不是项目成员");
    h.cardOk.mockRejectedValueOnce(new Error("卡片已改存到 tgt_home"));
    await expect(cardRefreshHandler(cmd())).rejects.toThrow("改存到");
    expect(h.order).not.toContain("refresh");
  });
});

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const code = (rel: string) =>
  readFileSync(resolve(SRC, rel), "utf8")
    .replace(/^\s*import[\s\S]*?;\s*$/gm, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
    .join("\n");

describe("卡片定时刷新的接线", () => {
  it("立即刷新路由:作者本人(查自己名下的指针)+ 卡片项目 viewer;调唯一作者 refreshCardOnce(manual + 用户身份)", () => {
    const r = code("app/api/genbi/cards/[cardId]/refresh/route.ts");
    expect(r.indexOf("getCardPointer(who.sub, params.cardId)")).toBeLessThan(r.indexOf("requireProject(req, \"viewer\", pointer.projectId)"));
    expect(r).toContain('triggeredBy: "manual"');
    expect(r).toContain('actor: { kind: "user", identity: pctx.identity }');
    expect(r).toContain("await refreshCardOnce(who.sub, params.cardId,");
  });
  it("定时配置路由用 POST(分析账号网关只放 GET/POST);启用必须给 cron;走 configureCardSchedule", () => {
    const r = code("app/api/genbi/cards/[cardId]/schedule/route.ts");
    expect(r).toContain("export async function POST");
    expect(r).not.toContain("export async function PUT");
    expect(r).toContain("body.enabled === true && !cron");
    expect(r).toContain("await configureCardSchedule(g.identity, params.cardId,");
  });
  it("删卡:先撤定时载体再删卡(顺序反了 = 那个区按 cron 刷一张不存在的卡)", () => {
    const r = code("app/api/genbi/cards/[cardId]/route.ts");
    const del = r.slice(r.indexOf("export async function DELETE"));
    expect(del.indexOf("await removeCardSchedule(params.cardId)")).toBeGreaterThan(-1);
    expect(del.indexOf("await removeCardSchedule(params.cardId)")).toBeLessThan(del.indexOf("await deleteCard(who.sub, params.cardId)"));
  });
  it("我的卡片抽屉:立即刷新 / 定时刷新 / 历史 / 最近一次 四个入口齐;定时绿标看产物", () => {
    const c = code("components/genbi/SessionCards.tsx");
    for (const id of ["genbi-card-refresh-", "genbi-card-schedule-", "genbi-card-history-", "genbi-card-last-refresh-", "genbi-card-schedule-armed-"]) {
      expect(c, id).toContain(`data-testid={\`${id}\${c.cardId}\`}`);
    }
    expect(c).toContain('data-testid="genbi-card-schedule-modal"');
    expect(c).toContain('data-testid="genbi-card-history-modal"');
    expect(c).toContain("fetch(`/api/genbi/cards/schedules${qs}`)");
    expect(c).toContain("armedOf(scheds[c.cardId])");
  });
  it("调度中心:拉我的卡片定时(带范围);类型 Tag;未启用改 cron 走卡片自己的配置接口", () => {
    const p = code("components/monitor/SchedulePanel.tsx");
    expect(p).toContain("fetch(`/api/genbi/cards/schedules${actionQs}`)");
    expect(p).toContain('data-testid="schedule-type-genbi-card"');
    expect(p).toContain("fetch(`/api/genbi/cards/${item.cardId}/schedule`");
  });
  it("驻留:服务身份跳过同意只在 residency-audit.ts 里,且先按作者 sub 校验同意", () => {
    const ra = code("lib/exec-env/residency-audit.ts");
    const fn = ra.slice(ra.indexOf("export async function scheduledResidencyAudit"));
    expect(fn.indexOf("await requireResidencyAck(systemIdentity(input.onBehalfOfSub), input.targetId)")).toBeGreaterThan(-1);
    expect(fn.indexOf("await requireResidencyAck(")).toBeLessThan(fn.indexOf("skipAck: true"));
  });
});
